/* Wi-Fi Map – importers: images, DXF (CAD / floor-plan apps), OBJ (LiDAR scans),
 * Apple RoomPlan JSON, and Google Static Maps satellite images (optional, online).
 */
(function () {
  'use strict';
  const WM = window.WM;
  const Imp = (WM.Import = {});

  Imp.readDataURL = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
  Imp.readText = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsText(file);
  });
  Imp.loadImage = (src) => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Could not load that image.'));
    img.src = src;
  });

  /** Downscale very large images so they fit in storage and stay fast. */
  Imp.imageFile = async function (file) {
    let src = await Imp.readDataURL(file);
    let img = await Imp.loadImage(src);
    let w = img.naturalWidth || 1000, h = img.naturalHeight || 1000;
    const max = 4000;
    if (w > max || h > max || file.size > 6e6) {
      const k = Math.min(1, max / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      src = c.toDataURL('image/jpeg', 0.88);
      w = c.width; h = c.height;
    }
    return { src, w, h };
  };

  /* ---------------- DXF ---------------- */
  Imp.dxf = function (text) {
    const lines = text.split(/\r?\n/);
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
    let insunits = 0;
    for (let i = 0; i < pairs.length - 1; i++)
      if (pairs[i][0] === 9 && pairs[i][1] === '$INSUNITS') { insunits = parseInt(pairs[i + 1][1], 10) || 0; break; }

    // Collect entities from the ENTITIES section.
    let i = 0;
    while (i < pairs.length - 1 && !(pairs[i][0] === 0 && pairs[i][1] === 'SECTION' && pairs[i + 1][1] === 'ENTITIES')) i++;
    const ents = [];
    let cur = null;
    for (i += 2; i < pairs.length; i++) {
      const [code, val] = pairs[i];
      if (code === 0) {
        if (val === 'ENDSEC') break;
        cur = { type: val, c: [] };
        ents.push(cur);
      } else if (cur) cur.c.push([code, val]);
    }
    const get = (e, code) => { const p = e.c.find((x) => x[0] === code); return p ? p[1] : undefined; };
    const raw = [];
    const pushPoly = (pts, closed, layer) => {
      for (let k = 0; k + 1 < pts.length; k++) raw.push({ s: [pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]], layer });
      if (closed && pts.length > 2) raw.push({ s: [pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1]], layer });
    };
    for (let k = 0; k < ents.length; k++) {
      const e = ents[k];
      const layer = get(e, 8) || '0';
      if (e.type === 'LINE') {
        raw.push({ s: [+get(e, 10), +get(e, 20), +get(e, 11), +get(e, 21)], layer });
      } else if (e.type === 'LWPOLYLINE') {
        const pts = [];
        let x = null;
        for (const [c, v] of e.c) {
          if (c === 10) x = +v;
          else if (c === 20 && x !== null) { pts.push([x, +v]); x = null; }
        }
        pushPoly(pts, (parseInt(get(e, 70) || '0', 10) & 1) === 1, layer);
      } else if (e.type === 'POLYLINE') {
        const pts = [];
        let j = k + 1;
        for (; j < ents.length && ents[j].type === 'VERTEX'; j++) pts.push([+get(ents[j], 10), +get(ents[j], 20)]);
        pushPoly(pts, (parseInt(get(e, 70) || '0', 10) & 1) === 1, layer);
        k = j;
      }
    }
    let segs = raw.filter((r) => r.s.every(Number.isFinite));
    const wallLayers = new Set(segs.map((r) => r.layer).filter((l) => /wall|mur|wand|muro|parede/i.test(l)));
    let note = '';
    if (wallLayers.size) {
      segs = segs.filter((r) => wallLayers.has(r.layer));
      note = 'Imported only wall layers: ' + [...wallLayers].join(', ') + '.';
    }
    if (!segs.length) throw new Error('No lines or polylines found in that DXF (blocks/INSERTs are not supported – explode them first).');
    const unitMap = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1 };
    let k = unitMap[insunits];
    if (!k) {
      const xs = segs.flatMap((r) => [r.s[0], r.s[2]]), ys = segs.flatMap((r) => [r.s[1], r.s[3]]);
      const ext = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      k = ext > 2000 ? 0.001 : ext > 200 ? 0.01 : 1;
      note += ` Units not set in file – assumed ${k === 1 ? 'metres' : k === 0.01 ? 'centimetres' : 'millimetres'}.`;
    }
    // DXF Y points up; flip it.
    return { segs: segs.map((r) => [r.s[0] * k, -r.s[1] * k, r.s[2] * k, -r.s[3] * k]), note: note.trim() };
  };

  /* ---------------- OBJ (LiDAR / 3D scan) ---------------- */
  Imp.obj = function (text, opts) {
    const unit = +opts.unit || 1;
    const V = [];
    const F = [];
    let pos = 0;
    const len = text.length;
    while (pos < len) {
      let end = text.indexOf('\n', pos);
      if (end < 0) end = len;
      const c0 = text.charCodeAt(pos), c1 = text.charCodeAt(pos + 1);
      if (c0 === 118 /* v */ && (c1 === 32 || c1 === 9)) {
        const p = text.slice(pos + 2, end).trim().split(/\s+/);
        V.push(+p[0] * unit, +p[1] * unit, +p[2] * unit);
      } else if (c0 === 102 /* f */ && (c1 === 32 || c1 === 9)) {
        const p = text.slice(pos + 2, end).trim().split(/\s+/);
        const nv = V.length / 3;
        const idx = p.map((t) => { const n = parseInt(t, 10); return n < 0 ? nv + n : n - 1; });
        for (let k = 1; k + 1 < idx.length; k++) F.push(idx[0], idx[k], idx[k + 1]);
      }
      pos = end + 1;
    }
    const nv = V.length / 3;
    if (!nv || !F.length) throw new Error('No mesh found in that OBJ file.');
    const ext = [0, 1, 2].map((a) => {
      let mn = Infinity, mx = -Infinity;
      for (let i = a; i < V.length; i += 3) { if (V[i] < mn) mn = V[i]; if (V[i] > mx) mx = V[i]; }
      return mx - mn;
    });
    let up = opts.up;
    if (up !== 'y' && up !== 'z') up = ext[1] <= ext[2] ? 'y' : 'z';
    const ua = up === 'y' ? 1 : 2;
    // Floor level = 2nd percentile of heights (robust against stray points).
    const sample = [];
    const stride = Math.max(1, Math.floor(nv / 50000));
    for (let i = 0; i < nv; i += stride) sample.push(V[i * 3 + ua]);
    sample.sort((a, b) => a - b);
    const floorH = sample[Math.floor(sample.length * 0.02)];
    const plane = floorH + (+opts.slice || 1.2);
    const px = (i) => V[i * 3];
    const py = (i) => (up === 'y' ? V[i * 3 + 2] : -V[i * 3 + 1]);
    const ph = (i) => V[i * 3 + ua] - plane;
    const segs = [];
    for (let t = 0; t < F.length; t += 3) {
      const a = F[t], b = F[t + 1], c = F[t + 2];
      if (a >= nv || b >= nv || c >= nv || a < 0 || b < 0 || c < 0) continue;
      const ha = ph(a), hb = ph(b), hc = ph(c);
      if ((ha > 0 && hb > 0 && hc > 0) || (ha < 0 && hb < 0 && hc < 0)) continue;
      const pts = [];
      const edge = (i, j, hi, hj) => {
        if ((hi < 0 && hj >= 0) || (hi >= 0 && hj < 0)) {
          const k = hi / (hi - hj);
          pts.push([px(i) + (px(j) - px(i)) * k, py(i) + (py(j) - py(i)) * k]);
        }
      };
      edge(a, b, ha, hb); edge(b, c, hb, hc); edge(c, a, hc, ha);
      if (pts.length >= 2) segs.push([pts[0][0], pts[0][1], pts[1][0], pts[1][1]]);
    }
    if (!segs.length) throw new Error('The slice height missed the walls. Try a different height or up-axis.');
    return { raw: segs, up, triangles: F.length / 3 };
  };

  /** Turn thousands of tiny mesh-slice segments into a few clean wall lines. */
  Imp.simplify = function (segs, o = {}) {
    const snap = o.snap || 0.03, tol = o.tol || 0.08, minLen = o.minLen || 0.3, mergeDist = o.mergeDist || 0.3;
    const nodes = new Map();
    const key = (x, y) => Math.round(x / snap) + ',' + Math.round(y / snap);
    const node = (x, y) => {
      const k = key(x, y);
      let n = nodes.get(k);
      if (!n) { n = { k, x, y, adj: new Set() }; nodes.set(k, n); }
      return n;
    };
    for (const s of segs) {
      const a = node(s[0], s[1]), b = node(s[2], s[3]);
      if (a === b) continue;
      a.adj.add(b.k); b.adj.add(a.k);
    }
    const used = new Set();
    const ek = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
    const chains = [];
    const walk = (start, nextK) => {
      const path = [start];
      let prev = start, cur = nodes.get(nextK);
      used.add(ek(start.k, cur.k));
      for (;;) {
        path.push(cur);
        if (cur.adj.size !== 2 || cur === start) break;
        let nxt = null;
        for (const k of cur.adj) if (k !== prev.k && !used.has(ek(cur.k, k))) { nxt = k; break; }
        if (!nxt) break;
        used.add(ek(cur.k, nxt));
        prev = cur; cur = nodes.get(nxt);
      }
      chains.push(path.map((n) => [n.x, n.y]));
    };
    for (const n of nodes.values()) if (n.adj.size !== 2) for (const k of n.adj) if (!used.has(ek(n.k, k))) walk(n, k);
    for (const n of nodes.values()) for (const k of n.adj) if (!used.has(ek(n.k, k))) walk(n, k);

    const dp = (pts) => {
      if (pts.length < 3) return pts;
      const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
      let md = -1, mi = 0;
      for (let i = 1; i < pts.length - 1; i++) {
        const d = WM.Geo.distToSeg(pts[i][0], pts[i][1], ax, ay, bx, by).d;
        if (d > md) { md = d; mi = i; }
      }
      if (md <= tol) return [pts[0], pts[pts.length - 1]];
      const l = dp(pts.slice(0, mi + 1)), r = dp(pts.slice(mi));
      return l.slice(0, -1).concat(r);
    };
    let out = [];
    for (const ch of chains) {
      const p = dp(ch);
      for (let i = 0; i + 1 < p.length; i++) {
        const s = [p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]];
        if (Math.hypot(s[2] - s[0], s[3] - s[1]) >= minLen) out.push(s);
      }
    }
    // Scans capture both faces of interior walls – keep only one of each parallel pair.
    out.sort((a, b) => Math.hypot(b[2] - b[0], b[3] - b[1]) - Math.hypot(a[2] - a[0], a[3] - a[1]));
    const kept = [];
    for (const s of out) {
      const ls = Math.hypot(s[2] - s[0], s[3] - s[1]);
      const ux = (s[2] - s[0]) / ls, uy = (s[3] - s[1]) / ls;
      const dup = kept.some((k) => {
        const lk = Math.hypot(k[2] - k[0], k[3] - k[1]);
        const kx = (k[2] - k[0]) / lk, ky = (k[3] - k[1]) / lk;
        if (Math.abs(ux * ky - uy * kx) > 0.17) return false; // ~10°
        const mx = (s[0] + s[2]) / 2, my = (s[1] + s[3]) / 2;
        const perp = Math.abs((mx - k[0]) * ky - (my - k[1]) * kx);
        if (perp > mergeDist) return false;
        const t0 = (s[0] - k[0]) * kx + (s[1] - k[1]) * ky, t1 = (s[2] - k[0]) * kx + (s[3] - k[1]) * ky;
        const overlap = Math.min(lk, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1));
        return overlap >= 0.6 * ls;
      });
      if (!dup) kept.push(s);
    }
    return kept;
  };

  /** Render segments to a plan image (used as the floor background). */
  Imp.segmentsToImage = function (segs, opts = {}) {
    const b = WM.Geo.bbox(segs.flatMap((s) => [[s[0], s[1]], [s[2], s[3]]]));
    const pad = 1;
    let ppm = opts.ppm || 50;
    const W = b.x1 - b.x0 + 2 * pad, H = b.y1 - b.y0 + 2 * pad;
    ppm = Math.min(ppm, 4000 / Math.max(W, H));
    const c = document.createElement('canvas');
    c.width = Math.ceil(W * ppm); c.height = Math.ceil(H * ppm);
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = '#334155'; g.lineWidth = Math.max(1, ppm * 0.04); g.lineCap = 'round';
    g.beginPath();
    for (const s of segs) {
      g.moveTo((s[0] - b.x0 + pad) * ppm, (s[1] - b.y0 + pad) * ppm);
      g.lineTo((s[2] - b.x0 + pad) * ppm, (s[3] - b.y0 + pad) * ppm);
    }
    g.stroke();
    return { src: c.toDataURL('image/png'), w: c.width, h: c.height, mpp: 1 / ppm, x: b.x0 - pad, y: b.y0 - pad };
  };

  /* ---------------- Apple RoomPlan (CapturedRoom JSON) ---------------- */
  Imp.roomplan = function (data) {
    const walls = [];
    const collect = (o) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o.walls)) walls.push(...o.walls);
      if (Array.isArray(o.rooms)) o.rooms.forEach(collect);
    };
    collect(data);
    const segs = [];
    for (const w of walls) {
      let d = w.dimensions;
      if (d && !Array.isArray(d)) d = [d.x, d.y, d.z];
      let T = w.transform;
      if (!d || !T) continue;
      if (Array.isArray(T[0])) T = T.flat();
      if (T.length !== 16) continue;
      const half = d[0] / 2;
      const cx = T[12], cz = T[14], ux = T[0], uz = T[2];
      segs.push([cx - ux * half, cz - uz * half, cx + ux * half, cz + uz * half]);
    }
    if (!segs.length) throw new Error('No RoomPlan walls found in that JSON.');
    return { segs };
  };

  /* ---------------- Google Maps (optional, needs internet + API key) ---------------- */
  Imp.parseLatLng = function (input) {
    const s = (input || '').trim();
    let m = s.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?)z)?/);
    if (m) return { lat: +m[1], lng: +m[2], zoom: m[3] ? Math.round(+m[3]) : null };
    m = s.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) return { lat: +m[1], lng: +m[2], zoom: null };
    return null;
  };

  Imp.googleStatic = async function ({ location, zoom, key }) {
    if (!navigator.onLine) throw new Error('You are offline. Use the screenshot method instead.');
    if (!key) throw new Error('A Google Maps API key is needed for direct download.');
    let ll = Imp.parseLatLng(location);
    if (!ll) {
      const gr = await fetch('https://maps.googleapis.com/maps/api/geocode/json?address=' + encodeURIComponent(location) + '&key=' + encodeURIComponent(key));
      const gj = await gr.json();
      if (!gj.results || !gj.results.length) throw new Error('Address not found (' + (gj.status || 'error') + '). Try "lat,lng" coordinates instead.');
      ll = { lat: gj.results[0].geometry.location.lat, lng: gj.results[0].geometry.location.lng, zoom: null };
    }
    const z = Math.max(15, Math.min(21, +zoom || ll.zoom || 20));
    const scale = 2, size = 640;
    const url = `https://maps.googleapis.com/maps/api/staticmap?center=${ll.lat},${ll.lng}&zoom=${z}&size=${size}x${size}&scale=${scale}&maptype=satellite&key=${encodeURIComponent(key)}`;
    // Web-Mercator metres per pixel at this latitude.
    const mpp = (156543.03392 * Math.cos((ll.lat * Math.PI) / 180)) / Math.pow(2, z) / scale;
    let src = url, offlineOk = false;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();
      if (!/^image\//.test(blob.type)) throw new Error('Not an image');
      src = await Imp.readDataURL(blob);
      offlineOk = true;
    } catch (e) {
      await Imp.loadImage(url); // throws if the key/url is bad
    }
    return { src, w: size * scale, h: size * scale, mpp, offlineOk };
  };
})();
