/* Wi-Fi Map – user interface: canvas editor, tools, panels and dialogs. */
(function () {
  'use strict';
  const WM = window.WM, Geo = WM.Geo, Imp = WM.Import;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = (v, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toString().replace('-', '−');
  const pct = (v) => Math.round(v * 100) + '%';

  const cv = $('#cv');
  const ctx = cv.getContext('2d');
  const stage = $('#stage');

  /* ================= state ================= */
  let P = WM.newProject();
  let cur = 0;
  let tool = 'select';
  let sel = null; // {kind, id, end?}
  const view = { x: 60, y: 60, z: 40 }; // screen = world * z + offset
  let heat = null, heatCanvas = null;
  const suggest = { router: [], aps: [], apType: 'mesh', result: null, routerResult: null, preview: true };
  let probe = null;
  let drawing = null;
  let hoverPt = null;
  const opts = { material: 'drywall', exterior: 'brick', deviceType: 'router' };
  const srcCache = new Map(); // background srcId -> data URL (kept out of undo snapshots)
  const imgCache = new Map();
  let dpr = 1, W = 0, H = 0;
  const floor = () => P.floors[cur];
  const S = () => P.settings;

  /* ================= persistence ================= */
  const DB = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((res, rej) => {
        const r = indexedDB.open('wifimap', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => { this.db = r.result; res(r.result); };
        r.onerror = () => rej(r.error);
      });
    },
    async get(k) {
      const db = await this.open();
      return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    },
    async set(k, v) {
      const db = await this.open();
      return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); });
    },
  };
  let saveTimer = null;
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 700); }
  async function save() {
    try { await DB.set('project', JSON.parse(JSON.stringify(P))); }
    catch (e) { try { localStorage.setItem('wifimap', JSON.stringify(P)); } catch (_) { /* storage full */ } }
  }
  async function loadSaved() {
    try { const p = await DB.get('project'); if (p) return p; } catch (e) { /* ignore */ }
    try { const s = localStorage.getItem('wifimap'); if (s) return JSON.parse(s); } catch (e) { /* ignore */ }
    return null;
  }
  function normalize(p) {
    const d = WM.newProject();
    p.settings = Object.assign(WM.defaultSettings(), p.settings || {});
    if (!Array.isArray(p.floors) || !p.floors.length) p.floors = d.floors;
    p.floors.forEach((f, i) => {
      f.id = f.id || WM.uid('f');
      f.name = f.name || 'Floor ' + (i + 1);
      f.walls = (f.walls || []).filter((w) => [w.x1, w.y1, w.x2, w.y2].every(Number.isFinite));
      f.walls.forEach((w) => { w.id = w.id || WM.uid('w'); w.material = WM.MATERIALS[w.material] ? w.material : 'drywall'; });
      f.zones = (f.zones || []).filter((z) => Array.isArray(z.pts) && z.pts.length >= 3);
      f.zones.forEach((z) => { z.id = z.id || WM.uid('z'); z.priority = z.priority ?? 1; });
      f.survey = f.survey || [];
      if (f.bg) {
        if (!f.bg.src) f.bg = null;
        else { f.bg.srcId = f.bg.srcId || WM.uid('b'); srcCache.set(f.bg.srcId, f.bg.src); }
      }
    });
    p.aps = (p.aps || []).filter((a) => Number.isFinite(a.x) && Number.isFinite(a.y));
    p.aps.forEach((a) => {
      a.id = a.id || WM.uid('d');
      a.type = WM.DEVICE_TYPES[a.type] ? a.type : 'ap';
      if (!p.floors.some((f) => f.id === a.floorId)) a.floorId = p.floors[0].id;
    });
    p.name = p.name || 'My home';
    return p;
  }

  /* ================= undo ================= */
  const undoStack = [], redoStack = [];
  const snapshot = () => JSON.stringify(P, (k, v) => (k === 'src' ? undefined : v));
  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > 80) undoStack.shift();
    redoStack.length = 0;
    updateUndoButtons();
  }
  function restore(json) {
    const p = JSON.parse(json);
    p.floors.forEach((f) => { if (f.bg) f.bg.src = srcCache.get(f.bg.srcId); });
    p.settings = P.settings;
    P = p;
    cur = clamp(cur, 0, P.floors.length - 1);
    sel = null;
    afterStructureChange();
  }
  function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); updateUndoButtons(); }
  function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); updateUndoButtons(); }
  function updateUndoButtons() { $('#btnUndo').disabled = !undoStack.length; $('#btnRedo').disabled = !redoStack.length; }

  /* ================= view ================= */
  const w2s = (x, y) => [x * view.z + view.x, y * view.z + view.y];
  const s2w = (x, y) => [(x - view.x) / view.z, (y - view.y) / view.z];
  function resize() {
    const r = stage.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = r.width; H = r.height;
    cv.width = Math.max(1, Math.round(W * dpr));
    cv.height = Math.max(1, Math.round(H * dpr));
    drawNow();
  }
  function contentBounds() {
    const f = floor();
    let b = WM.floorRegion(P, cur);
    const add = (o) => { if (!o) return; b = b ? { x0: Math.min(b.x0, o.x0), y0: Math.min(b.y0, o.y0), x1: Math.max(b.x1, o.x1), y1: Math.max(b.y1, o.y1) } : o; };
    for (const w of f.walls) add({ x0: Math.min(w.x1, w.x2), y0: Math.min(w.y1, w.y2), x1: Math.max(w.x1, w.x2), y1: Math.max(w.y1, w.y2) });
    if (f.bg) add({ x0: f.bg.x, y0: f.bg.y, x1: f.bg.x + f.bg.w * f.bg.mpp, y1: f.bg.y + f.bg.h * f.bg.mpp });
    return b || { x0: 0, y0: 0, x1: 12, y1: 10 };
  }
  function fit() {
    const b = contentBounds();
    const w = Math.max(1, b.x1 - b.x0), h = Math.max(1, b.y1 - b.y0);
    const topPad = 50, botPad = 50;
    view.z = clamp(Math.min(W / w, (H - topPad - botPad) / h) * 0.9, 2, 600);
    view.x = W / 2 - ((b.x0 + b.x1) / 2) * view.z;
    view.y = topPad + (H - topPad - botPad) / 2 - ((b.y0 + b.y1) / 2) * view.z;
    draw();
  }
  function zoomAt(sx, sy, f) {
    const [wx, wy] = s2w(sx, sy);
    view.z = clamp(view.z * f, 2, 600);
    view.x = sx - wx * view.z;
    view.y = sy - wy * view.z;
    draw();
  }

  /* ================= coverage ================= */
  let heatTimer = null;
  function heatDevices() {
    const list = P.aps.slice();
    if (suggest.preview) for (const s of suggest.aps) list.push(s);
    return list;
  }
  function computeHeat(fast) {
    if (!S().showHeat) { heat = null; heatCanvas = null; return; }
    heat = WM.computeCoverage(P, cur, heatDevices(), fast ? 5000 : 40000);
    heatCanvas = heat ? buildHeatCanvas(heat) : null;
  }
  function buildHeatCanvas(h) {
    const c = document.createElement('canvas');
    c.width = h.cols; c.height = h.rows;
    const g = c.getContext('2d');
    const img = g.createImageData(h.cols, h.rows);
    const d = img.data, s = S();
    for (let i = 0; i < h.vals.length; i++) {
      const v = h.vals[i];
      if (v !== v) continue;
      const col = WM.CLASS_COLORS[WM.classify(v, s)];
      d[i * 4] = col[0]; d[i * 4 + 1] = col[1]; d[i * 4 + 2] = col[2]; d[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  }
  /** Something changed that affects the signal. fast = live preview while dragging. */
  function invalidate(o = {}) {
    if (o.fast) { computeHeat(true); draw(); return; }
    clearTimeout(heatTimer);
    heatTimer = setTimeout(() => {
      computeHeat(false);
      draw();
      renderCovTab();
      renderSugTab();
      updateHud();
    }, 40);
    if (o.save !== false) scheduleSave();
    draw();
  }
  function afterStructureChange() {
    renderFloorSelect();
    renderAllTabs();
    invalidate();
  }

  /* ================= drawing ================= */
  let drawQueued = false;
  function draw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(drawNow); } }
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function bgImage(bg) {
    if (!bg) return null;
    let im = imgCache.get(bg.srcId);
    if (!im) {
      im = new Image();
      im.onload = draw;
      im.src = bg.src || srcCache.get(bg.srcId);
      imgCache.set(bg.srcId, im);
    }
    return im.complete && im.naturalWidth ? im : null;
  }
  function haloText(text, x, y, color, font, align) {
    ctx.font = font || '600 12px system-ui, sans-serif';
    ctx.textAlign = align || 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = cssVar('--canvas') || '#fff';
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color || cssVar('--text');
    ctx.fillText(text, x, y);
  }
  function drawNow() {
    drawQueued = false;
    if (!W) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = cssVar('--canvas') || '#fff';
    ctx.fillRect(0, 0, W, H);
    drawGrid();
    const f = floor();
    if (f.bg) {
      const im = bgImage(f.bg);
      if (im) {
        ctx.save();
        ctx.globalAlpha = f.bg.opacity ?? 0.85;
        const [sx, sy] = w2s(f.bg.x, f.bg.y);
        const k = f.bg.mpp * view.z;
        ctx.drawImage(im, sx, sy, f.bg.w * k, f.bg.h * k);
        ctx.restore();
        if (tool === 'moveImage') {
          ctx.save(); ctx.strokeStyle = cssVar('--accent'); ctx.setLineDash([6, 4]); ctx.lineWidth = 2;
          ctx.strokeRect(sx, sy, f.bg.w * k, f.bg.h * k); ctx.restore();
        }
      }
    }
    if (cur > 0) { ctx.save(); ctx.globalAlpha = 0.2; drawWalls(P.floors[cur - 1].walls, false); ctx.restore(); }
    if (heatCanvas && heat && heat.fi === cur) {
      ctx.save();
      ctx.globalAlpha = S().opacity;
      ctx.imageSmoothingEnabled = !!S().smooth;
      const [sx, sy] = w2s(heat.x0, heat.y0);
      ctx.drawImage(heatCanvas, sx, sy, heat.cols * heat.res * view.z, heat.rows * heat.res * view.z);
      ctx.restore();
    }
    drawZones();
    drawWalls(f.walls, true);
    drawSurvey();
    // devices on other floors (faint)
    for (const d of P.aps) if (d.floorId !== f.id) drawDevice(d, { alpha: 0.28 });
    for (const d of P.aps) if (d.floorId === f.id) drawDevice(d, {});
    suggest.aps.forEach((s, i) => { if (s.floorId === f.id) drawGhost(s, '+' + (i + 1), '#7c3aed'); });
    suggest.router.forEach((s, i) => { if (s.floorId === f.id) drawGhost(s, '★' + (i + 1), '#ca8a04'); });
    drawPreview();
    if (probe) {
      const [x, y] = w2s(probe.x, probe.y);
      ctx.strokeStyle = cssVar('--text'); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.moveTo(x - 12, y); ctx.lineTo(x + 12, y); ctx.moveTo(x, y - 12); ctx.lineTo(x, y + 12); ctx.stroke();
    }
    drawScaleBar();
  }
  function drawGrid() {
    let step = 1;
    while (step * view.z < 16) step *= 5;
    const [x0, y0] = s2w(0, 0), [x1, y1] = s2w(W, H);
    ctx.lineWidth = 1;
    for (const major of [false, true]) {
      const st = major ? step * 5 : step;
      ctx.strokeStyle = major ? cssVar('--grid-major') : cssVar('--grid');
      ctx.beginPath();
      for (let x = Math.floor(x0 / st) * st; x <= x1; x += st) { const sx = Math.round(x * view.z + view.x) + 0.5; ctx.moveTo(sx, 0); ctx.lineTo(sx, H); }
      for (let y = Math.floor(y0 / st) * st; y <= y1; y += st) { const sy = Math.round(y * view.z + view.y) + 0.5; ctx.moveTo(0, sy); ctx.lineTo(W, sy); }
      ctx.stroke();
    }
  }
  function drawWalls(walls, interactive) {
    ctx.lineCap = 'round';
    for (const w of walls) {
      const m = WM.MATERIALS[w.material] || WM.MATERIALS.drywall;
      const [ax, ay] = w2s(w.x1, w.y1), [bx, by] = w2s(w.x2, w.y2);
      const lw = Math.max(2.5, m.thick * view.z);
      const selected = interactive && sel && sel.kind === 'wall' && sel.id === w.id;
      if (selected) {
        ctx.strokeStyle = cssVar('--accent'); ctx.lineWidth = lw + 6;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      }
      ctx.strokeStyle = m.color; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      if (selected) {
        for (const [x, y] of [[ax, ay], [bx, by]]) {
          ctx.fillStyle = '#fff'; ctx.strokeStyle = cssVar('--accent'); ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
        haloText(fmt(Math.hypot(w.x2 - w.x1, w.y2 - w.y1), 2) + ' m', (ax + bx) / 2, (ay + by) / 2 - 14);
      }
    }
  }
  function drawZones() {
    const f = floor();
    f.zones.forEach((z, k) => {
      const selected = sel && sel.kind === 'zone' && sel.id === z.id;
      ctx.save();
      ctx.beginPath();
      z.pts.forEach((p, i) => { const [x, y] = w2s(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath();
      if (selected) { ctx.fillStyle = 'rgba(37,99,235,0.10)'; ctx.fill(); }
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = selected ? 2.5 : 1.3;
      ctx.strokeStyle = selected ? cssVar('--accent') : cssVar('--muted');
      ctx.stroke();
      ctx.restore();
      const [cx, cy] = w2s(...Geo.centroid(z.pts));
      let label = z.name || 'Area';
      if (heat && heat.fi === cur && heat.perZone[k]) {
        const c = heat.perZone[k], t = c[0] + c[1] + c[2];
        if (t) label += ' · ' + pct(c[2] / t);
      }
      const bb = Geo.bbox(z.pts);
      const room = (bb.x1 - bb.x0) * view.z - 6;
      ctx.font = '600 12px system-ui, sans-serif';
      if (ctx.measureText(label).width > room) label = label.includes(' · ') ? label.split(' · ').pop() : '';
      if (label && ctx.measureText(label).width <= room) haloText(label, cx, cy, z.priority === 0 ? cssVar('--muted') : cssVar('--text'));
    });
  }
  function drawDevice(d, o) {
    const t = WM.DEVICE_TYPES[d.type] || WM.DEVICE_TYPES.ap;
    const [x, y] = w2s(d.x, d.y);
    ctx.save();
    ctx.globalAlpha = o.alpha ?? 1;
    const selected = sel && sel.kind === 'ap' && sel.id === d.id;
    if (selected) { ctx.fillStyle = 'rgba(37,99,235,0.25)'; ctx.beginPath(); ctx.arc(x, y, 22, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = t.color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = '700 13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(t.letter, x, y + 0.5);
    if (d.locked) { ctx.fillStyle = '#0f172a'; ctx.beginPath(); ctx.arc(x + 11, y - 11, 5, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    if ((o.alpha ?? 1) === 1) haloText(d.name || t.name, x, y + 26);
  }
  function drawGhost(s, label, color) {
    const [x, y] = w2s(s.x, s.y);
    ctx.save();
    ctx.fillStyle = color + '33'; ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.arc(x, y, 16, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
    haloText(label, x, y, color, '800 13px system-ui, sans-serif');
  }
  function drawSurvey() {
    const f = floor(), s = S();
    for (const p of f.survey) {
      const [x, y] = w2s(p.x, p.y);
      const col = WM.CLASS_COLORS[WM.classify(p.dbm, s)];
      const selected = sel && sel.kind === 'survey' && sel.id === p.id;
      ctx.save();
      ctx.fillStyle = `rgb(${col.join(',')})`; ctx.strokeStyle = selected ? cssVar('--accent') : '#fff'; ctx.lineWidth = selected ? 3 : 2;
      ctx.beginPath(); ctx.moveTo(x, y - 8); ctx.lineTo(x + 8, y); ctx.lineTo(x, y + 8); ctx.lineTo(x - 8, y); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
      haloText(fmt(p.dbm, 0) + (p.band !== s.band ? ` (${p.band})` : ''), x, y - 16, null, '600 11px system-ui, sans-serif');
    }
  }
  function drawPreview() {
    if (!drawing) return;
    const d = drawing;
    ctx.save();
    if (d.kind === 'wall' || d.kind === 'scale') {
      const [ax, ay] = w2s(d.a[0], d.a[1]), [bx, by] = w2s(d.b[0], d.b[1]);
      const m = WM.MATERIALS[opts.material];
      ctx.strokeStyle = d.kind === 'scale' ? cssVar('--accent') : m.color;
      ctx.lineWidth = d.kind === 'scale' ? 3 : Math.max(2.5, m.thick * view.z);
      ctx.lineCap = 'round';
      if (d.kind === 'scale') ctx.setLineDash([8, 5]);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.setLineDash([]);
      for (const [x, y, sn] of [[ax, ay, d.a[2]], [bx, by, d.b[2]]]) {
        ctx.fillStyle = sn ? '#22c55e' : cssVar('--accent');
        ctx.beginPath(); ctx.arc(x, y, sn ? 6 : 4, 0, Math.PI * 2); ctx.fill();
      }
      haloText(fmt(Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]), 2) + ' m', (ax + bx) / 2, (ay + by) / 2 - 16, null, '700 13px system-ui, sans-serif');
    } else if (d.kind === 'room' || d.kind === 'zone') {
      const [ax, ay] = w2s(d.a[0], d.a[1]), [bx, by] = w2s(d.b[0], d.b[1]);
      ctx.strokeStyle = d.kind === 'room' ? WM.MATERIALS[opts.material].color : cssVar('--accent');
      ctx.lineWidth = d.kind === 'room' ? Math.max(2.5, WM.MATERIALS[opts.material].thick * view.z) : 2;
      if (d.kind === 'zone') ctx.setLineDash([6, 5]);
      ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      haloText(`${fmt(Math.abs(d.b[0] - d.a[0]), 2)} × ${fmt(Math.abs(d.b[1] - d.a[1]), 2)} m`, (ax + bx) / 2, (ay + by) / 2, null, '700 13px system-ui, sans-serif');
    }
    ctx.restore();
  }
  function drawScaleBar() {
    const target = 110 / view.z;
    const p = Math.pow(10, Math.floor(Math.log10(target)));
    const len = [1, 2, 5, 10].map((k) => k * p).filter((v) => v <= target).pop() || p;
    const px = len * view.z;
    const x = 12, y = H - 16;
    ctx.save();
    ctx.strokeStyle = cssVar('--text'); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 5); ctx.stroke();
    ctx.restore();
    haloText((len >= 1 ? fmt(len, 0) + ' m' : fmt(len * 100, 0) + ' cm'), x + px / 2, y - 10, null, '600 11px system-ui, sans-serif');
  }

  /* ================= geometry helpers ================= */
  function addWall(f, a, b, material) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    if (L < 0.05) return 0;
    const ux = dx / L, uy = dy / L;
    let pieces = [[0, L]];
    for (const w of f.walls) {
      const wl = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
      if (wl < 1e-6) continue;
      const wx = (w.x2 - w.x1) / wl, wy = (w.y2 - w.y1) / wl;
      if (Math.abs(ux * wy - uy * wx) > 0.035) continue;
      const d1 = Math.abs((w.x1 - a[0]) * uy - (w.y1 - a[1]) * ux), d2 = Math.abs((w.x2 - a[0]) * uy - (w.y2 - a[1]) * ux);
      if (d1 > 0.08 || d2 > 0.08) continue;
      const t1 = (w.x1 - a[0]) * ux + (w.y1 - a[1]) * uy, t2 = (w.x2 - a[0]) * ux + (w.y2 - a[1]) * uy;
      const lo = Math.min(t1, t2), hi = Math.max(t1, t2);
      pieces = pieces.flatMap(([s, e]) => {
        if (hi <= s || lo >= e) return [[s, e]];
        const out = [];
        if (lo > s) out.push([s, lo]);
        if (hi < e) out.push([hi, e]);
        return out;
      });
    }
    let n = 0;
    for (const [s, e] of pieces) {
      if (e - s < 0.05) continue;
      f.walls.push({ id: WM.uid('w'), x1: a[0] + ux * s, y1: a[1] + uy * s, x2: a[0] + ux * e, y2: a[1] + uy * e, material });
      n++;
    }
    return n;
  }
  function snapPoint(sx, sy, tol, anchor, excludeId) {
    const f = floor();
    let best = null, bd = tol;
    const tryPt = (x, y) => { const [px, py] = w2s(x, y); const d = Math.hypot(px - sx, py - sy); if (d < bd) { bd = d; best = [x, y]; } };
    for (const w of f.walls) { if (w.id === excludeId) continue; tryPt(w.x1, w.y1); tryPt(w.x2, w.y2); }
    for (const z of f.zones) for (const p of z.pts) tryPt(p[0], p[1]);
    if (best) return [best[0], best[1], true];
    let [wx, wy] = s2w(sx, sy);
    if (anchor && S().snapAngle) {
      const dx = wx - anchor[0], dy = wy - anchor[1], L = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx), q = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
      if (L > 0 && Math.abs(ang - q) < (8 * Math.PI) / 180) { wx = anchor[0] + L * Math.cos(q); wy = anchor[1] + L * Math.sin(q); }
    }
    // Snap onto an existing wall (T-junctions).
    let on = null, od = tol * 0.7;
    for (const w of f.walls) {
      if (w.id === excludeId) continue;
      const r = Geo.distToSeg(wx, wy, w.x1, w.y1, w.x2, w.y2);
      if (r.d * view.z < od) { od = r.d * view.z; on = [r.x, r.y]; }
    }
    if (on) return [on[0], on[1], true];
    return [Math.round(wx * 100) / 100, Math.round(wy * 100) / 100, false];
  }
  function hitTest(sx, sy, tol) {
    const f = floor();
    const devs = P.aps.filter((d) => d.floorId === f.id);
    for (let i = devs.length - 1; i >= 0; i--) {
      const [x, y] = w2s(devs[i].x, devs[i].y);
      if (Math.hypot(sx - x, sy - y) <= 14 + tol * 0.6) return { kind: 'ap', id: devs[i].id };
    }
    for (const p of f.survey) { const [x, y] = w2s(p.x, p.y); if (Math.hypot(sx - x, sy - y) <= 8 + tol * 0.6) return { kind: 'survey', id: p.id }; }
    if (sel && sel.kind === 'wall') {
      const w = f.walls.find((x) => x.id === sel.id);
      if (w) {
        for (const end of [1, 2]) {
          const [x, y] = w2s(w['x' + end], w['y' + end]);
          if (Math.hypot(sx - x, sy - y) <= 8 + tol * 0.6) return { kind: 'wall', id: w.id, end };
        }
      }
    }
    let best = null, bd = tol;
    for (const w of f.walls) {
      const [ax, ay] = w2s(w.x1, w.y1), [bx, by] = w2s(w.x2, w.y2);
      const d = Geo.distToSeg(sx, sy, ax, ay, bx, by).d;
      if (d < bd) { bd = d; best = { kind: 'wall', id: w.id }; }
    }
    if (best) return best;
    for (let k = f.zones.length - 1; k >= 0; k--) {
      const z = f.zones[k];
      const [cx, cy] = w2s(...Geo.centroid(z.pts));
      if (Math.abs(sx - cx) < 45 && Math.abs(sy - cy) < 12) return { kind: 'zone', id: z.id };
      for (let i = 0; i < z.pts.length; i++) {
        const a = w2s(...z.pts[i]), b = w2s(...z.pts[(i + 1) % z.pts.length]);
        if (Geo.distToSeg(sx, sy, a[0], a[1], b[0], b[1]).d < tol * 0.6) return { kind: 'zone', id: z.id };
      }
    }
    return null;
  }
  function getSel() {
    if (!sel) return null;
    const f = floor();
    if (sel.kind === 'ap') return P.aps.find((d) => d.id === sel.id);
    if (sel.kind === 'wall') return f.walls.find((d) => d.id === sel.id);
    if (sel.kind === 'zone') return f.zones.find((d) => d.id === sel.id);
    if (sel.kind === 'survey') return f.survey.find((d) => d.id === sel.id);
    return null;
  }
  function setSel(s, open) {
    sel = s;
    renderSelTab();
    if (s && open) showTab('sel', true);
    draw();
  }
  function deleteSel() {
    const o = getSel();
    if (!o) return;
    pushUndo();
    const f = floor();
    if (sel.kind === 'ap') P.aps = P.aps.filter((d) => d !== o);
    if (sel.kind === 'wall') f.walls = f.walls.filter((d) => d !== o);
    if (sel.kind === 'zone') f.zones = f.zones.filter((d) => d !== o);
    if (sel.kind === 'survey') f.survey = f.survey.filter((d) => d !== o);
    setSel(null);
    invalidate();
  }
  function parseLength(str) {
    const m = String(str).trim().replace(',', '.').match(/^(-?\d*\.?\d+)\s*(m|cm|mm|ft|feet|foot|'|in|inch|inches|")?$/i);
    if (!m) return NaN;
    const v = +m[1], u = (m[2] || 'm').toLowerCase();
    return v * ({ m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, feet: 0.3048, foot: 0.3048, "'": 0.3048, in: 0.0254, inch: 0.0254, inches: 0.0254, '"': 0.0254 }[u] || 1);
  }

  /* ================= pointer input ================= */
  const pointers = new Map();
  let pinch = null;
  const posOf = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('pointerdown', (e) => {
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    pointers.set(e.pointerId, posOf(e));
    if (pointers.size === 2) {
      if (drawing && drawing.kind === 'drag' && drawing.moved) { undo(); redoStack.length = 0; updateUndoButtons(); }
      drawing = null;
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], z: view.z, vx: view.x, vy: view.y };
      draw();
      return;
    }
    if (pointers.size > 2 || pinch) return;
    onDown(e);
  });
  cv.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, posOf(e));
    if (pinch) {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
      const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const z = clamp((pinch.z * d) / pinch.d, 2, 600);
      const wx = (pinch.c[0] - pinch.vx) / pinch.z, wy = (pinch.c[1] - pinch.vy) / pinch.z;
      view.z = z; view.x = c[0] - wx * z; view.y = c[1] - wy * z;
      draw();
      return;
    }
    if (drawing) onMove(e);
    else if (e.pointerType === 'mouse') { hoverPt = s2w(...posOf(e)); updateHud(); }
  });
  const endPointer = (e) => {
    const had = pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size === 0) pinch = null; return; }
    if (had && drawing) onUp(e);
  };
  cv.addEventListener('pointerup', endPointer);
  cv.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); if (!pointers.size) pinch = null; drawing = null; draw(); });
  cv.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !drawing) { hoverPt = null; updateHud(); } });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [sx, sy] = posOf(e);
    if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) * 2 || e.deltaMode) zoomAt(sx, sy, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    else { view.x -= e.deltaX; view.y -= e.deltaY; draw(); }
  }, { passive: false });

  function onDown(e) {
    const [sx, sy] = posOf(e);
    const [wx, wy] = s2w(sx, sy);
    const tol = e.pointerType === 'touch' ? 22 : 10;
    const pan = { kind: 'pan', sx, sy, vx: view.x, vy: view.y, moved: false, tap: true };
    if (e.button === 1 || e.button === 2 || tool === 'pan') { drawing = pan; return; }
    switch (tool) {
      case 'select': {
        const hit = hitTest(sx, sy, tol);
        if (!hit) { drawing = pan; break; }
        const o = (sel = hit, getSel());
        renderSelTab();
        drawing = { kind: 'drag', hit, sx, sy, start: [wx, wy], moved: false, orig: JSON.parse(JSON.stringify(o)) };
        draw();
        break;
      }
      case 'wall': { const p = snapPoint(sx, sy, tol, null); drawing = { kind: 'wall', a: p, b: p, tol }; break; }
      case 'room':
      case 'zone': { const p = snapPoint(sx, sy, tol, null); drawing = { kind: tool, a: p, b: p, tol }; break; }
      case 'scale': drawing = { kind: 'scale', a: [wx, wy], b: [wx, wy] }; break;
      case 'device': drawing = { kind: 'tapDevice', sx, sy }; break;
      case 'survey': drawing = { kind: 'tapSurvey', sx, sy }; break;
      case 'moveImage':
        if (floor().bg) drawing = { kind: 'moveImage', start: [wx, wy], ox: floor().bg.x, oy: floor().bg.y };
        else drawing = pan;
        break;
    }
  }
  function onMove(e) {
    const d = drawing;
    const [sx, sy] = posOf(e);
    const [wx, wy] = s2w(sx, sy);
    if (d.kind === 'pan') {
      if (Math.hypot(sx - d.sx, sy - d.sy) > 5) d.moved = true;
      if (d.moved) { view.x = d.vx + sx - d.sx; view.y = d.vy + sy - d.sy; draw(); }
      return;
    }
    if (d.kind === 'drag') {
      if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) < 6) return;
      const o = getSel();
      if (!o) return;
      if (d.hit.kind === 'ap' && o.locked) { if (!d.warned) { toast('This device is locked. Unlock it in the Selected tab to move it.'); d.warned = true; } return; }
      if (!d.moved) { d.moved = true; pushUndo(); }
      const dx = wx - d.start[0], dy = wy - d.start[1];
      const k = d.hit.kind;
      if (k === 'ap' || k === 'survey') { o.x = d.orig.x + dx; o.y = d.orig.y + dy; }
      else if (k === 'wall' && d.hit.end) {
        const p = snapPoint(sx, sy, e.pointerType === 'touch' ? 22 : 10, [o['x' + (3 - d.hit.end)], o['y' + (3 - d.hit.end)]], o.id);
        o['x' + d.hit.end] = p[0]; o['y' + d.hit.end] = p[1];
      } else if (k === 'wall') { o.x1 = d.orig.x1 + dx; o.y1 = d.orig.y1 + dy; o.x2 = d.orig.x2 + dx; o.y2 = d.orig.y2 + dy; }
      else if (k === 'zone') o.pts = d.orig.pts.map((p) => [p[0] + dx, p[1] + dy]);
      if (k === 'survey') draw();
      else invalidate({ fast: true });
      return;
    }
    if (d.kind === 'wall') { d.b = snapPoint(sx, sy, d.tol, d.a); draw(); return; }
    if (d.kind === 'room' || d.kind === 'zone') { d.b = snapPoint(sx, sy, d.tol, null); draw(); return; }
    if (d.kind === 'scale') { d.b = [wx, wy]; draw(); return; }
    if (d.kind === 'moveImage') {
      const bg = floor().bg;
      bg.x = d.ox + wx - d.start[0]; bg.y = d.oy + wy - d.start[1];
      draw();
      return;
    }
    if ((d.kind === 'tapDevice' || d.kind === 'tapSurvey') && Math.hypot(sx - d.sx, sy - d.sy) > 8) {
      drawing = { kind: 'pan', sx: d.sx, sy: d.sy, vx: view.x, vy: view.y, moved: true };
    }
  }
  function onUp(e) {
    const d = drawing;
    drawing = null;
    const f = floor();
    const [sx, sy] = posOf(e);
    const [wx, wy] = s2w(sx, sy);
    switch (d.kind) {
      case 'pan':
        if (!d.moved && d.tap) { probe = { x: wx, y: wy }; if (sel) setSel(null); updateHud(); draw(); }
        break;
      case 'drag':
        if (d.moved) invalidate();
        else setSel(d.hit, true);
        break;
      case 'wall': {
        if (Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) < 0.1) { draw(); break; }
        pushUndo();
        if (!addWall(f, d.a, d.b, opts.material)) toast('There is already a wall there.');
        invalidate();
        break;
      }
      case 'room':
      case 'zone': {
        const x0 = Math.min(d.a[0], d.b[0]), x1 = Math.max(d.a[0], d.b[0]), y0 = Math.min(d.a[1], d.b[1]), y1 = Math.max(d.a[1], d.b[1]);
        if (x1 - x0 < 0.4 || y1 - y0 < 0.4) { draw(); break; }
        pushUndo();
        if (d.kind === 'room') {
          const c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
          for (let i = 0; i < 4; i++) addWall(f, c[i], c[(i + 1) % 4], opts.material);
        }
        const n = f.zones.length + 1;
        const z = { id: WM.uid('z'), name: d.kind === 'room' ? 'Room ' + n : 'Area ' + n, priority: 1, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
        f.zones.push(z);
        setSel({ kind: 'zone', id: z.id });
        invalidate();
        break;
      }
      case 'scale': {
        const L = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
        if (L * view.z < 12) { draw(); toast('Drag along something whose real length you know.'); break; }
        askScale(d.a, d.b);
        break;
      }
      case 'tapDevice': addDevice(wx, wy, opts.deviceType); break;
      case 'tapSurvey': askSurvey(wx, wy); break;
      case 'moveImage': scheduleSave(); break;
    }
  }

  /* ================= actions ================= */
  function deviceName(type) {
    if (type === 'router' && !P.aps.some((a) => a.type === 'router')) return 'Router';
    const t = WM.DEVICE_TYPES[type];
    let n = P.aps.filter((a) => a.type === type).length + 1;
    while (P.aps.some((a) => a.name === t.name + ' ' + n)) n++;
    return t.name + ' ' + n;
  }
  function addDevice(x, y, type, floorId, quiet) {
    pushUndo();
    const d = { id: WM.uid('d'), type, name: deviceName(type), x, y, floorId: floorId || floor().id, eirp: null, locked: false };
    P.aps.push(d);
    if (!quiet) { setSel({ kind: 'ap', id: d.id }); setTool('select'); }
    invalidate();
    return d;
  }
  async function askScale(a, b) {
    const cur = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const f = floor();
    const hasGeo = f.walls.length || f.zones.length || P.aps.some((d) => d.floorId === f.id);
    const r = await openDialog(`
      <h2>Set the scale</h2>
      <p class="muted">The line you drew is currently <b>${fmt(cur, 2)} m</b>. How long is it in real life? You can type units, e.g. <code>4.2</code>, <code>420cm</code> or <code>14ft</code>.</p>
      <div class="row"><label>Real length</label><input type="text" name="len" inputmode="decimal" autofocus value="${fmt(cur, 2).replace('−', '-')}"></div>
      ${hasGeo ? '<label class="check"><input type="checkbox" name="all" checked> Also resize walls, rooms and devices on this floor</label>' : ''}
      <div class="dlg-actions"><button class="btn primary" value="ok">Apply scale</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>`);
    draw();
    if (r.action !== 'ok') return;
    const real = parseLength(r.data.len);
    if (!(real > 0)) { toast('Please enter a length like 4.2 or 420cm.'); return; }
    const k = real / cur;
    pushUndo();
    const sc = (x, y) => [a[0] + (x - a[0]) * k, a[1] + (y - a[1]) * k];
    if (f.bg) { [f.bg.x, f.bg.y] = sc(f.bg.x, f.bg.y); f.bg.mpp *= k; }
    if (r.data.all !== false) {
      for (const w of f.walls) { [w.x1, w.y1] = sc(w.x1, w.y1); [w.x2, w.y2] = sc(w.x2, w.y2); }
      for (const z of f.zones) z.pts = z.pts.map((p) => sc(p[0], p[1]));
      for (const p of f.survey) [p.x, p.y] = sc(p.x, p.y);
      for (const d of P.aps) if (d.floorId === f.id) [d.x, d.y] = sc(d.x, d.y);
    }
    suggest.router = []; suggest.aps = [];
    fit();
    setTool('select');
    toast('Scale set. Now trace walls with the Wall or Room tool.');
    invalidate();
  }
  async function askSurvey(x, y) {
    const r = await openDialog(`
      <h2>Add a signal measurement</h2>
      <p class="muted">Stand at this spot and read the signal strength (RSSI, in dBm) from a Wi-Fi analyser app or your computer's Wi-Fi details. Measurements are used to calibrate the prediction for your home.</p>
      <div class="row"><label>Measured signal (dBm)</label><input type="number" name="dbm" step="1" min="-100" max="-10" value="-60" autofocus></div>
      <div class="row"><label>Band</label><select name="band">${Object.keys(WM.BANDS).map((b) => `<option value="${b}" ${b === S().band ? 'selected' : ''}>${WM.BANDS[b].label}</option>`).join('')}</select></div>
      <div class="dlg-actions"><button class="btn primary" value="ok">Add</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>`);
    if (r.action !== 'ok') return;
    let v = parseFloat(r.data.dbm);
    if (!Number.isFinite(v)) return;
    if (v > 0) v = -v;
    pushUndo();
    const p = { id: WM.uid('s'), x, y, dbm: v, band: r.data.band };
    floor().survey.push(p);
    setSel({ kind: 'survey', id: p.id });
    invalidate();
  }
  function setBackground(f, bg) {
    bg.srcId = WM.uid('b');
    srcCache.set(bg.srcId, bg.src);
    bg.opacity = bg.opacity ?? 0.85;
    f.bg = bg;
  }
  function addFloor() {
    pushUndo();
    const names = ['Ground floor', 'First floor', 'Second floor', 'Third floor', 'Fourth floor'];
    const f = WM.newFloor(names[P.floors.length] || 'Floor ' + (P.floors.length + 1));
    P.floors.push(f);
    cur = P.floors.length - 1;
    sel = null;
    afterStructureChange();
    toast('Added ' + f.name + '. The floor below is shown faintly to help you line things up.');
  }

  /* ================= HUD (signal readout) ================= */
  function signalAt(x, y) {
    const devs = heatDevices();
    if (!devs.length) return null;
    const eng = new WM.Engine(P);
    return devs.map((d) => ({ d, v: eng.rssi(d, cur, x, y) })).sort((a, b) => b.v - a.v);
  }
  function updateHud() {
    const hud = $('#hud');
    const pt = hoverPt || probe;
    if (!pt) { hud.hidden = true; return; }
    const r = signalAt(pt[0] ?? pt.x, pt[1] ?? pt.y);
    if (!r) { hud.hidden = false; hud.innerHTML = '<span class="muted">Place a router to see signal strength.</span>'; return; }
    const s = S();
    const top = r[0];
    const cl = WM.classify(top.v, s);
    const col = `rgb(${WM.CLASS_COLORS[cl].join(',')})`;
    hud.hidden = false;
    hud.innerHTML = `<div><span class="dot" style="background:${col}"></span><b>${fmt(top.v, 0)} dBm</b> · ${WM.CLASS_NAMES[cl]} <span class="muted">(${WM.BANDS[s.band].label})</span></div>` +
      r.slice(0, 3).map((x) => `<div class="muted">${esc(x.d.name || 'Suggested')}: ${fmt(x.v, 0)} dBm</div>`).join('');
  }

  /* ================= tools ================= */
  const HINTS = {
    select: 'Tap to select or check the signal · drag to move',
    pan: 'Drag to move around · pinch or scroll to zoom',
    wall: 'Drag to draw a wall. Ends snap to corners. Leave gaps for doorways.',
    room: 'Drag a rectangle to add a room (4 walls + a named area)',
    zone: 'Drag a rectangle to mark an area that needs Wi-Fi (e.g. garden, office)',
    device: 'Tap where the router or access point is (or could go)',
    scale: 'Drag along something you know the length of, e.g. a wall or the map scale bar',
    survey: 'Tap where you measured the signal with your phone or laptop',
    moveImage: 'Drag to move the background image. Tap Select when done.',
  };
  function setTool(t) {
    tool = t;
    drawing = null;
    $$('#toolbar button').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    $('#hint').textContent = HINTS[t] || '';
    const to = $('#toolOpts');
    if (t === 'wall' || t === 'room') {
      to.innerHTML = `<span>Material</span><select id="optMat">${matOptions(opts.material)}</select>`;
      $('#optMat').onchange = (e) => { opts.material = e.target.value; };
    } else if (t === 'device') {
      to.innerHTML = `<span>Type</span><select id="optDev">${Object.entries(WM.DEVICE_TYPES).map(([k, v]) => `<option value="${k}" ${k === opts.deviceType ? 'selected' : ''}>${v.name}</option>`).join('')}</select>`;
      $('#optDev').onchange = (e) => { opts.deviceType = e.target.value; };
    } else if (t === 'moveImage') {
      to.innerHTML = '<button class="btn small primary" id="optDone">Done</button>';
      $('#optDone').onclick = () => setTool('select');
    } else to.innerHTML = '';
    draw();
  }
  const matOptions = (v) => Object.entries(WM.MATERIALS).map(([k, m]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${m.name} (${m.loss[S().band]} dB)</option>`).join('');
  $$('#toolbar button').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));

  /* ================= panels ================= */
  function showTab(name, expand) {
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab-body').forEach((b) => (b.hidden = b.id !== 'tab-' + name));
    if (expand && window.matchMedia('(max-width: 900px)').matches) $('#panel').classList.remove('collapsed');
  }
  $$('.tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  function renderAllTabs() { renderPlanTab(); renderSelTab(); renderCovTab(); renderSugTab(); }
  function bind(root, id, ev, fn) { const el = root.querySelector('#' + id); if (el) el['on' + ev] = fn; }

  function renderFloorSelect() {
    $('#floorSel').innerHTML = P.floors.map((f, i) => `<option value="${i}" ${i === cur ? 'selected' : ''}>${esc(f.name)}</option>`).join('') + '<option value="add">+ Add floor…</option>';
    $$('#bandSwitch button').forEach((b) => b.classList.toggle('active', b.dataset.band === S().band));
    renderLegend();
  }
  function renderLegend() {
    const s = S();
    $('#legend').innerHTML = `<span><i style="background:var(--good)"></i>≥ ${s.good}</span><span><i style="background:var(--fair)"></i>${s.good} to ${s.fair}</span><span><i style="background:var(--poor)"></i>&lt; ${s.fair} dBm</span>`;
  }

  function renderPlanTab() {
    const el = $('#tab-plan');
    const f = floor();
    el.innerHTML = `
      <h3>Project</h3>
      <div class="row"><input type="text" id="pName" value="${esc(P.name)}" aria-label="Project name"></div>
      <h3>Floors</h3>
      <div class="row"><select id="pFloor">${P.floors.map((x, i) => `<option value="${i}" ${i === cur ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
      <div class="btn-grid">
        <button class="btn small" id="pAddFloor">+ Add floor</button>
        <button class="btn small" id="pRenameFloor">Rename</button>
        <button class="btn small" id="pFloorUp" ${cur === P.floors.length - 1 ? 'disabled' : ''}>Move up a level</button>
        <button class="btn small danger" id="pDelFloor" ${P.floors.length < 2 ? 'disabled' : ''}>Delete floor</button>
      </div>
      <h3>Import a layout</h3>
      <div class="btn-grid">
        <button class="btn" id="pImgBtn">Floor plan image</button>
        <button class="btn" id="pMapBtn">Google Maps</button>
        <button class="btn" id="pScanBtn">LiDAR / 3D scan</button>
        <button class="btn" id="pCadBtn">CAD / DXF file</button>
      </div>
      <p class="muted">Photos, screenshots, estate-agent plans or scans all work. After importing an image, use <b>Scale</b> to tell the app how big it is.</p>
      ${f.bg ? `
      <h3>Background image</h3>
      <div class="row"><label>Opacity</label><input type="range" id="pBgOp" min="0.1" max="1" step="0.05" value="${f.bg.opacity ?? 0.85}"></div>
      <div class="btn-grid">
        <button class="btn small" id="pBgMove">Move / align</button>
        <button class="btn small danger" id="pBgDel">Remove image</button>
      </div>` : ''}
      <h3>Drawing</h3>
      <label class="check"><input type="checkbox" id="pSnap" ${S().snapAngle ? 'checked' : ''}> Snap walls to 45° angles</label>
      <div class="note"><b>${f.walls.length}</b> walls · <b>${f.zones.length}</b> rooms/areas · <b>${P.aps.length}</b> devices</div>
      ${f.walls.length ? '<button class="btn small danger" id="pClearWalls">Clear all walls on this floor</button>' : ''}
      <h3>Save &amp; share</h3>
      <div class="btn-grid">
        <button class="btn small" id="pSave">Save to file</button>
        <button class="btn small" id="pOpen">Open file</button>
        <button class="btn small" id="pPng">Export picture</button>
        <button class="btn small" id="pHelp">How to use</button>
        <button class="btn small" id="pDemo">Load demo house</button>
        <button class="btn small danger" id="pNew">New project</button>
      </div>
      <p class="muted">Everything is saved automatically on this device and works without internet.</p>`;
    bind(el, 'pName', 'change', (e) => { P.name = e.target.value || 'My home'; scheduleSave(); });
    bind(el, 'pFloor', 'change', (e) => switchFloor(+e.target.value));
    bind(el, 'pAddFloor', 'click', addFloor);
    bind(el, 'pRenameFloor', 'click', async () => {
      const r = await openDialog(`<h2>Rename floor</h2><div class="row"><input type="text" name="n" value="${esc(f.name)}" autofocus></div><div class="dlg-actions"><button class="btn primary" value="ok">Save</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>`);
      if (r.action === 'ok' && r.data.n.trim()) { pushUndo(); f.name = r.data.n.trim(); afterStructureChange(); }
    });
    bind(el, 'pFloorUp', 'click', () => {
      pushUndo();
      [P.floors[cur], P.floors[cur + 1]] = [P.floors[cur + 1], P.floors[cur]];
      cur++;
      afterStructureChange();
    });
    bind(el, 'pDelFloor', 'click', () => {
      if (!confirm(`Delete "${f.name}" and everything on it?`)) return;
      pushUndo();
      P.aps = P.aps.filter((d) => d.floorId !== f.id);
      P.floors.splice(cur, 1);
      cur = Math.max(0, cur - 1);
      sel = null;
      afterStructureChange();
    });
    bind(el, 'pImgBtn', 'click', () => $('#fileImage').click());
    bind(el, 'pMapBtn', 'click', mapsDialog);
    bind(el, 'pScanBtn', 'click', () => scanDialog('scan'));
    bind(el, 'pCadBtn', 'click', () => scanDialog('cad'));
    bind(el, 'pBgOp', 'input', (e) => { f.bg.opacity = +e.target.value; draw(); scheduleSave(); });
    bind(el, 'pBgMove', 'click', () => setTool('moveImage'));
    bind(el, 'pBgDel', 'click', () => { pushUndo(); f.bg = null; renderPlanTab(); invalidate(); });
    bind(el, 'pSnap', 'change', (e) => { S().snapAngle = e.target.checked; scheduleSave(); });
    bind(el, 'pClearWalls', 'click', () => { if (!confirm('Remove all walls on this floor?')) return; pushUndo(); f.walls = []; sel = null; afterStructureChange(); });
    bind(el, 'pSave', 'click', () => download(new Blob([JSON.stringify(P)], { type: 'application/json' }), slug(P.name) + '.wifimap.json'));
    bind(el, 'pOpen', 'click', () => $('#fileProject').click());
    bind(el, 'pPng', 'click', exportPng);
    bind(el, 'pHelp', 'click', helpDialog);
    bind(el, 'pDemo', 'click', () => { if (hasContent() && !confirm('Replace the current plan with the demo house? (Save it to a file first if you want to keep it.)')) return; loadDemo(); });
    bind(el, 'pNew', 'click', () => { if (hasContent() && !confirm('Start a new, empty project? The current one will be replaced.')) return; newProject(); });
  }

  function renderSelTab() {
    const el = $('#tab-sel');
    const o = getSel();
    if (!o) {
      el.innerHTML = '<p class="muted">Nothing selected. Choose the <b>Select</b> tool and tap a wall, room, device or measurement to edit it.</p>';
      return;
    }
    const k = sel.kind;
    const s = S();
    let h = '';
    if (k === 'wall') {
      const len = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
      h = `<h3>Wall</h3>
        <div class="row"><label>Material</label><select id="sMat">${matOptions(o.material)}</select></div>
        <div class="row"><label>Length</label><input type="text" id="sLen" value="${fmt(len, 2).replace('−', '-')}" inputmode="decimal"></div>
        <p class="muted">Signal loss through this wall: ${Object.keys(WM.BANDS).map((b) => `${WM.BANDS[b].label} ${WM.MATERIALS[o.material].loss[b]} dB`).join(' · ')}</p>
        <div class="btn-grid"><button class="btn small" id="sSplit">Add doorway in middle</button><button class="btn small danger" id="sDel">Delete wall</button></div>`;
    } else if (k === 'ap') {
      const t = WM.DEVICE_TYPES[o.type];
      h = `<h3>${esc(t.name)}</h3>
        <div class="row"><label>Name</label><input type="text" id="sName" value="${esc(o.name)}"></div>
        <div class="row"><label>Type</label><select id="sType">${Object.entries(WM.DEVICE_TYPES).map(([kk, v]) => `<option value="${kk}" ${kk === o.type ? 'selected' : ''}>${v.name}</option>`).join('')}</select></div>
        <div class="row"><label>Floor</label><select id="sFloor">${P.floors.map((f) => `<option value="${f.id}" ${f.id === o.floorId ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></div>
        <h3>Transmit power (EIRP, dBm)</h3>
        ${Object.keys(WM.BANDS).map((b) => `<div class="row"><label>${WM.BANDS[b].label}</label><input type="number" data-eirp="${b}" step="1" min="0" max="36" placeholder="${t.eirp[b]} (default)" value="${o.eirp && o.eirp[b] != null ? o.eirp[b] : ''}"></div>`).join('')}
        <p class="muted">Leave blank for typical values. Lower it if the device's power is set to "medium/low".</p>
        <label class="check"><input type="checkbox" id="sLock" ${o.locked ? 'checked' : ''}> Lock position (e.g. router fixed at the internet socket)</label>
        <div class="btn-grid"><button class="btn small danger" id="sDel">Delete device</button></div>`;
    } else if (k === 'zone') {
      const zi = floor().zones.indexOf(o);
      let cov = '';
      if (heat && heat.fi === cur && heat.perZone[zi]) {
        const c = heat.perZone[zi], t = c[0] + c[1] + c[2];
        if (t) cov = covBar(c[2] / t, c[1] / t, c[0] / t);
      }
      h = `<h3>Room / area</h3>
        <div class="row"><label>Name</label><input type="text" id="sName" value="${esc(o.name)}"></div>
        <div class="row"><label>Importance</label><select id="sPri">${Object.entries(WM.PRIORITIES).map(([v, n]) => `<option value="${v}" ${+v === (o.priority ?? 1) ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <p class="muted">Area ${fmt(Geo.polyArea(o.pts), 1)} m². "Important" rooms count double when suggesting placements; "Ignore" leaves them out (e.g. garage, loft).</p>
        ${cov}
        <div class="btn-grid"><button class="btn small danger" id="sDel">Delete area</button></div>`;
    } else if (k === 'survey') {
      const eng = new WM.Engine(Object.assign({}, P, { settings: Object.assign({}, s, { band: o.band }) }));
      const devs = P.aps;
      const pred = devs.length ? Math.max(...devs.map((d) => eng.rssi(d, cur, o.x, o.y))) : null;
      h = `<h3>Measurement</h3>
        <div class="row"><label>Measured (dBm)</label><input type="number" id="sDbm" value="${o.dbm}" step="1"></div>
        <div class="row"><label>Band</label><select id="sBand">${Object.keys(WM.BANDS).map((b) => `<option value="${b}" ${b === o.band ? 'selected' : ''}>${WM.BANDS[b].label}</option>`).join('')}</select></div>
        <p class="muted">${pred != null ? `Predicted here: <b>${fmt(pred, 0)} dBm</b> (difference ${fmt(o.dbm - pred, 0)} dB).` : 'Place your router to compare with the prediction.'}</p>
        <div class="btn-grid"><button class="btn small danger" id="sDel">Delete</button></div>`;
    }
    el.innerHTML = h;
    bind(el, 'sDel', 'click', deleteSel);
    bind(el, 'sMat', 'change', (e) => { pushUndo(); o.material = e.target.value; opts.material = o.material; renderSelTab(); invalidate(); });
    bind(el, 'sLen', 'change', (e) => {
      const L = parseLength(e.target.value), cl = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
      if (!(L > 0) || !cl) return;
      pushUndo();
      o.x2 = o.x1 + ((o.x2 - o.x1) * L) / cl; o.y2 = o.y1 + ((o.y2 - o.y1) * L) / cl;
      invalidate();
    });
    bind(el, 'sSplit', 'click', () => {
      const L = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
      if (L < 1.2) { toast('Wall is too short for a doorway.'); return; }
      pushUndo();
      const gap = 0.9 / L, a = 0.5 - gap / 2, b = 0.5 + gap / 2;
      const f = floor();
      const w2 = { id: WM.uid('w'), material: o.material, x1: o.x1 + (o.x2 - o.x1) * b, y1: o.y1 + (o.y2 - o.y1) * b, x2: o.x2, y2: o.y2 };
      o.x2 = o.x1 + (o.x2 - o.x1) * a; o.y2 = o.y1 + (o.y2 - o.y1) * a;
      f.walls.push(w2);
      invalidate();
    });
    bind(el, 'sName', 'change', (e) => { pushUndo(); o.name = e.target.value; invalidate(); });
    bind(el, 'sType', 'change', (e) => { pushUndo(); o.type = e.target.value; renderSelTab(); invalidate(); });
    bind(el, 'sFloor', 'change', (e) => { pushUndo(); o.floorId = e.target.value; switchFloor(P.floors.findIndex((f) => f.id === o.floorId)); });
    bind(el, 'sLock', 'change', (e) => { o.locked = e.target.checked; scheduleSave(); draw(); });
    $$('[data-eirp]', el).forEach((inp) => (inp.onchange = () => {
      pushUndo();
      o.eirp = o.eirp || {};
      o.eirp[inp.dataset.eirp] = inp.value === '' ? null : +inp.value;
      invalidate();
    }));
    bind(el, 'sPri', 'change', (e) => { pushUndo(); o.priority = +e.target.value; invalidate(); });
    bind(el, 'sDbm', 'change', (e) => { pushUndo(); o.dbm = -Math.abs(+e.target.value); invalidate(); });
    bind(el, 'sBand', 'change', (e) => { pushUndo(); o.band = e.target.value; renderSelTab(); invalidate(); });
  }

  const covBar = (g, a, r) => `<div class="cov-bar"><i style="width:${g * 100}%;background:var(--good)"></i><i style="width:${a * 100}%;background:var(--fair)"></i><i style="width:${r * 100}%;background:var(--poor)"></i></div>`;

  function calibrationInfo() {
    const pts = [];
    P.floors.forEach((f, fi) => f.survey.forEach((p) => pts.push({ p, fi })));
    if (!pts.length || !P.aps.length) return null;
    const byBand = {};
    for (const { p, fi } of pts) {
      const s = Object.assign({}, S(), { band: p.band, calib: 0 });
      const eng = new WM.Engine(Object.assign({}, P, { settings: s }));
      const pred = Math.max(...P.aps.map((d) => eng.rssi(d, fi, p.x, p.y)));
      (byBand[p.band] = byBand[p.band] || []).push(p.dbm - pred);
    }
    const all = Object.values(byBand).flat();
    const mean = all.reduce((a, b) => a + b, 0) / all.length;
    return { n: all.length, mean };
  }

  function renderCovTab() {
    const el = $('#tab-cov');
    const s = S();
    const f = floor();
    let stats = '';
    if (!P.aps.length && !suggest.aps.length) stats = '<p class="note">Place a router with the <b>Device</b> tool to see coverage.</p>';
    else if (heat && heat.fi === cur) {
      const t = heat.total[0] + heat.total[1] + heat.total[2] || 1;
      const g = heat.total[2] / t, a = heat.total[1] / t, r = heat.total[0] / t;
      stats = `<div class="big-stat"><div><b style="color:var(--good)">${pct(g)}</b>Good</div><div><b style="color:var(--fair)">${pct(a)}</b>Fair</div><div><b style="color:var(--poor)">${pct(r)}</b>Poor</div></div>${covBar(g, a, r)}`;
      if (suggest.aps.length && suggest.preview) stats += '<p class="muted">Includes the suggested access points (preview).</p>';
      if (f.zones.length) {
        stats += f.zones.map((z, i) => {
          const c = heat.perZone[i], tt = c[0] + c[1] + c[2];
          if (!tt) return '';
          return `<div class="zone-row"><div class="top"><span>${esc(z.name)}${z.priority === 0 ? ' <span class="muted">(ignored)</span>' : ''}</span><b>${pct(c[2] / tt)} good</b></div>${covBar(c[2] / tt, c[1] / tt, c[0] / tt)}</div>`;
        }).join('');
      } else stats += '<p class="muted">Tip: add rooms or areas to get a room-by-room report and to limit the map to your home.</p>';
    }
    const cal = calibrationInfo();
    el.innerHTML = `
      <h3>Coverage – ${esc(f.name)} (${WM.BANDS[s.band].label})</h3>
      ${stats}
      <h3>Traffic-light levels</h3>
      <div class="row"><label><span class="dot" style="background:var(--good)"></span>Good from (dBm)</label><input type="number" id="cGood" value="${s.good}" step="1" max="-30" min="-90"></div>
      <div class="row"><label><span class="dot" style="background:var(--fair)"></span>Fair from (dBm)</label><input type="number" id="cFair" value="${s.fair}" step="1" max="-40" min="-95"></div>
      <p class="muted"><b>Green</b> is fine for 4K streaming and video calls, <b>amber</b> is OK for browsing, <b>red</b> means slow or dropping Wi-Fi.</p>
      <h3>Your home</h3>
      <div class="row"><label>Furnishing</label><select id="cEnv">${Object.entries(WM.ENVIRONMENTS).map(([k, v]) => `<option value="${k}" ${k === s.env ? 'selected' : ''}>${v.name}</option>`).join('')}</select></div>
      ${P.floors.length > 1 ? `
      <div class="row"><label>Floors are</label><select id="cFloorType">${Object.entries(WM.FLOOR_TYPES).map(([k, v]) => `<option value="${k}" ${k === s.floorType ? 'selected' : ''}>${v.name}</option>`).join('')}</select></div>
      <div class="row"><label>Storey height (m)</label><input type="number" id="cFloorH" value="${s.floorHeight}" step="0.1" min="2" max="6"></div>` : ''}
      <h3>Display</h3>
      <label class="check"><input type="checkbox" id="cShow" ${s.showHeat ? 'checked' : ''}> Show coverage map</label>
      <label class="check"><input type="checkbox" id="cSmooth" ${s.smooth ? 'checked' : ''}> Smooth edges</label>
      <div class="row"><label>Opacity</label><input type="range" id="cOp" min="0.15" max="0.9" step="0.05" value="${s.opacity}"></div>
      <h3>Calibrate with real measurements</h3>
      <p class="muted">Use the <b>Measure</b> tool to add a few signal readings taken with your phone or laptop. The app compares them with its prediction.</p>
      ${cal ? `<div class="note">${cal.n} measurement${cal.n > 1 ? 's' : ''}: real signal is on average <b>${fmt(Math.abs(cal.mean), 1)} dB ${cal.mean >= 0 ? 'stronger' : 'weaker'}</b> than predicted.${Math.abs(cal.mean - s.calib) > 0.5 ? ` <br><button class="btn small primary" id="cApply" style="margin-top:6px">Apply calibration</button>` : ' Calibration applied ✓'}</div>` : ''}
      ${s.calib ? `<p class="muted">Current correction: ${s.calib > 0 ? '+' : ''}${fmt(s.calib, 1)} dB <button class="btn small" id="cReset">Reset</button></p>` : ''}`;
    const num = (id, key, after) => bind(el, id, 'change', (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) { s[key] = v; after && after(); renderLegend(); invalidate(); } });
    num('cGood', 'good', () => { if (s.fair >= s.good) s.fair = s.good - 1; });
    num('cFair', 'fair', () => { if (s.fair >= s.good) s.good = s.fair + 1; });
    num('cFloorH', 'floorHeight');
    bind(el, 'cEnv', 'change', (e) => { s.env = e.target.value; invalidate(); });
    bind(el, 'cFloorType', 'change', (e) => { s.floorType = e.target.value; invalidate(); });
    bind(el, 'cShow', 'change', (e) => { s.showHeat = e.target.checked; invalidate(); });
    bind(el, 'cSmooth', 'change', (e) => { s.smooth = e.target.checked; draw(); scheduleSave(); });
    bind(el, 'cOp', 'input', (e) => { s.opacity = +e.target.value; draw(); scheduleSave(); });
    bind(el, 'cApply', 'click', () => { s.calib = Math.round(cal.mean * 10) / 10; invalidate(); toast('Calibration applied.'); });
    bind(el, 'cReset', 'click', () => { s.calib = 0; invalidate(); });
  }

  function buildTips() {
    const tips = [];
    const s = S();
    const router = P.aps.find((d) => d.type === 'router');
    if (!router) tips.push('Add your router with the <b>Device</b> tool – usually where the internet line or fibre box comes in. Not fixed yet? Use <b>Find best router spot</b>.');
    else {
      const fi = P.floors.findIndex((f) => f.id === router.floorId);
      const reg = WM.floorRegion(P, fi);
      if (reg) {
        const cx = (reg.x0 + reg.x1) / 2, cy = (reg.y0 + reg.y1) / 2;
        const diag = Math.hypot(reg.x1 - reg.x0, reg.y1 - reg.y0);
        if (Math.hypot(router.x - cx, router.y - cy) > diag * 0.3) tips.push('Your router is near the edge of the home, so a lot of its signal goes outside. A more central spot (even with a longer cable) usually helps most.');
      }
      const f = P.floors[fi] || floor();
      const nearMetal = f.walls.some((w) => w.material === 'metal' && Geo.distToSeg(router.x, router.y, w.x1, w.y1, w.x2, w.y2).d < 1.5);
      if (nearMetal) tips.push('The router is close to something metal (fridge, radiator, steel door). Move it at least 1–2 m away.');
      if (P.floors.length > 2 && fi === 0) tips.push('With three or more floors, the middle floor is usually the best place for the main router.');
    }
    const heavy = P.floors.some((f) => f.walls.some((w) => ['concrete', 'reinforced', 'stone', 'block', 'metal'].includes(w.material) && Math.hypot(w.x2 - w.x1, w.y2 - w.y1) > 1));
    if (heavy) tips.push('You have thick walls. Access points connected by <b>Ethernet</b> (or powerline/MoCA) will work much better than wireless mesh across those walls.');
    if (heat && heat.fi === cur) {
      const weak = floor().zones.filter((z, i) => { const c = heat.perZone[i], t = c[0] + c[1] + c[2]; return z.priority !== 0 && t && c[2] / t < 0.6; });
      if (weak.length) tips.push('Weak spots on this floor: <b>' + weak.map((z) => esc(z.name)).join(', ') + '</b>. Try <b>Suggest access points</b> below.');
    }
    if (P.floors.length > 1) tips.push('For multi-storey homes, one access point or mesh node per floor is a good rule of thumb. Place nodes roughly above/below each other for a strong link.');
    if (P.aps.length > 1) {
      const plan = WM.channelPlan(P);
      tips.push('Suggested channels so your devices don\'t interfere: ' + P.aps.map((d) => `<b>${esc(d.name)}</b> 2.4 GHz ch ${plan[d.id]['2.4']}, 5 GHz ch ${plan[d.id]['5']}`).join('; ') + '. (Mesh systems normally pick channels automatically.)');
    }
    if (s.band !== '2.4') tips.push(`You are viewing ${WM.BANDS[s.band].label}: faster but shorter range. Switch to 2.4 at the top to see the long-range coverage.`);
    tips.push('Put routers and access points up high (shelf height or ceiling), in the open – not in cupboards, behind the TV, or on the floor. Keep them away from microwaves, fish tanks and mirrors.');
    if (!P.floors.some((f) => f.survey.length)) tips.push('For a more accurate map, add 3–5 real signal readings with the <b>Measure</b> tool and apply calibration in the Coverage tab.');
    return tips;
  }

  function renderSugTab() {
    const el = $('#tab-sug');
    const s = S();
    const rr = suggest.routerResult, ar = suggest.result;
    const fname = (id) => esc((P.floors.find((f) => f.id === id) || {}).name || '');
    const multi = P.floors.length > 1;
    const statLine = (st) => `${pct(st.good)} good · ${pct(st.fair)} fair · ${pct(st.poor)} poor`;
    el.innerHTML = `
      <h3>Router position</h3>
      <p class="muted">Finds where a single router covers your rooms best. If your router has to stay at the internet socket, lock it and add access points instead.</p>
      <button class="btn primary" id="gRouter">Find best router spot</button>
      ${rr ? `<div style="margin-top:8px">${rr.before ? `<p class="muted">Current router position: ${statLine(rr.before)}</p>` : ''}
        ${rr.spots.map((sp, i) => `<div class="sug-item"><span><b style="color:#ca8a04">★${i + 1}</b> ${statLine(sp.stats)}${multi ? ' · ' + fname(sp.floorId) : ''}</span><button class="btn small" data-mvr="${i}">Use</button></div>`).join('')}
        <button class="btn small" id="gClearR" style="margin-top:6px">Clear</button></div>` : ''}
      <h3>Access points / mesh</h3>
      <div class="row"><label>Connection</label><select id="gBack"><option value="wireless" ${s.backhaul === 'wireless' ? 'selected' : ''}>Wireless mesh</option><option value="wired" ${s.backhaul === 'wired' ? 'selected' : ''}>Wired (Ethernet / powerline)</option></select></div>
      ${s.backhaul === 'wireless' ? `<div class="row"><label>Min. link to previous node (dBm)</label><input type="number" id="gBhMin" value="${s.backhaulMin}" step="1" max="-40" min="-85"></div>` : ''}
      <div class="row"><label>Max. extra devices</label><input type="number" id="gMax" value="${s.maxNewAps}" min="1" max="8" step="1"></div>
      <div class="row"><label>Target good coverage (%)</label><input type="number" id="gTarget" value="${s.targetCoverage}" min="50" max="100" step="1"></div>
      <button class="btn primary" id="gAps">Suggest access points</button>
      ${ar ? `<div style="margin-top:8px">
        <div class="note">Now: ${statLine(ar.before)}<br>With ${ar.newAps.length} more: <b>${statLine(ar.after)}</b></div>
        ${ar.newAps.length ? '' : '<p class="muted">No extra device needed (or none would help much).</p>'}
        ${suggest.aps.map((sp, i) => `<div class="sug-item"><span><b style="color:#7c3aed">+${i + 1}</b> ${WM.DEVICE_TYPES[sp.type].name}${multi ? ' · ' + fname(sp.floorId) : ''}${sp.backhaul != null && s.backhaul === 'wireless' ? ` <span class="muted">(link ${fmt(sp.backhaul, 0)} dBm)</span>` : ''}</span><button class="btn small" data-adda="${i}">Add</button></div>`).join('')}
        <label class="check" style="margin-top:8px"><input type="checkbox" id="gPrev" ${suggest.preview ? 'checked' : ''}> Show suggestions on the coverage map</label>
        <div class="btn-grid">${suggest.aps.length ? '<button class="btn small primary" id="gAddAll">Add all</button>' : ''}<button class="btn small" id="gClearA">Clear</button></div></div>` : ''}
      <h3>Tips for your home</h3>
      <ul class="tips">${buildTips().map((t) => `<li>${t}</li>`).join('')}</ul>`;
    bind(el, 'gRouter', 'click', () => runOptimizer('router'));
    bind(el, 'gAps', 'click', () => runOptimizer('aps'));
    bind(el, 'gBack', 'change', (e) => { s.backhaul = e.target.value; renderSugTab(); scheduleSave(); });
    bind(el, 'gBhMin', 'change', (e) => { s.backhaulMin = +e.target.value; scheduleSave(); });
    bind(el, 'gMax', 'change', (e) => { s.maxNewAps = clamp(+e.target.value || 1, 1, 8); scheduleSave(); });
    bind(el, 'gTarget', 'change', (e) => { s.targetCoverage = clamp(+e.target.value || 95, 50, 100); scheduleSave(); });
    bind(el, 'gClearR', 'click', () => { suggest.router = []; suggest.routerResult = null; renderSugTab(); draw(); });
    bind(el, 'gClearA', 'click', () => { suggest.aps = []; suggest.result = null; renderSugTab(); invalidate({ save: false }); });
    bind(el, 'gPrev', 'change', (e) => { suggest.preview = e.target.checked; invalidate({ save: false }); });
    bind(el, 'gAddAll', 'click', () => {
      pushUndo();
      for (const sp of suggest.aps) P.aps.push({ id: WM.uid('d'), type: sp.type, name: deviceName(sp.type), x: sp.x, y: sp.y, floorId: sp.floorId, eirp: null, locked: false });
      suggest.aps = [];
      suggest.result = null;
      renderSugTab();
      invalidate();
      toast('Added. Re-run suggestions any time after changes.');
    });
    $$('[data-adda]', el).forEach((b) => (b.onclick = () => {
      const sp = suggest.aps[+b.dataset.adda];
      pushUndo();
      P.aps.push({ id: WM.uid('d'), type: sp.type, name: deviceName(sp.type), x: sp.x, y: sp.y, floorId: sp.floorId, eirp: null, locked: false });
      suggest.aps.splice(+b.dataset.adda, 1);
      renderSugTab();
      invalidate();
    }));
    $$('[data-mvr]', el).forEach((b) => (b.onclick = () => {
      const sp = suggest.router[+b.dataset.mvr];
      let r = P.aps.find((d) => d.type === 'router');
      if (r && r.locked && !confirm('Your router is locked in place. Move it anyway?')) return;
      pushUndo();
      if (!r) { r = { id: WM.uid('d'), type: 'router', name: 'Router', eirp: null, locked: false }; P.aps.push(r); }
      Object.assign(r, { x: sp.x, y: sp.y, floorId: sp.floorId });
      suggest.router = []; suggest.routerResult = null;
      const fi = P.floors.findIndex((f) => f.id === sp.floorId);
      if (fi !== cur) switchFloor(fi);
      renderSugTab();
      invalidate();
    }));
  }

  let optimizing = false;
  async function runOptimizer(mode) {
    if (optimizing) return;
    optimizing = true;
    const busy = $('#busy');
    busy.hidden = false;
    $('#busyText').textContent = mode === 'router' ? 'Testing router positions…' : 'Finding the best access point spots…';
    $('#busyFill').style.width = '0%';
    try {
      const s = S();
      const res = await WM.optimize(P, { mode, maxNew: s.maxNewAps, targetCoverage: s.targetCoverage, backhaul: s.backhaul, backhaulMin: s.backhaulMin }, (p) => { $('#busyFill').style.width = Math.round(p * 100) + '%'; });
      if (mode === 'router') {
        suggest.routerResult = res;
        suggest.router = res.spots;
        toast('Gold ★ markers show the best router spots.');
      } else {
        suggest.result = res;
        suggest.aps = res.newAps.map((a) => Object.assign({}, a, { type: res.apType, name: 'Suggested' }));
        suggest.preview = true;
        toast(res.newAps.length ? 'Purple + markers show where to add devices.' : 'Your coverage already meets the target.');
        const other = suggest.aps.find((a) => a.floorId !== floor().id);
        if (other && !suggest.aps.some((a) => a.floorId === floor().id)) switchFloor(P.floors.findIndex((f) => f.id === other.floorId));
      }
      renderSugTab();
      invalidate({ save: false });
    } catch (e) {
      toast(e.message || String(e));
    } finally {
      optimizing = false;
      busy.hidden = true;
    }
  }

  /* ================= dialogs ================= */
  const dlg = $('#dlg'), dlgForm = $('#dlgForm');
  function openDialog(html) {
    return new Promise((res) => {
      if (dlg.open) dlg.close();
      dlgForm.innerHTML = html;
      dlg.returnValue = '';
      const onClose = () => {
        dlg.removeEventListener('close', onClose);
        const data = {};
        for (const el of dlgForm.elements) {
          if (!el.name) continue;
          data[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'file' ? el.files : el.value;
        }
        res({ action: dlg.returnValue, data });
      };
      dlg.addEventListener('close', onClose);
      dlg.showModal();
      const f = dlgForm.querySelector('[autofocus]');
      if (f) { f.focus(); if (f.select) f.select(); }
    });
  }

  async function welcomeDialog() {
    const r = await openDialog(`
      <h2>Welcome to Wi-Fi Map</h2>
      <p>Map your home or property, place your router and access points, and see Wi-Fi coverage as a traffic light: <b style="color:var(--good)">green</b> good, <b style="color:var(--fair)">amber</b> fair, <b style="color:var(--poor)">red</b> poor. Works fully offline.</p>
      <p class="muted">How would you like to start?</p>
      <div class="btn-grid">
        <button class="btn primary" value="demo">Try a demo house</button>
        <button class="btn" value="image">Upload a floor plan</button>
        <button class="btn" value="scan">Import LiDAR scan / CAD</button>
        <button class="btn" value="maps">Use Google Maps</button>
      </div>
      <div class="dlg-actions"><button class="btn" value="blank">Start blank and draw rooms</button></div>`);
    if (r.action === 'demo') loadDemo();
    else if (r.action === 'image') $('#fileImage').click();
    else if (r.action === 'scan') scanDialog('scan');
    else if (r.action === 'maps') mapsDialog();
    else { setTool('room'); toast('Drag on the canvas to draw your first room.'); }
  }

  function helpDialog() {
    openDialog(`
      <h2>How to use Wi-Fi Map</h2>
      <ol>
        <li><b>Get a layout</b> (Plan tab): upload a floor plan or photo, a Google Maps screenshot of your property, a LiDAR scan (OBJ / RoomPlan) or a DXF file. Or just draw.</li>
        <li><b>Set the scale</b>: pick <b>Scale</b> and drag along something you know the length of, then type the real length.</li>
        <li><b>Draw walls</b> with <b>Wall</b> or <b>Room</b>, choosing the material (brick, drywall, glass…). Leave gaps for open doorways.</li>
        <li><b>Mark areas</b> that need Wi-Fi with <b>Room</b> or <b>Area</b> (e.g. garden, garage). The map and report focus on these.</li>
        <li><b>Place devices</b> with <b>Device</b>: your router and any mesh nodes, access points or extenders.</li>
        <li>Read the <b>coverage map</b>: green ≥ ${S().good} dBm, amber to ${S().fair} dBm, red below. Tap anywhere (Select tool) to see the exact signal. Switch 2.4 / 5 / 6 GHz at the top.</li>
        <li><b>Suggest</b> tab: find the best router spot and where to add access points.</li>
        <li>Optional: add real readings with <b>Measure</b> and calibrate in the Coverage tab.</li>
      </ol>
      <p class="muted">Two fingers to pan/zoom on a phone; mouse wheel on a computer. Undo/redo at the top. Your plan is saved on this device; use “Save to file” to back it up or move it to another device.</p>
      <p class="muted">The map is a prediction using a standard indoor radio model. Real results depend on your devices, furniture and neighbours' networks.</p>
      <div class="dlg-actions"><button class="btn primary" value="ok">Got it</button></div>`);
  }

  async function mapsDialog() {
    let savedKey = '';
    try { savedKey = localStorage.getItem('wifimap-gkey') || ''; } catch (e) { /* ignore */ }
    const r = await openDialog(`
      <h2>Use Google Maps</h2>
      <p><b>Offline way (no account needed):</b></p>
      <ol>
        <li>Open Google Maps, switch to <b>Satellite</b> and zoom right in on your property.</li>
        <li>Take a screenshot (include the scale bar, bottom right).</li>
        <li>Upload it here, then use <b>Scale</b> and drag along the map's scale bar (or a known distance).</li>
      </ol>
      <div class="dlg-actions" style="justify-content:flex-start"><button class="btn primary" value="shot">Upload screenshot</button></div>
      <hr style="border:0;border-top:1px solid var(--border);margin:16px 0">
      <p><b>Direct download (needs internet + Google Maps API key):</b> the scale is set automatically.</p>
      <div class="row"><label>Address, "lat,lng" or Google Maps link</label><input type="text" name="loc" placeholder="51.5007,-0.1246"></div>
      <div class="row"><label>Zoom (18–21)</label><input type="number" name="zoom" value="20" min="15" max="21"></div>
      <div class="row"><label>API key</label><input type="password" name="key" value="${esc(savedKey)}" autocomplete="off"></div>
      <label class="check"><input type="checkbox" name="remember" ${savedKey ? 'checked' : ''}> Remember key on this device</label>
      <p class="muted">Needs the "Maps Static API" (and "Geocoding API" for addresses) enabled on your key.</p>
      <div class="dlg-actions"><button class="btn primary" value="dl">Download satellite image</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>`);
    if (r.action === 'shot') { $('#fileImage').click(); return; }
    if (r.action !== 'dl') return;
    try {
      if (r.data.remember) localStorage.setItem('wifimap-gkey', r.data.key);
      else localStorage.removeItem('wifimap-gkey');
    } catch (e) { /* ignore */ }
    if (!r.data.loc.trim()) { toast('Enter an address or coordinates.'); return; }
    try {
      toast('Downloading…');
      const img = await Imp.googleStatic({ location: r.data.loc, zoom: r.data.zoom, key: r.data.key.trim() });
      pushUndo();
      const f = floor();
      const reg = WM.floorRegion(P, cur);
      const cx = reg && f.walls.length ? (reg.x0 + reg.x1) / 2 : 0, cy = reg && f.walls.length ? (reg.y0 + reg.y1) / 2 : 0;
      setBackground(f, { src: img.src, w: img.w, h: img.h, mpp: img.mpp, x: cx - (img.w * img.mpp) / 2, y: cy - (img.h * img.mpp) / 2, opacity: 1 });
      renderPlanTab();
      fit();
      invalidate();
      toast(img.offlineOk ? 'Satellite image added with correct scale. Draw your house with the Room tool and your garden with Area.' : 'Image added, but your browser blocked saving it for offline use – take a screenshot instead if you need offline.');
    } catch (e) {
      toast('Google Maps download failed: ' + (e.message || e));
    }
  }

  async function scanDialog(kind) {
    const r = await openDialog(`
      <h2>${kind === 'cad' ? 'Import CAD / floor-plan file' : 'Import a LiDAR / 3D scan'}</h2>
      ${kind === 'cad' ? `<p class="muted">DXF files from CAD software or floor-plan apps (magicplan, Polycam floor plan, RoomScan…) become walls automatically.</p>` : `
      <p class="muted">Web apps can't use the LiDAR sensor directly, so scan with a LiDAR app and import the result:</p>
      <ul class="muted">
        <li><b>iPhone / iPad Pro</b>: Polycam, 3D Scanner App, Scaniverse or any RoomPlan app – export as <b>OBJ</b>, <b>DXF</b> or RoomPlan <b>JSON</b>.</li>
        <li><b>Android</b>: any depth/ARCore scanning app that exports <b>OBJ</b>.</li>
      </ul>
      <p class="muted">The app slices the 3D scan at the height below to find walls, cleans them up and also uses the slice as a background picture so you can fix anything it missed.</p>`}
      <div class="row"><input type="file" name="file" accept=".obj,.dxf,.json" required></div>
      ${kind === 'cad' ? '' : `
      <div class="row"><label>Slice height above floor (m)</label><input type="number" name="slice" value="1.3" step="0.1" min="0.3" max="2.5"></div>
      <div class="row"><label>Up axis</label><select name="up"><option value="auto">Automatic</option><option value="y">Y up</option><option value="z">Z up</option></select></div>
      <div class="row"><label>File units</label><select name="unit"><option value="1">Metres</option><option value="0.01">Centimetres</option><option value="0.001">Millimetres</option><option value="0.3048">Feet</option></select></div>`}
      <div class="row"><label>Inside walls</label><select name="mat">${matOptions('drywall')}</select></div>
      <div class="row"><label>Outside walls</label><select name="ext">${matOptions('brick')}</select></div>
      <label class="check"><input type="checkbox" name="replace" ${floor().walls.length ? '' : 'checked'}> Replace existing walls on this floor</label>
      <label class="check"><input type="checkbox" name="bgimg" checked> Use the scan as background picture</label>
      <div class="dlg-actions"><button class="btn primary" value="ok">Import</button><button class="btn" value="cancel" formnovalidate>Cancel</button></div>`);
    if (r.action !== 'ok') return;
    const file = r.data.file && r.data.file[0];
    if (!file) { toast('Choose a file first.'); return; }
    importScanFile(file, r.data);
  }

  async function importScanFile(file, o) {
    const name = file.name.toLowerCase();
    const busy = $('#busy');
    busy.hidden = false;
    $('#busyText').textContent = 'Reading ' + file.name + '…';
    $('#busyFill').style.width = '30%';
    await new Promise((r) => setTimeout(r, 30));
    try {
      const text = await Imp.readText(file);
      $('#busyFill').style.width = '60%';
      await new Promise((r) => setTimeout(r, 0));
      let segs, raw, note = '';
      if (name.endsWith('.json')) {
        const data = JSON.parse(text);
        if (data && Array.isArray(data.floors)) { busy.hidden = true; openProject(data); return; }
        segs = Imp.roomplan(data).segs;
        note = `Imported ${segs.length} walls from RoomPlan.`;
      } else if (name.endsWith('.dxf')) {
        const d = Imp.dxf(text);
        segs = d.segs;
        note = d.note;
      } else if (name.endsWith('.obj')) {
        const d = Imp.obj(text, { slice: o.slice || 1.3, up: o.up || 'auto', unit: o.unit || 1 });
        raw = d.raw;
        segs = Imp.simplify(raw);
        note = `Sliced ${d.triangles.toLocaleString()} triangles (${d.up.toUpperCase()} up) into ${segs.length} walls. Delete any furniture that was picked up as walls.`;
      } else throw new Error('Unsupported file. Use OBJ, DXF or RoomPlan JSON (or an image for pictures).');
      if (!segs.length) throw new Error('No walls found.');
      // Move to origin.
      const all = (raw || segs);
      const b = Geo.bbox(all.flatMap((s) => [[s[0], s[1]], [s[2], s[3]]]));
      const shift = (s) => [s[0] - b.x0, s[1] - b.y0, s[2] - b.x0, s[3] - b.y0];
      segs = segs.map(shift);
      if (raw) raw = raw.map(shift);
      const W0 = b.x1 - b.x0, H0 = b.y1 - b.y0;
      pushUndo();
      const f = floor();
      if (o.replace) { f.walls = []; sel = null; }
      // Outside wall = both ends lie along the same side of the bounding box.
      const sides = (x, y) => [Math.abs(x), Math.abs(y), Math.abs(W0 - x), Math.abs(H0 - y)].map((d) => d < 0.35);
      for (const s of segs) {
        const a = sides(s[0], s[1]), b = sides(s[2], s[3]);
        const ext = a.some((v, i) => v && b[i]);
        addWall(f, [s[0], s[1]], [s[2], s[3]], ext ? o.ext || 'brick' : o.mat || 'drywall');
      }
      if (o.bgimg !== false) setBackground(f, Object.assign(Imp.segmentsToImage(raw || segs), { opacity: 0.6 }));
      afterStructureChange();
      fit();
      toast(note || 'Imported.');
    } catch (e) {
      toast('Import failed: ' + (e.message || e));
    } finally {
      busy.hidden = true;
    }
  }

  /* ================= file handling ================= */
  $('#fileImage').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const img = await Imp.imageFile(file);
      pushUndo();
      const f = floor();
      const reg = f.walls.length ? WM.floorRegion(P, cur) : null;
      const widthM = reg ? reg.x1 - reg.x0 : 15;
      setBackground(f, { src: img.src, w: img.w, h: img.h, mpp: widthM / img.w, x: reg ? reg.x0 : 0, y: reg ? reg.y0 : 0 });
      renderPlanTab();
      fit();
      invalidate();
      setTool('scale');
      toast('Image added. Now drag along something you know the length of to set the scale.');
    } catch (err) { toast(err.message || String(err)); }
  };
  $('#fileScan').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importScanFile(f, { replace: !floor().walls.length }); };
  $('#fileProject').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { openProject(JSON.parse(await Imp.readText(file))); } catch (err) { toast('Could not open that file: ' + (err.message || err)); }
  };
  function openProject(data) {
    if (!data || !Array.isArray(data.floors)) throw new Error('Not a Wi-Fi Map project file.');
    pushUndo();
    P = normalize(data);
    cur = 0; sel = null;
    suggest.router = []; suggest.aps = []; suggest.result = null; suggest.routerResult = null;
    afterStructureChange();
    fit();
    toast('Opened "' + P.name + '".');
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  const slug = (s) => (s || 'wifi-map').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'wifi-map';
  function exportPng() {
    drawNow();
    // Add the legend onto the picture.
    const c = document.createElement('canvas');
    c.width = cv.width; c.height = cv.height;
    const g = c.getContext('2d');
    g.drawImage(cv, 0, 0);
    g.scale(dpr, dpr);
    const s = S();
    const items = [['Good ≥ ' + s.good, WM.CLASS_COLORS[2]], ['Fair ≥ ' + s.fair, WM.CLASS_COLORS[1]], ['Poor', WM.CLASS_COLORS[0]]];
    g.font = '600 13px system-ui, sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.fillRect(W - 330, H - 38, 320, 28);
    let x = W - 320;
    g.fillStyle = '#0f172a';
    g.fillText(`${P.name} · ${floor().name} · ${WM.BANDS[s.band].label}`, 12, 22);
    for (const [t, col] of items) {
      g.fillStyle = `rgb(${col.join(',')})`;
      g.beginPath(); g.arc(x + 6, H - 24, 6, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#0f172a'; g.fillText(t, x + 16, H - 19);
      x += 102;
    }
    try { c.toBlob((b) => b && download(b, slug(P.name) + '-' + slug(floor().name) + '.png'), 'image/png'); }
    catch (e) { toast('Cannot export while an online map image is used – take a screenshot instead.'); }
  }
  const hasContent = () => P.aps.length || P.floors.some((f) => f.walls.length || f.zones.length || f.bg);
  function newProject() {
    pushUndo();
    P = WM.newProject();
    cur = 0; sel = null; probe = null;
    suggest.router = []; suggest.aps = []; suggest.result = null; suggest.routerResult = null;
    afterStructureChange();
    fit();
  }

  /* ================= demo ================= */
  function loadDemo() {
    pushUndo();
    const p = WM.newProject();
    p.name = 'Demo house';
    const f = p.floors[0];
    const wall = (x1, y1, x2, y2, material) => f.walls.push({ id: WM.uid('w'), x1, y1, x2, y2, material });
    // Outer brick walls with glass windows
    wall(0, 0, 2, 0, 'brick'); wall(2, 0, 4, 0, 'glass'); wall(4, 0, 12, 0, 'brick');
    wall(12, 0, 12, 9, 'brick');
    wall(12, 9, 9.5, 9, 'brick'); wall(9.5, 9, 8, 9, 'glass'); wall(8, 9, 2, 9, 'brick'); wall(2, 9, 0.5, 9, 'glass'); wall(0.5, 9, 0, 9, 'brick');
    wall(0, 9, 0, 0, 'brick');
    // Inside
    wall(0, 5, 3, 5, 'drywall'); wall(4, 5, 8, 5, 'drywall'); wall(9, 5, 12, 5, 'drywall');
    wall(7, 0, 7, 2, 'brick'); wall(7, 3.4, 7, 5, 'brick');
    wall(0, 6.2, 1.5, 6.2, 'drywall'); wall(2.4, 6.2, 5, 6.2, 'drywall'); wall(5.8, 6.2, 9, 6.2, 'drywall'); wall(9.9, 6.2, 12, 6.2, 'drywall');
    wall(4.5, 6.2, 4.5, 9, 'block'); wall(7, 6.2, 7, 9, 'block');
    // Fridge
    wall(10.2, 0.15, 10.9, 0.15, 'metal'); wall(10.9, 0.15, 10.9, 0.85, 'metal'); wall(10.9, 0.85, 10.2, 0.85, 'metal'); wall(10.2, 0.85, 10.2, 0.15, 'metal');
    // Garden hedge
    wall(-0.5, 15, 12.5, 15, 'hedge');
    const zone = (name, x0, y0, x1, y1, priority = 1) => f.zones.push({ id: WM.uid('z'), name, priority, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
    zone('Living room', 0, 0, 7, 5, 2);
    zone('Kitchen', 7, 0, 12, 5);
    zone('Hall', 0, 5, 12, 6.2);
    zone('Bedroom 1', 0, 6.2, 4.5, 9, 2);
    zone('Bathroom', 4.5, 6.2, 7, 9);
    zone('Bedroom 2', 7, 6.2, 12, 9);
    zone('Garden', 0, 9.3, 12, 14.7);
    p.aps.push({ id: WM.uid('d'), type: 'router', name: 'Router', x: 11.4, y: 0.5, floorId: f.id, eirp: null, locked: true });
    P = p;
    cur = 0; sel = null; probe = null;
    suggest.router = []; suggest.aps = []; suggest.result = null; suggest.routerResult = null;
    afterStructureChange();
    fit();
    setTool('select');
    showTab('sug');
    toast('Demo loaded: the router is stuck in the kitchen corner. Try the Suggest tab!');
  }

  /* ================= misc UI ================= */
  function switchFloor(i) {
    if (i < 0 || i >= P.floors.length) return;
    cur = i;
    sel = null; probe = null;
    renderFloorSelect();
    renderAllTabs();
    invalidate({ save: false });
  }
  $('#floorSel').onchange = (e) => {
    if (e.target.value === 'add') { addFloor(); return; }
    switchFloor(+e.target.value);
  };
  $$('#bandSwitch button').forEach((b) => (b.onclick = () => {
    S().band = b.dataset.band;
    renderFloorSelect();
    renderAllTabs();
    if (tool === 'wall' || tool === 'room') setTool(tool);
    invalidate();
  }));
  $('#btnUndo').onclick = undo;
  $('#btnRedo').onclick = redo;
  $('#btnFit').onclick = fit;
  $('#btnPanel').onclick = () => { $('#panel').classList.toggle('collapsed'); };
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3800);
  }
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea') || dlg.open) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSel(); return; }
    if (k === 'escape') { drawing = null; setSel(null); probe = null; updateHud(); draw(); return; }
    const map = { v: 'select', h: 'pan', w: 'wall', r: 'room', z: 'zone', d: 'device', s: 'scale', m: 'survey' };
    if (map[k]) setTool(map[k]);
    if (k === 'f') fit();
  });
  new ResizeObserver(resize).observe(stage);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', draw);

  /* ================= start ================= */
  (async function init() {
    if (window.matchMedia('(max-width: 900px)').matches) $('#panel').classList.add('collapsed');
    resize();
    const saved = await loadSaved();
    if (saved) { try { P = normalize(saved); } catch (e) { P = WM.newProject(); } }
    renderFloorSelect();
    renderAllTabs();
    setTool('select');
    updateUndoButtons();
    fit();
    invalidate({ save: false });
    if (!saved || !hasContent()) welcomeDialog();
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});
  })();

  // Expose for debugging / tests.
  WM.app = { get project() { return P; }, loadDemo, runOptimizer, fit, setTool, switchFloor, importScanFile, get heat() { return heat; }, get suggest() { return suggest; } };
})();
