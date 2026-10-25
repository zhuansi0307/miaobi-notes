// 几何工具函数。点格式：{x, y, p}（p = 笔压 0~1）
const Geo = (() => {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function pathLength(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
    return L;
  }

  // 按弧长均匀重采样为 n 个点
  function resample(pts, n) {
    if (pts.length === 0) return [];
    if (pts.length === 1 || n < 2) return Array.from({ length: Math.max(n, 1) }, () => ({ ...pts[0] }));
    const total = pathLength(pts);
    if (total < 1e-6) return Array.from({ length: n }, () => ({ ...pts[0] }));
    const step = total / (n - 1);
    const out = [{ ...pts[0] }];
    let acc = 0, target = step;
    for (let i = 1; i < pts.length && out.length < n - 1; i++) {
      const a = pts[i - 1], b = pts[i], d = dist(a, b);
      while (d > 0 && acc + d >= target && out.length < n - 1) {
        const t = (target - acc) / d;
        out.push({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), p: lerp(a.p, b.p, t) });
        target += step;
      }
      acc += d;
    }
    while (out.length < n) out.push({ ...pts[pts.length - 1] });
    out[n - 1] = { ...pts[pts.length - 1] };
    return out;
  }

  // 高斯平滑（端点固定）
  function smooth(pts, sigma) {
    if (pts.length < 4 || sigma <= 0) return pts.map(p => ({ ...p }));
    const r = Math.ceil(sigma * 2.5);
    const w = [];
    for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
    const n = pts.length;
    return pts.map((p, i) => {
      if (i === 0 || i === n - 1) return { ...p };
      // 靠近端点时缩小窗口，避免端点被“拉回”
      const rr = Math.min(r, i, n - 1 - i);
      let sx = 0, sy = 0, sp = 0, sw = 0;
      for (let k = -rr; k <= rr; k++) {
        const q = pts[i + k], ww = w[k + r];
        sx += q.x * ww; sy += q.y * ww; sp += q.p * ww; sw += ww;
      }
      return { x: sx / sw, y: sy / sw, p: sp / sw };
    });
  }

  function bbox(pts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }

  function unionBox(a, b) {
    const minX = Math.min(a.minX, b.minX), minY = Math.min(a.minY, b.minY);
    const maxX = Math.max(a.maxX, b.maxX), maxY = Math.max(a.maxY, b.maxY);
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }

  // 点到线段距离
  function distToSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    if (L2 === 0) return dist(p, a);
    const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / L2, 0, 1);
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function pointInPolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  return { dist, lerp, clamp, pathLength, resample, smooth, bbox, unionBox, distToSeg, pointInPolygon, median };
})();
