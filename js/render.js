// 笔画渲染：根据笔压生成粗细变化的轮廓，并模拟起笔、收笔、出锋
const Render = (() => {
  const { clamp, lerp } = Geo;

  // 计算每个点的宽度
  function widths(stroke, opts) {
    const pts = stroke.pts, n = pts.length;
    const base = stroke.width;
    const brush = opts.brush;
    const w = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = clamp(pts[i].p, 0.05, 1);
      w[i] = brush ? base * (0.45 + 1.1 * p) : base * (0.8 + 0.4 * p);
    }
    if (brush && n > 4 && !opts.live) {
      // 起笔：稍微收一下再铺开
      const head = Math.min(4, Math.floor(n / 4));
      for (let i = 0; i < head; i++) w[i] *= lerp(0.7, 1, i / head);
      // 收笔：末端速度快则出锋（变尖），慢则顿笔（保持圆头）
      const tail = Math.min(Math.max(4, Math.floor(n * 0.22)), n - 1);
      let endSpeed = 0;
      for (let i = n - 1; i > n - tail; i--) endSpeed += Geo.dist(pts[i], pts[i - 1]);
      endSpeed /= tail;
      const avgStep = Geo.pathLength(pts) / (n - 1);
      const taper = stroke.sharpEnd ?? (pts[n - 1].p < pts[Math.max(0, n - tail)].p * 0.75 || endSpeed > avgStep * 1.15);
      if (taper) {
        for (let i = 0; i < tail; i++) {
          const t = i / tail;
          w[n - 1 - i] *= lerp(0.18, 1, Math.pow(t, 0.8));
        }
      }
    }
    return w;
  }

  function addCircle(path, x, y, r) {
    path.moveTo(x + r, y);
    path.arc(x, y, r, 0, Math.PI * 2, false);
  }

  // 生成笔画的填充路径（四边形 + 圆形关节，统一顺时针，用 nonzero 合并）
  function buildPath(stroke, opts) {
    const pts = stroke.pts, n = pts.length;
    const path = new Path2D();
    if (n === 0) return path;
    const w = widths(stroke, opts);
    if (n === 1) { addCircle(path, pts[0].x, pts[0].y, w[0] / 2); return path; }
    for (let i = 0; i < n; i++) addCircle(path, pts[i].x, pts[i].y, w[i] / 2);
    for (let i = 0; i < n - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
      if (L < 1e-3) continue;
      const nx = -dy / L, ny = dx / L;
      const ra = w[i] / 2, rb = w[i + 1] / 2;
      const q = [
        [a.x + nx * ra, a.y + ny * ra], [b.x + nx * rb, b.y + ny * rb],
        [b.x - nx * rb, b.y - ny * rb], [a.x - nx * ra, a.y - ny * ra],
      ];
      // 保证顺时针（屏幕坐标下面积为正）
      let area = 0;
      for (let k = 0; k < 4; k++) { const [x1, y1] = q[k], [x2, y2] = q[(k + 1) % 4]; area += x1 * y2 - x2 * y1; }
      if (area < 0) q.reverse();
      path.moveTo(q[0][0], q[0][1]);
      for (let k = 1; k < 4; k++) path.lineTo(q[k][0], q[k][1]);
      path.closePath();
    }
    return path;
  }

  function buildHighlighter(stroke) {
    const path = new Path2D();
    const pts = stroke.pts;
    if (!pts.length) return path;
    path.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
    if (pts.length === 1) path.lineTo(pts[0].x + 0.1, pts[0].y);
    return path;
  }

  function drawStroke(ctx, stroke, opts) {
    if (stroke.tool === 'highlighter') {
      if (!stroke._path) stroke._path = buildHighlighter(stroke);
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width * 5;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.stroke(stroke._path);
      ctx.restore();
      return;
    }
    const key = opts.brush ? 'b' : 'n';
    if (!stroke._path || stroke._pathKey !== key || opts.live) {
      stroke._path = buildPath(stroke, opts);
      stroke._pathKey = opts.live ? null : key;
    }
    ctx.fillStyle = stroke.color;
    ctx.fill(stroke._path, 'nonzero');
  }

  function drawPaper(ctx, view, paper, spacing, pageW) {
    const { scale, sx, sy, cssW, cssH } = view;
    ctx.save();
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.fillStyle = '#e9e5db';
    ctx.fillRect(0, 0, cssW, cssH);
    const left = (0 - sx) * scale, right = (pageW - sx) * scale;
    ctx.fillStyle = '#fffdf8';
    ctx.fillRect(left, 0, right - left, cssH);
    ctx.shadowColor = 'transparent';
    const y0 = sy, y1 = sy + cssH / scale;
    if (paper !== 'blank') {
      ctx.strokeStyle = paper === 'grid' ? '#e7e0cf' : '#dcd3bf';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = Math.floor(y0 / spacing); k * spacing <= y1; k++) {
        if (k < 1) continue;
        const y = Math.round((k * spacing - sy) * scale) + 0.5;
        ctx.moveTo(left, y); ctx.lineTo(right, y);
      }
      if (paper === 'grid') {
        for (let x = spacing; x < pageW; x += spacing) {
          const X = Math.round((x - sx) * scale) + 0.5;
          ctx.moveTo(X, 0); ctx.lineTo(X, cssH);
        }
      }
      ctx.stroke();
      if (paper === 'lines') {
        ctx.strokeStyle = '#efc9c4';
        ctx.beginPath();
        const X = Math.round((60 - sx) * scale) + 0.5;
        ctx.moveTo(X, 0); ctx.lineTo(X, cssH);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  return { drawStroke, drawPaper, buildPath };
})();
