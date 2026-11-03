/* Wi-Fi Map – data model, geometry and signal propagation model.
 * Everything is in metres. World Y grows downwards (same as the screen).
 */
(function () {
  'use strict';
  const WM = (window.WM = window.WM || {});

  let uidCounter = 0;
  WM.uid = (p = 'i') => p + Date.now().toString(36) + (++uidCounter).toString(36) + Math.random().toString(36).slice(2, 5);

  WM.BANDS = {
    '2.4': { label: '2.4 GHz', mhz: 2437 },
    '5': { label: '5 GHz', mhz: 5500 },
    '6': { label: '6 GHz', mhz: 6100 },
  };

  // Typical penetration losses in dB per band. These are averages from published
  // indoor measurements; real walls vary, which is what survey calibration is for.
  WM.MATERIALS = {
    drywall:    { name: 'Drywall / plasterboard', color: '#94a3b8', thick: 0.10, loss: { '2.4': 3,  '5': 4,  '6': 5 } },
    wood:       { name: 'Timber / stud wall',     color: '#b45309', thick: 0.12, loss: { '2.4': 4,  '5': 6,  '6': 7 } },
    door:       { name: 'Wooden door',            color: '#d97706', thick: 0.05, loss: { '2.4': 3,  '5': 4,  '6': 5 } },
    glass:      { name: 'Glass / window',         color: '#38bdf8', thick: 0.04, loss: { '2.4': 2,  '5': 3,  '6': 4 } },
    lowe:       { name: 'Low-E / coated glass',   color: '#0ea5e9', thick: 0.04, loss: { '2.4': 12, '5': 20, '6': 24 } },
    brick:      { name: 'Brick',                  color: '#b91c1c', thick: 0.25, loss: { '2.4': 8,  '5': 12, '6': 15 } },
    block:      { name: 'Breeze block / tiled',   color: '#9f1239', thick: 0.20, loss: { '2.4': 10, '5': 15, '6': 18 } },
    concrete:   { name: 'Concrete',               color: '#57534e', thick: 0.25, loss: { '2.4': 15, '5': 22, '6': 26 } },
    reinforced: { name: 'Reinforced concrete',    color: '#292524', thick: 0.30, loss: { '2.4': 22, '5': 30, '6': 35 } },
    stone:      { name: 'Stone (thick)',          color: '#78716c', thick: 0.40, loss: { '2.4': 15, '5': 22, '6': 26 } },
    metal:      { name: 'Metal (fridge, steel)',  color: '#1e3a8a', thick: 0.08, loss: { '2.4': 26, '5': 32, '6': 35 } },
    hedge:      { name: 'Trees / hedge',          color: '#15803d', thick: 0.30, loss: { '2.4': 4,  '5': 6,  '6': 7 } },
  };

  WM.FLOOR_TYPES = {
    wood:     { name: 'Timber floors', loss: { '2.4': 8,  '5': 12, '6': 14 } },
    concrete: { name: 'Concrete floors', loss: { '2.4': 18, '5': 26, '6': 30 } },
  };

  WM.ENVIRONMENTS = {
    open:      { name: 'Open plan, little furniture', n: 2.0 },
    typical:   { name: 'Typical furnished home',      n: 2.3 },
    cluttered: { name: 'Cluttered / heavy furniture', n: 2.7 },
  };

  // Default EIRP (transmit power + antenna gain) in dBm.
  WM.DEVICE_TYPES = {
    router:   { name: 'Router',        letter: 'R', color: '#2563eb', eirp: { '2.4': 20, '5': 23, '6': 23 } },
    mesh:     { name: 'Mesh node',     letter: 'M', color: '#7c3aed', eirp: { '2.4': 20, '5': 23, '6': 23 } },
    ap:       { name: 'Access point',  letter: 'A', color: '#0891b2', eirp: { '2.4': 20, '5': 23, '6': 23 } },
    extender: { name: 'Extender',      letter: 'E', color: '#db2777', eirp: { '2.4': 18, '5': 20, '6': 20 } },
  };

  WM.PRIORITIES = { 0: 'Ignore', 1: 'Normal', 2: 'Important' };

  WM.defaultSettings = () => ({
    band: '5',
    env: 'typical',
    good: -67,
    fair: -75,
    floorHeight: 2.8,
    floorType: 'wood',
    calib: 0,
    opacity: 0.55,
    smooth: true,
    showHeat: true,
    snapAngle: true,
    backhaul: 'wireless',
    backhaulMin: -67,
    targetCoverage: 95,
    maxNewAps: 3,
  });

  WM.newFloor = (name) => ({ id: WM.uid('f'), name, bg: null, walls: [], zones: [], survey: [] });

  WM.newProject = () => ({
    version: 1,
    name: 'My home',
    floors: [WM.newFloor('Ground floor')],
    aps: [],
    settings: WM.defaultSettings(),
  });

  /* ---------------- geometry ---------------- */
  WM.Geo = {
    distToSeg(px, py, ax, ay, bx, by) {
      const vx = bx - ax, vy = by - ay;
      const L = vx * vx + vy * vy;
      let t = L ? ((px - ax) * vx + (py - ay) * vy) / L : 0;
      t = Math.max(0, Math.min(1, t));
      const x = ax + t * vx, y = ay + t * vy;
      return { d: Math.hypot(px - x, py - y), t, x, y };
    },
    pointInPoly(x, y, pts) {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    },
    bbox(pts) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) {
        if (p[0] < x0) x0 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[0] > x1) x1 = p[0];
        if (p[1] > y1) y1 = p[1];
      }
      return { x0, y0, x1, y1 };
    },
    polyArea(pts) {
      let a = 0;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
      return Math.abs(a / 2);
    },
    centroid(pts) {
      let x = 0, y = 0;
      for (const p of pts) { x += p[0]; y += p[1]; }
      return [x / pts.length, y / pts.length];
    },
  };

  /* ---------------- propagation ----------------
   * Multi-wall model (COST-231 Motley-Keenan style):
   *   RSSI = EIRP - FSPL(1 m) - 10·n·log10(d) - Σ wall losses - floors·floorLoss + calibration
   */
  class Engine {
    constructor(project) {
      const s = project.settings;
      this.band = s.band;
      this.n = (WM.ENVIRONMENTS[s.env] || WM.ENVIRONMENTS.typical).n;
      this.fspl1 = 20 * Math.log10(WM.BANDS[s.band].mhz) - 27.55;
      this.calib = +s.calib || 0;
      this.floorH = +s.floorHeight || 2.8;
      this.floorLoss = (WM.FLOOR_TYPES[s.floorType] || WM.FLOOR_TYPES.wood).loss[s.band];
      this.fidx = new Map();
      project.floors.forEach((f, i) => this.fidx.set(f.id, i));
      this.walls = project.floors.map((f) => Engine.pack(f.walls, s.band));
    }
    static pack(walls, band) {
      const a = new Float64Array(walls.length * 5);
      walls.forEach((w, i) => {
        const m = WM.MATERIALS[w.material] || WM.MATERIALS.drywall;
        a[i * 5] = w.x1; a[i * 5 + 1] = w.y1; a[i * 5 + 2] = w.x2; a[i * 5 + 3] = w.y2; a[i * 5 + 4] = m.loss[band];
      });
      return a;
    }
    floorOf(dev) {
      const i = this.fidx.get(dev.floorId);
      return i === undefined ? 0 : i;
    }
    wallLoss(fi, ax, ay, bx, by) {
      const W = this.walls[fi];
      if (!W || !W.length) return 0;
      const minx = ax < bx ? ax : bx, maxx = ax < bx ? bx : ax;
      const miny = ay < by ? ay : by, maxy = ay < by ? by : ay;
      const rx = bx - ax, ry = by - ay;
      let loss = 0;
      for (let i = 0; i < W.length; i += 5) {
        const cx = W[i], cy = W[i + 1], dx = W[i + 2], dy = W[i + 3];
        if ((cx < minx && dx < minx) || (cx > maxx && dx > maxx) || (cy < miny && dy < miny) || (cy > maxy && dy > maxy)) continue;
        const sx = dx - cx, sy = dy - cy;
        const den = rx * sy - ry * sx;
        if (den === 0) continue;
        const qx = cx - ax, qy = cy - ay;
        const t = (qx * sy - qy * sx) / den;
        if (t <= 0 || t >= 1) continue;
        const u = (qx * ry - qy * rx) / den;
        if (u < 0 || u > 1) continue;
        loss += W[i + 4];
      }
      return loss;
    }
    eirp(dev) {
      const e = dev.eirp ? dev.eirp[this.band] : undefined;
      if (e !== undefined && e !== null && e !== '' && Number.isFinite(+e)) return +e;
      return (WM.DEVICE_TYPES[dev.type] || WM.DEVICE_TYPES.ap).eirp[this.band];
    }
    /** Path gain (negative dB) between a transmitter on floor af and a point on floor fi. */
    pathGain(af, ax, ay, fi, x, y) {
      const dz = (fi - af) * this.floorH;
      const dx = x - ax, dy = y - ay;
      const d = Math.max(0.5, Math.sqrt(dx * dx + dy * dy + dz * dz));
      let L = this.fspl1 + 10 * this.n * Math.log10(d);
      if (fi === af) L += this.wallLoss(fi, ax, ay, x, y);
      else L += Math.abs(fi - af) * this.floorLoss + Math.max(this.wallLoss(fi, ax, ay, x, y), this.wallLoss(af, ax, ay, x, y));
      return -L;
    }
    rssi(dev, fi, x, y) {
      return this.eirp(dev) + this.calib + this.pathGain(this.floorOf(dev), dev.x, dev.y, fi, x, y);
    }
  }
  WM.Engine = Engine;

  /** 2 = good (green), 1 = fair (amber), 0 = poor (red) */
  WM.classify = (v, s) => (v >= s.good ? 2 : v >= s.fair ? 1 : 0);
  WM.CLASS_NAMES = ['Poor', 'Fair', 'Good'];
  WM.CLASS_COLORS = [[239, 68, 68], [245, 158, 11], [34, 197, 94]];

  /** Area that should be analysed on a floor. */
  WM.floorRegion = function (project, fi) {
    const f = project.floors[fi];
    let bb = null;
    const add = (x, y) => {
      if (!bb) bb = { x0: x, y0: y, x1: x, y1: y };
      else {
        if (x < bb.x0) bb.x0 = x;
        if (y < bb.y0) bb.y0 = y;
        if (x > bb.x1) bb.x1 = x;
        if (y > bb.y1) bb.y1 = y;
      }
    };
    const pad = (b, p) => ({ x0: b.x0 - p, y0: b.y0 - p, x1: b.x1 + p, y1: b.y1 + p });
    if (f.zones.length) {
      for (const z of f.zones) for (const p of z.pts) add(p[0], p[1]);
      return pad(bb, 0.1);
    }
    for (const w of f.walls) { add(w.x1, w.y1); add(w.x2, w.y2); }
    if (bb) {
      for (const d of project.aps) if (d.floorId === f.id) add(d.x, d.y);
      return pad(bb, 1);
    }
    if (f.bg) return { x0: f.bg.x, y0: f.bg.y, x1: f.bg.x + f.bg.w * f.bg.mpp, y1: f.bg.y + f.bg.h * f.bg.mpp };
    for (const g of project.floors) for (const w of g.walls) { add(w.x1, w.y1); add(w.x2, w.y2); }
    for (const d of project.aps) add(d.x, d.y);
    if (bb) return pad(bb, bb.x1 - bb.x0 < 1 ? 8 : 1);
    return null;
  };

  /**
   * Coverage grid for one floor. Returns best RSSI per cell plus statistics.
   * vals is NaN outside drawn zones (when the floor has zones).
   */
  WM.computeCoverage = function (project, fi, devices, maxCells) {
    const reg = WM.floorRegion(project, fi);
    if (!reg || !devices.length) return null;
    const s = project.settings;
    const w = reg.x1 - reg.x0, h = reg.y1 - reg.y0;
    if (w <= 0 || h <= 0) return null;
    const res = Math.max(0.05, Math.sqrt((w * h) / (maxCells || 40000)));
    const cols = Math.max(1, Math.ceil(w / res)), rows = Math.max(1, Math.ceil(h / res));
    const eng = new Engine(project);
    const zones = project.floors[fi].zones;
    const zb = zones.map((z) => WM.Geo.bbox(z.pts));
    const devs = devices.map((d) => ({ af: eng.floorOf(d), x: d.x, y: d.y, p: eng.eirp(d) + eng.calib }));
    const vals = new Float32Array(cols * rows);
    const zid = new Int16Array(cols * rows).fill(-1);
    const total = [0, 0, 0];
    const perZone = zones.map(() => [0, 0, 0]);
    for (let r = 0; r < rows; r++) {
      const y = reg.y0 + (r + 0.5) * res;
      for (let c = 0; c < cols; c++) {
        const x = reg.x0 + (c + 0.5) * res;
        const i = r * cols + c;
        let z = -1;
        if (zones.length) {
          for (let k = 0; k < zones.length; k++) {
            const b = zb[k];
            if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
            if (WM.Geo.pointInPoly(x, y, zones[k].pts)) { z = k; break; }
          }
          if (z < 0) { vals[i] = NaN; continue; }
        }
        let best = -999;
        for (const d of devs) {
          const v = d.p + eng.pathGain(d.af, d.x, d.y, fi, x, y);
          if (v > best) best = v;
        }
        vals[i] = best;
        zid[i] = z;
        const cl = WM.classify(best, s);
        if (z >= 0) {
          perZone[z][cl]++;
          if ((zones[z].priority ?? 1) > 0) total[cl]++;
        } else total[cl]++;
      }
    }
    return { x0: reg.x0, y0: reg.y0, res, cols, rows, vals, zid, total, perZone, fi };
  };

  /** Simple channel plan: greedily give nearby devices different channels. */
  WM.channelPlan = function (project) {
    const eng = new Engine(project);
    const devs = project.aps.slice();
    const sets = { '2.4': [1, 6, 11], '5': [36, 52, 100, 149], '6': [37, 53, 69, 85] };
    const out = {};
    for (const band of Object.keys(sets)) {
      const chans = sets[band];
      const assigned = [];
      for (const d of devs) {
        let bestCh = chans[0], bestCost = Infinity;
        for (const ch of chans) {
          let cost = 0;
          for (const a of assigned) {
            if (a.ch !== ch) continue;
            const dz = (eng.floorOf(d) - eng.floorOf(a.d)) * eng.floorH;
            cost += 1 / (1 + (d.x - a.d.x) ** 2 + (d.y - a.d.y) ** 2 + dz * dz);
          }
          if (cost < bestCost) { bestCost = cost; bestCh = ch; }
        }
        assigned.push({ d, ch: bestCh });
        (out[d.id] = out[d.id] || {})[band] = bestCh;
      }
    }
    return out;
  };
})();
