// =============================================================
//  笔迹美化引擎
//  思路（全部本地计算，无需联网）：
//   1. 按横线把笔画分行；
//   2. 估计整行的倾斜角，做剪切变换把字“扶正”；
//   3. 每一笔：去抖平滑，检测转折点，把近似直线的段拉直，
//      接近水平/竖直的段吸附为“横平竖直”；
//   4. 把笔画聚类成“字”，统一字的大小、对齐到横线基线、字距均匀；
//   5. 按“美化强度”在原笔迹与美化结果之间插值。
// =============================================================
const Beautify = (() => {
  const { dist, lerp, clamp, pathLength, resample, smooth, bbox, unionBox, median } = Geo;
  const DEG = Math.PI / 180;

  const defaults = {
    strength: 0.8,
    straight: true,
    slant: true,
    align: true,
    spacing: true,
    lineHeight: 72,
    lineTop: 0,
  };

  // ---------- 单笔处理 ----------

  function pointCountFor(pts) {
    return clamp(Math.round(pathLength(pts) / 2.5), 6, 180);
  }

  // 检测转折点（折、钩）
  function findCorners(pts, k) {
    const n = pts.length;
    const ang = new Array(n).fill(0);
    for (let i = k; i < n - k; i++) {
      const a = pts[i - k], b = pts[i], c = pts[i + k];
      const v1x = b.x - a.x, v1y = b.y - a.y, v2x = c.x - b.x, v2y = c.y - b.y;
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
      if (l1 < 1e-6 || l2 < 1e-6) continue;
      const cos = clamp((v1x * v2x + v1y * v2y) / (l1 * l2), -1, 1);
      ang[i] = Math.acos(cos);
    }
    const corners = [];
    for (let i = k; i < n - k; i++) {
      if (ang[i] < 50 * DEG) continue;
      let isMax = true;
      for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) {
        if (ang[j] > ang[i] || (ang[j] === ang[i] && j < i)) { isMax = false; break; }
      }
      if (isMax) corners.push(i);
    }
    return corners;
  }

  // 一段是否“基本是直线”
  function isStraight(seg) {
    const a = seg[0], b = seg[seg.length - 1];
    const L = dist(a, b);
    if (L < 1) return false;
    let maxDev = 0;
    for (const p of seg) {
      const d = Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / L;
      if (d > maxDev) maxDev = d;
    }
    return maxDev < Math.max(1.5, 0.075 * L);
  }

  function linearFill(a, b, src) {
    const n = src.length;
    return src.map((p, i) => {
      const t = n === 1 ? 0 : i / (n - 1);
      return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), p: p.p };
    });
  }

  // 拉直 + 横平竖直
  function straightenStroke(pts, H, doStraight) {
    const len = pathLength(pts);
    let s = smooth(pts, 1.2);
    if (!doStraight || len < 0.12 * H) return smooth(s, 1.5); // 点：只平滑

    const step = len / (s.length - 1);
    const k = Math.max(2, Math.round((0.07 * H) / step));
    const corners = findCorners(s, k);
    const cuts = [0, ...corners, s.length - 1];

    const out = [];
    let shift = { x: 0, y: 0 };
    for (let j = 0; j < cuts.length - 1; j++) {
      const i0 = cuts[j], i1 = cuts[j + 1];
      const seg = s.slice(i0, i1 + 1);
      const oa = seg[0], ob = seg[seg.length - 1];
      let a = { x: oa.x + shift.x, y: oa.y + shift.y };
      let b = { x: ob.x + shift.x, y: ob.y + shift.y };
      const segLen = dist(oa, ob);
      let newSeg;

      if (seg.length >= 3 && isStraight(seg)) {
        const ang = Math.atan2(ob.y - oa.y, ob.x - oa.x);
        const absA = Math.abs(ang);
        const nearH = absA < 13 * DEG || absA > 167 * DEG;
        const nearV = Math.abs(absA - 90 * DEG) < 13 * DEG;
        // 太短的段（钩、提）不吸附方向，避免变形
        if (segLen > 0.18 * H) {
          if (nearH) {
            // 横：首段绕中点放平，后续段从起点放平；保留一点点右上扬，更像手写
            const rise = b.x > a.x ? Math.tan(2 * DEG) * (b.x - a.x) : 0;
            if (j === 0) {
              const my = (a.y + b.y) / 2;
              a.y = my + rise / 2; b.y = my - rise / 2;
            } else {
              b.y = a.y - rise;
            }
          } else if (nearV) {
            if (j === 0) {
              const mx = (a.x + b.x) / 2;
              a.x = mx; b.x = mx;
            } else {
              b.x = a.x;
            }
          }
        }
        newSeg = linearFill(a, b, seg);
      } else {
        newSeg = smooth(seg, 1.8).map(p => ({ x: p.x + shift.x, y: p.y + shift.y, p: p.p }));
        if (j > 0) { newSeg[0].x = a.x; newSeg[0].y = a.y; }
      }

      shift = { x: newSeg[newSeg.length - 1].x - ob.x, y: newSeg[newSeg.length - 1].y - ob.y };
      if (j > 0) newSeg.shift(); // 拐点共享
      out.push(...newSeg);
    }
    // 压力也平滑一下，粗细过渡更自然
    const ps = smooth(out.map(p => ({ x: p.p, y: 0, p: 0 })), 2);
    out.forEach((p, i) => (p.p = ps[i].x));
    return out;
  }

  // ---------- 整行估计 ----------

  // 估计倾斜：统计接近竖直的线段的 dx/dy
  function estimateShear(items) {
    let sum = 0, wsum = 0;
    for (const it of items) {
      const p = it.base;
      const st = Math.max(1, Math.round(p.length / 20));
      for (let i = st; i < p.length; i += st) {
        const dx = p[i].x - p[i - st].x, dy = p[i].y - p[i - st].y;
        const L = Math.hypot(dx, dy);
        if (L < 0.5 || Math.abs(dy) < 2 * Math.abs(dx)) continue;
        sum += (dx / dy) * L;
        wsum += L;
      }
    }
    return wsum > 0 ? { shear: clamp(sum / wsum, -0.45, 0.45), weight: wsum } : { shear: 0, weight: 0 };
  }

  // 把一行笔画聚成“字”
  function clusterChars(items, S0) {
    const sorted = [...items].sort((a, b) => a.box.minX - b.box.minX);
    let clusters = [];
    for (const it of sorted) {
      const cur = clusters[clusters.length - 1];
      if (cur) {
        const merged = unionBox(cur.box, it.box);
        if (it.box.minX < cur.box.maxX + 0.04 * S0 && merged.w <= 1.3 * S0) {
          cur.items.push(it); cur.box = merged; continue;
        }
      }
      clusters.push({ items: [it], box: it.box });
    }
    // 左右结构的字（好、川、引）常被拆开：合并相邻的窄块
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i + 1 < clusters.length; i++) {
        const a = clusters[i], b = clusters[i + 1];
        const gap = b.box.minX - a.box.maxX;
        const merged = unionBox(a.box, b.box);
        if (a.box.w < 0.72 * S0 && b.box.w < 0.72 * S0 && gap < 0.3 * S0 && merged.w <= 1.05 * S0 &&
            Math.max(a.box.h, b.box.h) > 0.35 * S0) {
          a.items.push(...b.items); a.box = merged;
          clusters.splice(i + 1, 1);
          changed = true; break;
        }
      }
    }
    return clusters;
  }

  function charSize(box, S0) {
    return box.w <= 1.4 * S0 ? Math.max(box.h, box.w * 0.9) : box.h;
  }

  function processLine(items, lineIdx, o, out) {
    const H = o.lineHeight;
    // 估计这一行的字高
    const tops = items.map(i => i.box.minY).sort((a, b) => a - b);
    const bots = items.map(i => i.box.maxY).sort((a, b) => a - b);
    const pick = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(q * (arr.length - 1)))];
    const S0 = Math.max(0.2 * H, pick(bots, 0.9) - pick(tops, 0.1));
    const lineCY = (pick(bots, 0.9) + pick(tops, 0.1)) / 2;

    // 1) 纠正倾斜
    let shear = 0;
    if (o.slant) {
      const est = estimateShear(items);
      if (est.weight > 0.5 * S0) shear = est.shear;
    }
    for (const it of items) {
      const sheared = it.base.map(p => ({ x: p.x - shear * (p.y - lineCY), y: p.y, p: p.p }));
      it.work = straightenStroke(sheared, S0, o.straight);
      it.box = bbox(it.work);
    }

    // 2) 聚成字
    const clusters = clusterChars(items, S0);
    clusters.forEach(c => { c.size = charSize(c.box, S0); });
    const maxSize = Math.max(...clusters.map(c => c.size));
    const big = clusters.filter(c => c.size >= 0.5 * maxSize && c.size >= 0.35 * S0);
    const S = big.length ? median(big.map(c => c.size)) : S0;

    // 3) 目标字高与基线
    const T = o.align ? clamp(S, 0.45 * H, 0.7 * H) : S;
    const k = T / S;
    const baseline = o.lineTop + (lineIdx + 1) * H - 0.16 * H;
    const bigCenterY = baseline - T / 2;

    // 原行中心线（拟合大字中心）用来放置标点等小字
    let fitA = lineCY, fitB = 0;
    if (big.length >= 2) {
      const xs = big.map(c => c.box.cx), ys = big.map(c => c.box.cy);
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let num = 0, den = 0;
      xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; });
      fitB = den > 1e-6 ? clamp(num / den, -0.3, 0.3) : 0;
      fitA = my - fitB * mx;
    } else if (big.length === 1) fitA = big[0].box.cy;

    // 4) 每个字的缩放、位置
    const gaps = [];
    for (let i = 1; i < clusters.length; i++) gaps.push(clusters[i].box.minX - clusters[i - 1].box.maxX);
    const normalGaps = gaps.filter(g => g < 0.6 * S);
    const gNatural = clamp((normalGaps.length ? median(normalGaps) : 0.15 * S) * k, 0.05 * T, 0.32 * T);
    const gTarget = lerp(gNatural, 0.2 * T, 0.6);

    let cursor = null;
    clusters.forEach((c, i) => {
      const isBig = big.includes(c);
      let ki = k;
      if (o.align && isBig) ki = clamp(k * Math.pow(S / c.size, 0.7), 0.6 * k, 1.6 * k);
      const newW = c.box.w * ki;

      let ncy;
      if (!o.align) ncy = c.box.cy;
      else if (isBig) ncy = bigCenterY;
      else {
        const rel = (c.box.cy - (fitA + fitB * c.box.cx)) / S;
        ncy = bigCenterY + rel * T;
      }

      let ncx;
      if (!o.spacing) ncx = c.box.cx;
      else if (cursor === null) ncx = c.box.minX + newW / 2;
      else {
        const g = gaps[i - 1] * k;
        let gap;
        if (g > 1.1 * T) gap = 0.55 * T;                       // 明显留空：保留一个小空格
        else gap = isBig ? gTarget : gTarget * 0.6;
        ncx = cursor + gap + newW / 2;
      }
      cursor = ncx + newW / 2;

      const { cx, cy } = c.box;
      for (const it of c.items) {
        it.work = it.work.map(p => ({ x: (p.x - cx) * ki + ncx, y: (p.y - cy) * ki + ncy, p: p.p }));
      }
    });
    for (const it of items) out.set(it.stroke.id, { base: it.base, target: it.work });
  }

  /**
   * 计算美化结果
   * @param strokes  要处理的笔画（会读取 stroke.orig 或 stroke.pts）
   * @returns Map<id, {base, target}>  base/target 点数相同，可直接插值
   */
  function compute(strokes, options) {
    const o = { ...defaults, ...options };
    const H = o.lineHeight;
    const out = new Map();
    const lines = new Map();

    for (const st of strokes) {
      const src = st.orig || st.pts;
      if (!src || src.length < 2) continue;
      const base = resample(src, pointCountFor(src));
      const box = bbox(base);
      if (st.tool !== 'pen') continue;
      // 图形 / 涂鸦：只平滑拉直，不参与排版
      if (box.h > 1.6 * H || box.w > 4 * H) {
        out.set(st.id, { base, target: straightenStroke(base, H, o.straight) });
        continue;
      }
      const idx = Math.floor((box.cy - o.lineTop) / H);
      if (!lines.has(idx)) lines.set(idx, []);
      lines.get(idx).push({ stroke: st, base, box });
    }
    for (const [idx, items] of lines) processLine(items, idx, o, out);
    return out;
  }

  // 按强度插值
  function blend(base, target, t) {
    return base.map((b, i) => ({
      x: lerp(b.x, target[i].x, t),
      y: lerp(b.y, target[i].y, t),
      p: lerp(b.p, target[i].p, t),
    }));
  }

  return { compute, blend, defaults };
})();
