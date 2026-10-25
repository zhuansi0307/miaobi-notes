// =============================================================
//  妙笔笔记 —— 主程序
// =============================================================
(() => {
  const PAGE_W = 1000;           // 页面逻辑宽度（单位）
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const { clamp, bbox, dist, resample, lerp } = Geo;

  // ---------- 设置（持久化） ----------
  const SETTINGS_KEY = 'miaobi-settings';
  const settings = Object.assign({
    tool: 'pen', color: '#1f1f1f', width: 3, hlColor: '#ffd84d',
    auto: true, strength: 80, straight: true, slant: true, align: true, spacing: true, brush: true,
    finger: false,
  }, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
  const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

  const PEN_COLORS = ['#1f1f1f', '#1d4fa3', '#c0392b', '#1e7d4f', '#7a4b9c'];
  const HL_COLORS = ['#ffd84d', '#8fe388', '#ff9fb2', '#8cc8ff'];

  // ---------- 状态 ----------
  let note = null;               // 当前笔记
  let strokes = [];              // 当前笔画（按 id 排序）
  let undoStack = [], redoStack = [];
  let selection = new Set();
  let penSeen = false;
  const view = { zoom: 1, scale: 1, sx: 0, sy: 0, cssW: 0, cssH: 0, dpr: 1 };

  const stage = $('#stage');
  const baseCv = $('#baseCanvas'), liveCv = $('#liveCanvas');
  const bctx = baseCv.getContext('2d');
  const lctx = liveCv.getContext('2d', { desynchronized: true });

  // ---------- 小工具 ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 1800);
  }
  const renderOpts = () => ({ brush: settings.brush });
  function setPts(s, pts) { s.pts = pts; s._path = null; s._box = null; }
  function boxOf(s) { return s._box || (s._box = bbox(s.pts)); }
  const snapshot = s => ({ id: s.id, tool: s.tool, color: s.color, width: s.width, pts: s.pts, orig: s.orig, beautified: s.beautified, sharpEnd: s.sharpEnd });
  const restoreSnap = s => ({ ...s, _path: null, _box: null });
  const sortStrokes = () => strokes.sort((a, b) => a.id - b.id);

  // =============================================================
  //  笔记列表
  // =============================================================
  async function showHome() {
    if (note) await saveNow();
    note = null;
    $('#editor').classList.remove('active');
    $('#home').classList.add('active');
    const notes = (await DB.all()).sort((a, b) => b.updated - a.updated);
    const grid = $('#noteGrid');
    grid.innerHTML = '';
    $('#emptyTip').classList.toggle('hidden', notes.length > 0);
    for (const n of notes) {
      const card = document.createElement('div');
      card.className = 'note-card';
      const d = new Date(n.updated);
      card.innerHTML = `<div class="thumb"></div><div class="meta"><b></b><small>${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</small></div><button class="del" title="删除">✕</button>`;
      card.querySelector('b').textContent = n.title || '未命名笔记';
      if (n.thumb) card.querySelector('.thumb').style.backgroundImage = `url(${n.thumb})`;
      card.onclick = () => openNote(n.id);
      card.querySelector('.del').onclick = async e => {
        e.stopPropagation();
        if (!confirm(`删除「${n.title || '未命名笔记'}」？此操作不能撤销。`)) return;
        await DB.remove(n.id);
        showHome();
      };
      grid.appendChild(card);
    }
  }

  async function newNote() {
    const id = 'n' + Date.now().toString(36);
    const n = { id, title: '', created: Date.now(), updated: Date.now(), paper: 'lines', lineHeight: 72, nextId: 1, strokes: [] };
    await DB.put(n);
    openNote(id);
  }

  // 序列化：点压缩成扁平数组
  const pack = pts => {
    if (!pts) return null;
    const a = new Array(pts.length * 3);
    pts.forEach((p, i) => { a[i * 3] = Math.round(p.x * 100) / 100; a[i * 3 + 1] = Math.round(p.y * 100) / 100; a[i * 3 + 2] = Math.round(p.p * 1000) / 1000; });
    return a;
  };
  const unpack = a => {
    if (!a) return null;
    const pts = [];
    for (let i = 0; i < a.length; i += 3) pts.push({ x: a[i], y: a[i + 1], p: a[i + 2] });
    return pts;
  };

  async function openNote(id) {
    note = await DB.get(id);
    if (!note) return showHome();
    strokes = (note.strokes || []).map(s => ({
      id: s.id, tool: s.t, color: s.c, width: s.w, beautified: !!s.b, sharpEnd: s.e ?? undefined,
      pts: unpack(s.p), orig: unpack(s.o),
    }));
    sortStrokes();
    undoStack = []; redoStack = []; selection.clear();
    $('#noteTitle').value = note.title || '';
    $('#optPaper').value = note.paper || 'lines';
    $('#optSpacingSize').value = String(note.lineHeight || 72);
    $('#home').classList.remove('active');
    $('#editor').classList.add('active');
    view.zoom = 1; view.sy = 0;
    resize();
    updateSelBox();
  }

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 800);
  }
  async function saveNow() {
    clearTimeout(saveTimer);
    if (!note) return;
    note.title = $('#noteTitle').value.trim();
    note.updated = Date.now();
    note.strokes = strokes.map(s => ({ id: s.id, t: s.tool, c: s.color, w: s.width, b: s.beautified ? 1 : 0, e: s.sharpEnd, p: pack(s.pts), o: pack(s.orig) }));
    note.thumb = makeThumb();
    await DB.put(note);
  }

  function makeThumb() {
    const W = 240, H = 320, k = W / PAGE_W;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#fffdf8'; g.fillRect(0, 0, W, H);
    g.setTransform(k, 0, 0, k, 0, 0);
    for (const s of strokes) if (boxOf(s).minY < H / k) Render.drawStroke(g, s, renderOpts());
    return c.toDataURL('image/jpeg', 0.7);
  }

  // =============================================================
  //  视图与绘制
  // =============================================================
  function resize() {
    const r = stage.getBoundingClientRect();
    view.cssW = r.width; view.cssH = r.height;
    view.dpr = window.devicePixelRatio || 1;
    for (const cv of [baseCv, liveCv]) {
      cv.width = Math.round(r.width * view.dpr);
      cv.height = Math.round(r.height * view.dpr);
      cv.style.width = r.width + 'px';
      cv.style.height = r.height + 'px';
    }
    clampView();
    requestRender();
  }

  function clampView() {
    view.scale = (view.cssW / PAGE_W) * view.zoom;
    const visW = view.cssW / view.scale;
    if (visW >= PAGE_W) view.sx = -(visW - PAGE_W) / 2;
    else view.sx = clamp(view.sx, 0, PAGE_W - visW);
    let maxY = 0;
    for (const s of strokes) maxY = Math.max(maxY, boxOf(s).maxY);
    view.sy = clamp(view.sy, 0, Math.max(maxY + 600, view.sy));
  }

  const toPage = (cx, cy) => {
    const r = stage.getBoundingClientRect();
    return { x: (cx - r.left) / view.scale + view.sx, y: (cy - r.top) / view.scale + view.sy };
  };

  let renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderBase(); });
  }

  function applyViewTransform(ctx) {
    const k = view.scale * view.dpr;
    ctx.setTransform(k, 0, 0, k, -view.sx * k, -view.sy * k);
  }

  function renderBase() {
    if (!note) return;
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, baseCv.width, baseCv.height);
    Render.drawPaper(bctx, view, note.paper || 'lines', note.lineHeight || 72, PAGE_W);
    applyViewTransform(bctx);
    const y0 = view.sy - 20, y1 = view.sy + view.cssH / view.scale + 20;
    const opts = renderOpts();
    for (const s of strokes) {
      const b = boxOf(s);
      if (b.maxY < y0 || b.minY > y1) continue;
      Render.drawStroke(bctx, s, opts);
    }
    updateSelBox();
  }

  // 前景层：正在写的笔画 / 套索 / 橡皮光标
  function renderLive() {
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, liveCv.width, liveCv.height);
    applyViewTransform(lctx);
    if (drawing && drawing.stroke && drawing.stroke.pts.length) {
      Render.drawStroke(lctx, drawing.stroke, { ...renderOpts(), live: true });
    }
    if (drawing && drawing.lasso) {
      lctx.save();
      lctx.strokeStyle = '#2f5d50'; lctx.lineWidth = 1.5 / view.scale;
      lctx.setLineDash([6 / view.scale, 5 / view.scale]);
      lctx.fillStyle = 'rgba(47,93,80,0.06)';
      lctx.beginPath();
      drawing.lasso.forEach((p, i) => (i ? lctx.lineTo(p.x, p.y) : lctx.moveTo(p.x, p.y)));
      lctx.closePath(); lctx.fill(); lctx.stroke();
      lctx.restore();
    }
    if (eraserCursor) {
      lctx.save();
      lctx.strokeStyle = 'rgba(0,0,0,.35)'; lctx.lineWidth = 1 / view.scale;
      lctx.beginPath(); lctx.arc(eraserCursor.x, eraserCursor.y, ERASER_R, 0, Math.PI * 2); lctx.stroke();
      lctx.restore();
    }
  }

  // =============================================================
  //  历史记录（撤销 / 重做）
  // =============================================================
  function commit(before, after) {
    undoStack.push({ before, after });
    if (undoStack.length > 200) undoStack.shift();
    redoStack = [];
    scheduleSave();
  }
  function applySwap(remove, add) {
    const ids = new Set(remove.map(s => s.id));
    strokes = strokes.filter(s => !ids.has(s.id));
    strokes.push(...add.map(restoreSnap));
    sortStrokes();
    selection.clear();
    requestRender(); scheduleSave();
  }
  function undo() {
    const a = undoStack.pop(); if (!a) return;
    applySwap(a.after, a.before); redoStack.push(a);
  }
  function redo() {
    const a = redoStack.pop(); if (!a) return;
    applySwap(a.before, a.after); undoStack.push(a);
  }

  // =============================================================
  //  笔迹美化
  // =============================================================
  let animating = false;
  function beautifyStrokes(targets, { onlyNew = false, silent = false } = {}) {
    const lh = note.lineHeight || 72;
    // 同一行的其它笔画作为上下文一起参与（用于估计字高、字距）
    const lineOf = s => Math.floor(boxOf(s).cy / lh);
    const lines = new Set(targets.map(lineOf));
    const context = targets.length && onlyNew
      ? strokes.filter(s => s.tool === 'pen' && lines.has(lineOf(s)))
      : targets;
    const res = Beautify.compute(context.map(s => ({ id: s.id, tool: s.tool, pts: s.pts })), {
      strength: settings.strength / 100,
      straight: settings.straight, slant: settings.slant, align: settings.align, spacing: settings.spacing,
      lineHeight: lh, lineTop: 0,
    });
    const targetIds = new Set(targets.map(s => s.id));
    const jobs = [];
    for (const s of context) {
      if (!targetIds.has(s.id) || (onlyNew && s.beautified)) continue;
      const r = res.get(s.id);
      if (!r) continue;
      const to = Beautify.blend(r.base, r.target, settings.strength / 100);
      jobs.push({ s, from: r.base, to, before: snapshot(s) });
    }
    if (!jobs.length) { if (!silent) toast('没有可以美化的笔迹'); return false; }

    // 变形动画
    animating = true;
    const t0 = performance.now(), D = 380;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      animating = false;
      for (const j of jobs) {
        if (!j.s.orig) j.s.orig = j.before.pts;
        j.s.beautified = true;
        setPts(j.s, j.to);
      }
      commit(jobs.map(j => j.before), jobs.map(j => snapshot(j.s)));
      requestRender();
    };
    const step = now => {
      if (done) return;
      const t = clamp((now - t0) / D, 0, 1);
      if (t >= 1) return finish();
      const e = 1 - Math.pow(1 - t, 3);
      for (const j of jobs) setPts(j.s, Beautify.blend(j.from, j.to, e));
      renderBase();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    setTimeout(finish, D + 200);   // 页面在后台时动画帧会暂停，保证结果一定落地
    return true;
  }

  function restoreStrokes(list) {
    const changed = list.filter(s => s.orig);
    if (!changed.length) return toast('这些笔迹已经是原始笔迹');
    const before = changed.map(snapshot);
    for (const s of changed) { setPts(s, s.orig); s.orig = null; s.beautified = false; }
    commit(before, changed.map(snapshot));
    requestRender();
    toast('已还原为原始笔迹');
  }

  // 自动美化：停笔一会儿后，美化刚写的那几行
  let autoTimer = null;
  function scheduleAuto() {
    clearTimeout(autoTimer);
    if (!settings.auto) return;
    autoTimer = setTimeout(() => {
      if (drawing || animating) return scheduleAuto();
      const fresh = strokes.filter(s => s.tool === 'pen' && !s.beautified);
      if (fresh.length) beautifyStrokes(fresh, { onlyNew: true, silent: true });
    }, 1300);
  }

  // =============================================================
  //  输入处理
  // =============================================================
  const ERASER_R = 10;
  let drawing = null;            // 当前书写/操作
  let eraserCursor = null;
  const touches = new Map();     // 手势用
  let gesture = null;

  function isDrawPointer(e) {
    if (e.pointerType === 'pen') return true;
    if (e.pointerType === 'mouse') return e.button === 0;
    return settings.finger && !penSeen;
  }

  stage.addEventListener('pointerdown', e => {
    if (e.target.closest('.sel-actions')) return;
    closePanels();
    if (e.pointerType === 'pen') penSeen = true;
    if (drawing) return;                       // 正在书写：忽略手掌等其它触点
    if (isDrawPointer(e) && !gesture) {
      try { liveCv.setPointerCapture(e.pointerId); } catch (_) {}
      clearTimeout(autoTimer);
      startDraw(e);
    } else if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      startGesture();
    }
  });

  stage.addEventListener('pointermove', e => {
    if (drawing && e.pointerId === drawing.pointerId) {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of (evs.length ? evs : [e])) moveDraw(ev);
      renderLive();
    } else if (touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moveGesture();
    } else if (settings.tool === 'eraser' && (e.pointerType === 'pen' || e.pointerType === 'mouse')) {
      eraserCursor = toPage(e.clientX, e.clientY); renderLive();
    }
  });

  const endPointer = e => {
    if (drawing && e.pointerId === drawing.pointerId) { endDraw(e); }
    if (touches.has(e.pointerId)) {
      touches.delete(e.pointerId);
      if (touches.size === 0) endGesture(); else startGesture();
    }
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);
  stage.addEventListener('pointerleave', e => { if (eraserCursor && !drawing) { eraserCursor = null; renderLive(); } });

  // 鼠标滚轮：滚动 / Ctrl+滚轮缩放
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.ctrlKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.002));
    else { view.sy += e.deltaY / view.scale; view.sx += e.deltaX / view.scale; clampView(); requestRender(); }
  }, { passive: false });

  // ---- 书写 ----
  function startDraw(e) {
    const p = toPage(e.clientX, e.clientY);
    const tool = settings.tool;
    drawing = { pointerId: e.pointerId, tool, last: p, lastT: e.timeStamp, realPressure: e.pointerType === 'pen' };
    if (tool === 'pen' || tool === 'highlighter') {
      drawing.stroke = {
        id: note.nextId++, tool, pts: [],
        color: tool === 'pen' ? settings.color : settings.hlColor,
        width: settings.width, beautified: false, orig: null,
      };
      moveDraw(e);
    } else if (tool === 'eraser') {
      drawing.erased = [];
      eraseAt(p);
    } else if (tool === 'lasso') {
      const sb = selectionBox();
      if (sb && p.x >= sb.minX && p.x <= sb.maxX && p.y >= sb.minY && p.y <= sb.maxY) {
        drawing.move = { start: p, before: [...selection].map(id => snapshot(strokes.find(s => s.id === id))) };
      } else {
        selection.clear(); updateSelBox(); requestRender();
        drawing.lasso = [p];
      }
    }
  }

  function moveDraw(e) {
    const p = toPage(e.clientX, e.clientY);
    const d = drawing;
    if (d.stroke) {
      let pr;
      if (d.realPressure) pr = e.pressure || 0.5;
      else {
        // 没有压感（鼠标/手指）：用速度模拟，慢粗快细
        const dt = Math.max(1, e.timeStamp - d.lastT);
        const v = dist(p, d.last) / dt;           // 单位/毫秒
        const target = clamp(0.85 - v * 0.35, 0.3, 0.85);
        pr = d.stroke.pts.length ? lerp(d.stroke.pts[d.stroke.pts.length - 1].p, target, 0.3) : 0.6;
      }
      const pts = d.stroke.pts;
      const last = pts[pts.length - 1];
      if (!last || dist(last, p) > 0.6 / view.scale) pts.push({ x: p.x, y: p.y, p: pr });
      else last.p = Math.max(last.p, pr);
    } else if (d.tool === 'eraser') {
      eraseAt(p); eraserCursor = p;
    } else if (d.lasso) {
      d.lasso.push(p);
    } else if (d.move) {
      const dx = p.x - d.last.x, dy = p.y - d.last.y;
      for (const s of strokes) if (selection.has(s.id)) {
        setPts(s, s.pts.map(q => ({ x: q.x + dx, y: q.y + dy, p: q.p })));
        if (s.orig) s.orig = s.orig.map(q => ({ x: q.x + dx, y: q.y + dy, p: q.p }));
      }
      requestRender();
    }
    d.last = p; d.lastT = e.timeStamp;
  }

  function endDraw() {
    const d = drawing;
    drawing = null;
    if (d.stroke) {
      const s = d.stroke;
      if (s.pts.length) {
        s.pts = s.pts.slice();
        if (!d.realPressure && s.pts.length > 3) {
          // 鼠标/手指：末端加速则出锋
          const n = s.pts.length;
          s.sharpEnd = dist(s.pts[n - 1], s.pts[n - 3]) > 2.2 * (Geo.pathLength(s.pts) / (n - 1));
        }
        strokes.push(s);
        commit([], [snapshot(s)]);
        if (s.tool === 'pen') scheduleAuto();
      }
    } else if (d.tool === 'eraser') {
      if (d.erased.length) commit(d.erased, []);
    } else if (d.lasso) {
      if (d.lasso.length > 4) {
        for (const s of strokes) {
          const inside = s.pts.filter(q => Geo.pointInPolygon(q, d.lasso)).length;
          if (inside >= s.pts.length * 0.6) selection.add(s.id);
        }
      }
      if (!selection.size && d.lasso.length > 4) toast('没有圈到笔迹');
    } else if (d.move) {
      const after = [...selection].map(id => snapshot(strokes.find(s => s.id === id)));
      const sel = new Set(selection);
      commit(d.move.before, after);
      selection = sel;   // commit 不影响选区
    }
    renderLive();
    requestRender();
  }

  function eraseAt(p) {
    const r = ERASER_R / Math.min(1, view.zoom);
    const hit = strokes.filter(s => {
      const b = boxOf(s);
      if (p.x < b.minX - r - s.width || p.x > b.maxX + r + s.width || p.y < b.minY - r - s.width || p.y > b.maxY + r + s.width) return false;
      const pts = s.pts;
      if (pts.length === 1) return dist(p, pts[0]) < r;
      for (let i = 1; i < pts.length; i++) if (Geo.distToSeg(p, pts[i - 1], pts[i]) < r + s.width / 2) return true;
      return false;
    });
    if (!hit.length) return;
    const ids = new Set(hit.map(s => s.id));
    drawing.erased.push(...hit.map(snapshot));
    strokes = strokes.filter(s => !ids.has(s.id));
    requestRender();
  }

  // ---- 手势：单指滚动，双指缩放 ----
  function startGesture() {
    const pts = [...touches.values()];
    if (!pts.length) return;
    const c = pts.length >= 2
      ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2, d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) }
      : { x: pts[0].x, y: pts[0].y, d: 0 };
    gesture = { c, zoom: view.zoom, anchor: toPage(c.x, c.y), n: pts.length };
  }
  function moveGesture() {
    if (!gesture) return;
    const pts = [...touches.values()];
    if (pts.length !== gesture.n) return startGesture();
    const r = stage.getBoundingClientRect();
    if (pts.length >= 2) {
      const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      view.zoom = clamp(gesture.zoom * d / Math.max(10, gesture.c.d), 0.5, 3);
      view.scale = (view.cssW / PAGE_W) * view.zoom;
      view.sx = gesture.anchor.x - (cx - r.left) / view.scale;
      view.sy = gesture.anchor.y - (cy - r.top) / view.scale;
      showZoom();
    } else {
      view.sx = gesture.anchor.x - (pts[0].x - r.left) / view.scale;
      view.sy = gesture.anchor.y - (pts[0].y - r.top) / view.scale;
    }
    clampView();
    requestRender();
  }
  function endGesture() { gesture = null; }

  function zoomAt(cx, cy, f) {
    const anchor = toPage(cx, cy);
    const r = stage.getBoundingClientRect();
    view.zoom = clamp(view.zoom * f, 0.5, 3);
    view.scale = (view.cssW / PAGE_W) * view.zoom;
    view.sx = anchor.x - (cx - r.left) / view.scale;
    view.sy = anchor.y - (cy - r.top) / view.scale;
    clampView(); showZoom(); requestRender();
  }
  let zoomTimer;
  function showZoom() {
    const z = $('#zoomTag');
    z.textContent = Math.round(view.zoom * 100) + '%';
    z.classList.remove('hidden');
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => z.classList.add('hidden'), 900);
  }

  // ---- 选区 ----
  function selectionBox() {
    let b = null;
    for (const s of strokes) if (selection.has(s.id)) b = b ? Geo.unionBox(b, boxOf(s)) : boxOf(s);
    return b;
  }
  function updateSelBox() {
    const el = $('#selBox');
    const b = selection.size ? selectionBox() : null;
    if (!b) { el.classList.add('hidden'); return; }
    const pad = 8;
    el.style.left = ((b.minX - view.sx) * view.scale - pad) + 'px';
    el.style.top = ((b.minY - view.sy) * view.scale - pad) + 'px';
    el.style.width = (b.w * view.scale + pad * 2) + 'px';
    el.style.height = (b.h * view.scale + pad * 2) + 'px';
    el.querySelector('.sel-actions').style.top = ((b.minY - view.sy) * view.scale < 60 ? b.h * view.scale + pad * 2 + 8 : -48) + 'px';
    el.classList.remove('hidden');
  }
  $('#selBox').addEventListener('pointerdown', e => e.stopPropagation());
  $$('.sel-actions button').forEach(btn => btn.addEventListener('click', () => {
    const list = strokes.filter(s => selection.has(s.id));
    const act = btn.dataset.act;
    if (act === 'beautify') { beautifyStrokes(list.filter(s => s.tool === 'pen')); }
    else if (act === 'restore') restoreStrokes(list);
    else if (act === 'delete') {
      commit(list.map(snapshot), []);
      strokes = strokes.filter(s => !selection.has(s.id));
    }
    selection.clear(); updateSelBox(); requestRender();
  }));

  // =============================================================
  //  工具栏
  // =============================================================
  function buildColors() {
    const box = $('#colors');
    box.innerHTML = '';
    const isHL = settings.tool === 'highlighter';
    const list = isHL ? HL_COLORS : PEN_COLORS;
    const cur = isHL ? settings.hlColor : settings.color;
    for (const c of list) {
      const b = document.createElement('button');
      b.className = 'swatch' + (c === cur ? ' active' : '');
      b.style.background = c;
      b.onclick = () => {
        if (isHL) settings.hlColor = c; else settings.color = c;
        saveSettings(); buildColors();
      };
      box.appendChild(b);
    }
    box.style.visibility = (settings.tool === 'pen' || isHL) ? 'visible' : 'hidden';
  }
  function setTool(t) {
    settings.tool = t; saveSettings();
    $$('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    if (t !== 'lasso') { selection.clear(); updateSelBox(); }
    eraserCursor = null; renderLive();
    buildColors();
  }
  $$('.tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

  $('#penWidth').value = settings.width;
  $('#penWidth').addEventListener('input', e => { settings.width = +e.target.value; saveSettings(); });
  $('#btnUndo').onclick = undo;
  $('#btnRedo').onclick = redo;
  $('#btnBack').onclick = showHome;
  $('#btnNew').onclick = newNote;
  $('#noteTitle').addEventListener('input', scheduleSave);

  $('#btnBeautify').onclick = () => {
    clearTimeout(autoTimer);
    const pens = strokes.filter(s => s.tool === 'pen');
    if (!pens.length) return toast('先写几个字吧');
    const fresh = pens.filter(s => !s.beautified);
    if (fresh.length) { if (beautifyStrokes(fresh, { onlyNew: true })) toast('✨ 已美化'); }
    else if (beautifyStrokes(pens)) toast('✨ 再整理了一遍');
  };

  // 面板
  function closePanels() { $('#magicPanel').classList.add('hidden'); $('#morePanel').classList.add('hidden'); }
  $('#btnMagicMenu').onclick = e => { e.stopPropagation(); $('#morePanel').classList.add('hidden'); $('#magicPanel').classList.toggle('hidden'); };
  $('#btnMore').onclick = e => { e.stopPropagation(); $('#magicPanel').classList.add('hidden'); $('#morePanel').classList.toggle('hidden'); };

  const bindCheck = (sel, key, after) => {
    const el = $(sel);
    el.checked = !!settings[key];
    el.addEventListener('change', () => { settings[key] = el.checked; saveSettings(); after && after(); });
  };
  bindCheck('#optAuto', 'auto');
  bindCheck('#optStraight', 'straight');
  bindCheck('#optSlant', 'slant');
  bindCheck('#optAlign', 'align');
  bindCheck('#optSpacing', 'spacing');
  bindCheck('#optBrush', 'brush', requestRender);
  bindCheck('#optFinger', 'finger', () => { if (settings.finger) penSeen = false; });
  $('#optStrength').value = settings.strength;
  $('#strengthVal').textContent = settings.strength + '%';
  $('#optStrength').addEventListener('input', e => {
    settings.strength = +e.target.value; saveSettings();
    $('#strengthVal').textContent = settings.strength + '%';
  });
  $('#btnRestoreAll').onclick = () => { closePanels(); restoreStrokes(strokes); };

  $('#optPaper').addEventListener('change', e => { note.paper = e.target.value; scheduleSave(); requestRender(); });
  $('#optSpacingSize').addEventListener('change', e => { note.lineHeight = +e.target.value; scheduleSave(); requestRender(); });
  $('#btnClear').onclick = () => {
    if (!strokes.length || !confirm('清空本页所有笔迹？（可以撤销）')) return;
    commit(strokes.map(snapshot), []);
    strokes = []; selection.clear(); requestRender(); closePanels();
  };
  $('#btnExport').onclick = () => {
    let maxY = 0;
    for (const s of strokes) maxY = Math.max(maxY, boxOf(s).maxY);
    const H = Math.max(1414, Math.ceil(maxY + 80));
    const k = 2;
    const c = document.createElement('canvas');
    c.width = PAGE_W * k; c.height = H * k;
    const g = c.getContext('2d');
    Render.drawPaper(g, { scale: 1, sx: 0, sy: 0, cssW: PAGE_W, cssH: H, dpr: k }, note.paper || 'lines', note.lineHeight || 72, PAGE_W);
    g.setTransform(k, 0, 0, k, 0, 0);
    for (const s of strokes) Render.drawStroke(g, s, renderOpts());
    const a = document.createElement('a');
    a.download = (note.title || '笔记') + '.png';
    a.href = c.toDataURL('image/png');
    a.click();
    closePanels();
  };

  // 快捷键（外接键盘）
  window.addEventListener('keydown', e => {
    if (!note || e.target.tagName === 'INPUT') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  });

  window.addEventListener('resize', () => note && resize());
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
  window.addEventListener('pagehide', () => saveNow());

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // 调试接口（浏览器控制台可用）
  window.__miaobi = {
    get strokes() { return strokes; },
    get note() { return note; },
    addStroke(pts, opt = {}) {
      const s = { id: note.nextId++, tool: 'pen', color: settings.color, width: settings.width, pts, beautified: false, orig: null, ...opt };
      strokes.push(s); commit([], [snapshot(s)]); requestRender(); return s;
    },
    beautify: (opts) => beautifyStrokes(strokes.filter(s => s.tool === 'pen'), opts),
    settings,
  };

  setTool(settings.tool);
  showHome();
})();
