/* Wi-Fi Map – router / access point placement optimiser.
 * Samples candidate positions inside the home, pre-computes the signal from every
 * candidate to a grid of evaluation points, then:
 *  - "router": ranks single positions for the router
 *  - "aps": greedily adds access points to the current setup, then refines them.
 */
(function () {
  'use strict';
  const WM = window.WM;
  const tick = () => new Promise((r) => setTimeout(r, 0));

  /** Grid-sample points inside zones (or the floor region) across all floors. */
  function samplePoints(project, maxN, forEval) {
    const areas = [];
    project.floors.forEach((f, fi) => {
      if (f.zones.length) {
        for (const z of f.zones) {
          const pr = z.priority ?? 1;
          if (forEval && pr <= 0) continue;
          areas.push({ fi, pts: z.pts, w: Math.max(pr, 0.5) });
        }
      } else {
        const r = WM.floorRegion(project, fi);
        if (r && f.walls.length) areas.push({ fi, pts: [[r.x0 + 1, r.y0 + 1], [r.x1 - 1, r.y0 + 1], [r.x1 - 1, r.y1 - 1], [r.x0 + 1, r.y1 - 1]], w: 1 });
      }
    });
    const total = areas.reduce((a, z) => a + WM.Geo.polyArea(z.pts), 0);
    if (!total) return [];
    const step = Math.max(0.2, Math.sqrt(total / maxN));
    const out = [];
    for (const a of areas) {
      const b = WM.Geo.bbox(a.pts);
      let added = 0;
      for (let y = b.y0 + step / 2; y < b.y1; y += step)
        for (let x = b.x0 + step / 2; x < b.x1; x += step)
          if (WM.Geo.pointInPoly(x, y, a.pts)) { out.push({ x, y, fi: a.fi, w: a.w }); added++; }
      if (!added) { const c = WM.Geo.centroid(a.pts); out.push({ x: c[0], y: c[1], fi: a.fi, w: a.w }); }
    }
    return out;
  }

  WM.optimize = async function (project, opts, onProgress) {
    const s = project.settings;
    const eng = new WM.Engine(project);
    const good = s.good, fair = s.fair;
    const E = samplePoints(project, 2500, true);
    const C = samplePoints(project, 360, false);
    if (!E.length || !C.length) throw new Error('Nothing to cover yet. Draw walls or rooms first (or try the demo).');
    const nE = E.length;
    const W = new Float32Array(nE);
    let wSum = 0;
    E.forEach((e, j) => { W[j] = e.w; wSum += e.w; });

    const util = (v) => (v >= good ? 1 : v >= fair ? 0.4 : 0) + 0.002 * Math.min(1, Math.max(0, (v + 95) / 50));
    const scoreOf = (arr) => { let t = 0; for (let j = 0; j < nE; j++) t += W[j] * util(arr[j]); return t; };
    const statsOf = (arr) => {
      const c = [0, 0, 0];
      for (let j = 0; j < nE; j++) c[WM.classify(arr[j], s)] += W[j];
      return { good: c[2] / wSum, fair: c[1] / wSum, poor: c[0] / wSum };
    };

    // Path gain matrix candidates × eval points (independent of transmit power).
    const G = new Array(C.length);
    for (let i = 0; i < C.length; i++) {
      const c = C[i];
      const g = new Float32Array(nE);
      for (let j = 0; j < nE; j++) { const e = E[j]; g[j] = eng.pathGain(c.fi, c.x, c.y, e.fi, e.x, e.y); }
      G[i] = g;
      if (i % 12 === 0) { onProgress && onProgress(0.75 * (i / C.length)); await tick(); }
    }
    const fid = (fi) => project.floors[fi].id;
    const far = (a, b, minD) => a.fi !== b.fi || Math.hypot(a.x - b.x, a.y - b.y) >= minD;

    if (opts.mode === 'router') {
      const router = project.aps.find((d) => d.type === 'router');
      const p = eng.eirp(router || { type: 'router' }) + eng.calib;
      const ranked = C.map((c, i) => {
        let t = 0; const g = G[i];
        for (let j = 0; j < nE; j++) t += W[j] * util(p + g[j]);
        return { i, t };
      }).sort((a, b) => b.t - a.t);
      const spots = [];
      for (const r of ranked) {
        if (spots.length >= 3) break;
        if (spots.every((sp) => far(C[sp.i], C[r.i], 2.5))) spots.push(r);
      }
      let before = null;
      if (router) {
        const arr = new Float32Array(nE);
        for (let j = 0; j < nE; j++) arr[j] = eng.rssi(router, E[j].fi, E[j].x, E[j].y);
        before = statsOf(arr);
      }
      onProgress && onProgress(1);
      return {
        mode: 'router',
        before,
        spots: spots.map((sp) => {
          const arr = new Float32Array(nE);
          for (let j = 0; j < nE; j++) arr[j] = p + G[sp.i][j];
          return { x: C[sp.i].x, y: C[sp.i].y, floorId: fid(C[sp.i].fi), stats: statsOf(arr) };
        }),
      };
    }

    // ---- access points ----
    if (!project.aps.length) throw new Error('Place your router first (Device tool), or use "Best router spot".');
    const base = new Float32Array(nE).fill(-999);
    for (const d of project.aps)
      for (let j = 0; j < nE; j++) { const v = eng.rssi(d, E[j].fi, E[j].x, E[j].y); if (v > base[j]) base[j] = v; }
    const apType = opts.backhaul === 'wireless' ? 'mesh' : 'ap';
    const pAp = eng.eirp({ type: apType }) + eng.calib;
    const wireless = opts.backhaul === 'wireless';
    const bhMin = +opts.backhaulMin;

    // Backhaul signal from existing devices to each candidate.
    const bhBase = new Float32Array(C.length).fill(-999);
    for (const d of project.aps)
      for (let i = 0; i < C.length; i++) { const v = eng.rssi(d, C[i].fi, C[i].x, C[i].y); if (v > bhBase[i]) bhBase[i] = v; }
    const candGain = new Map(); // candidate -> Float32Array of gains to all other candidates
    const gainFrom = (k) => {
      if (!candGain.has(k)) {
        const a = new Float32Array(C.length);
        for (let i = 0; i < C.length; i++) a[i] = pAp + eng.pathGain(C[k].fi, C[k].x, C[k].y, C[i].fi, C[i].x, C[i].y);
        candGain.set(k, a);
      }
      return candGain.get(k);
    };
    const existing = project.aps.map((d) => ({ x: d.x, y: d.y, fi: eng.floorOf(d) }));

    const coverageWith = (list) => {
      const arr = base.slice();
      for (const k of list) { const g = G[k]; for (let j = 0; j < nE; j++) { const v = pAp + g[j]; if (v > arr[j]) arr[j] = v; } }
      return arr;
    };
    const backhaulWith = (list) => {
      const bh = bhBase.slice();
      for (const k of list) { const g = gainFrom(k); for (let i = 0; i < C.length; i++) if (g[i] > bh[i]) bh[i] = g[i]; }
      return bh;
    };
    const bestAddition = (cur, bh, others) => {
      let best = -1, bestScore = -Infinity;
      for (let i = 0; i < C.length; i++) {
        if (wireless && bh[i] < bhMin) continue;
        const c = C[i];
        if (!existing.every((e) => far(e, c, 2))) continue;
        if (!others.every((k) => far(C[k], c, 2))) continue;
        const g = G[i];
        let t = 0;
        for (let j = 0; j < nE; j++) { const v = pAp + g[j]; t += W[j] * util(v > cur[j] ? v : cur[j]); }
        if (t > bestScore) { bestScore = t; best = i; }
      }
      return { best, bestScore };
    };

    const target = (+opts.targetCoverage || 95) / 100;
    const maxNew = Math.max(0, Math.min(8, +opts.maxNew || 0));
    const added = [];
    let cur = base.slice();
    let curScore = scoreOf(cur);
    for (let k = 0; k < maxNew; k++) {
      if (statsOf(cur).good >= target) break;
      const { best, bestScore } = bestAddition(cur, backhaulWith(added), added);
      if (best < 0 || bestScore <= curScore + 0.002 * wSum) break;
      added.push(best);
      cur = coverageWith(added);
      curScore = bestScore;
      onProgress && onProgress(0.75 + 0.15 * ((k + 1) / maxNew));
      await tick();
    }
    // Refinement: move each new AP to its best spot given the others.
    for (let pass = 0; pass < 2; pass++) {
      let changed = false;
      for (let k = 0; k < added.length; k++) {
        const others = added.filter((_, i) => i !== k);
        const { best, bestScore } = bestAddition(coverageWith(others), backhaulWith(others), others);
        if (best >= 0 && best !== added[k] && bestScore > curScore + 1e-6) { added[k] = best; curScore = bestScore; changed = true; }
      }
      await tick();
      if (!changed) break;
    }
    cur = coverageWith(added);
    const bhFinal = added.map((k, i) => backhaulWith(added.filter((_, x) => x !== i))[k]);
    onProgress && onProgress(1);
    return {
      mode: 'aps',
      apType,
      before: statsOf(base),
      after: statsOf(cur),
      newAps: added.map((k, i) => ({ x: C[k].x, y: C[k].y, floorId: fid(C[k].fi), backhaul: bhFinal[i] })),
    };
  };
})();
