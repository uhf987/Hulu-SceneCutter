// ═══════════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════════
let file = null, dur = 0, analyzed = false, fps = 25;
let scenes = [];        // {start, end, color, selected}
let tlZoom = 1, tlOff = 0, tlBase = 80;
let dragging = null;    // {type:'edge'|'seek'|'pan', idx, side, ox, origT}
let raf = null;
let seeking = false;
let keyframes = [];     // cached keyframe timestamps for timeline display
let kfFetchTimer = null;

// undo stack: snapshot taken before each state change
let undoStack = [];   // [{scenes: [...], currentTime}]
const UNDO_LIMIT = 50;

function saveUndo() {
  undoStack.push({
    scenes: scenes.map(s => ({ ...s })),
    currentTime: vid.currentTime
  });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function undo() {
  if (undoStack.length === 0) return;
  const snap = undoStack.pop();
  scenes = snap.scenes;
  vid.currentTime = snap.currentTime;
  updateExpBar();
  updateTrimBtns();
  drawTl();
}

// ═══════════════════════════════════════════════════════════════
//  DOM
// ═══════════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const vid        = $('vid');
const player     = $('player');
const drop       = $('drop');
const ov         = $('ov');
const ovMsg      = $('ovMsg');
const ovSub      = $('ovSub');
const ctrl       = $('ctrl');
const seekWrap   = $('seekWrap');
const seekFill   = $('seekFill');
const seekThumb  = $('seekThumb');
const btnPlay    = $('btnPlay');
const icoPlay    = $('icoPlay');
const timeLbl    = $('timeLbl');
const muteBtn    = $('muteBtn');
const volSl      = $('volSl');
const fsBtn      = $('fsBtn');
const tlSection  = $('tlSection');
const tlWrap     = $('tlWrap');
const tlCanvas   = $('tl');
const scBadge    = $('scBadge');
const selBadge   = $('selBadge');
const zoomSl     = $('zoomSl');
const zoomLbl    = $('zoomLbl');
const clearSelBtn= $('clearSelBtn');
const expBar     = $('expBar');
const expInfo    = $('expInfo');
const prog       = $('prog');
const progFill   = $('progFill');
const statLbl    = $('statLbl');
const expBtn     = $('expBtn');
const openBtn    = $('openBtn');
const analyzeBtn = $('analyzeBtn');
const btnFrameB    = $('btnFrameB');
const btnFrameF    = $('btnFrameF');
const btnSnapTrim  = $('btnSnapTrim');
const btnAddTrim   = $('btnAddTrim');
const btnAddScene  = $('btnAddScene');
const sensitivitySl= $('sensitivitySl');
const sensitivityLbl=$('sensitivityLbl');
const fileName   = $('fileName');
const ctx        = tlCanvas.getContext('2d');
const ctxMenu    = $('ctx');

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════
const COLORS = ['#7c6fff','#ff6b8a','#3ddc84','#fbbf24','#22d3ee',
                '#f97316','#a78bfa','#34d399','#fb7185','#60a5fa'];
const scColor = i => COLORS[i % COLORS.length];

const fmt = s => {
  if (!isFinite(s) || s < 0) return '0:00';
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
  return h > 0 ? `${h}:${p2(m)}:${p2(sec)}` : `${m}:${p2(sec)}`;
};
const p2 = n => String(n).padStart(2,'0');
const pps = () => tlBase * tlZoom;
const t2x = t  => t * pps() - tlOff;
const x2t = x  => (x + tlOff) / pps();

function setOv(on, msg='', sub='') {
  ov.classList.toggle('on', on);
  if (msg) ovMsg.textContent = msg;
  ovSub.textContent = sub;
}

// ═══════════════════════════════════════════════════════════════
//  FILE LOAD
// ═══════════════════════════════════════════════════════════════
// originalFile: the actual source for export; file: what <video> plays (may be preview)
let originalFile = null;

async function loadFile(fp) {
  file = fp; originalFile = fp; dur = 0; analyzed = false; scenes = [];
  undoStack = [];
  setOv(true, 'Loading...');

  // 1. Check if the format is natively playable in Chromium
  let playable = true;
  try {
    const res = await window.api.checkPlayability(fp);
    playable = res.playable;
  } catch(e) {}

  // Always reset the video element fully before setting a new src.
  // Chromium aggressively caches media — without this, switching files
  // at the same path can show the old video.
  vid.pause();
  vid.removeAttribute('src');
  vid.load();

  // Cache-buster: append ?t=<timestamp> so Chromium never serves a stale file
  const cb = `?t=${Date.now()}`;

  if (!playable) {
    setOv(true, 'Converting format...', 'Creating low-quality preview for playback (export will use original file)');
    try {
      window.api.onPreviewProgress(d => {
        if (d.status === 'converting') {
          ovMsg.textContent = d.pct > 0 ? `Preview: ${Math.floor(d.pct)}s processed...` : 'Converting...';
        }
      });
      const previewPath = await window.api.makePreview(fp);
      vid.src = 'file:///' + previewPath.replace(/\\/g, '/') + cb;
    } catch(e) {
      vid.src = 'file:///' + fp.replace(/\\/g, '/') + cb;
    }
  } else {
    vid.src = 'file:///' + fp.replace(/\\/g, '/') + cb;
  }

  vid.classList.add('on');
  drop.style.display = 'none';
  fileName.textContent = fp.split(/[\\/]/).pop() + (playable ? '' : ' ⚡ preview');
  analyzeBtn.style.display = '';
  $('analyzeRangeBtn').style.display = '';
  $('vr1').style.display = '';

  await new Promise(resolve => {
    vid.addEventListener('loadedmetadata', () => { dur = vid.duration; resolve(); }, { once: true });
    setTimeout(async () => {
      if (!dur || !isFinite(dur)) {
        try { const i = await window.api.getVideoInfo(fp); dur = parseFloat(i.format.duration)||0; } catch(e){}
        resolve();
      }
    }, 5000);
  });

  ctrl.classList.add('on');
  tlSection.style.display = 'flex'; tlSection.style.flexDirection = 'column';
  expBar.classList.add('on');
  tlBase = Math.max(20, tlWrap.clientWidth / Math.max(dur, 1));
  tlZoom = 1; tlOff = 0;
  zoomSl.value = 1; zoomLbl.textContent = '1×';
  window.api.getFps(fp).then(f => { fps = f || 25; }).catch(() => {});
  keyframes = []; if(kfStrip) kfStrip.innerHTML = '';
  setTimeout(() => fetchAndRenderAllKfs(), 500);
  setOv(false);
  drawTl();
  updateExpBar();
  updateTrimBtns();
}

// ═══════════════════════════════════════════════════════════════
//  ANALYZE
// ═══════════════════════════════════════════════════════════════
sensitivitySl.addEventListener('input', () => {
  sensitivityLbl.textContent = parseFloat(sensitivitySl.value).toFixed(2);
});

analyzeBtn.addEventListener('click', async () => {
  if (!file) return;
  const threshold = parseFloat(sensitivitySl.value) || 0.3;
  setOv(true, 'Scanning... 0%', 'May take 10–60 seconds depending on file length');
  scenes = [];
  window.api.onDetectProgress(p => { ovMsg.textContent = `Scanning... ${p}%`; });
  try {
    const { changePoints, duration: d } = await window.api.detectScenes(originalFile || file, threshold);
    if (d > 0) dur = d;
    const bnd = [0, ...changePoints, dur];
    for (let i = 0; i < bnd.length-1; i++)
      scenes.push({ start: bnd[i], end: bnd[i+1], color: scColor(i), selected: false });
    analyzed = true;
    scBadge.textContent = `${scenes.length} scene${scenes.length===1?'':'s'}`;
    updateExpBar();
    updateTrimBtns();
    drawTl();
  } catch(e) { scBadge.textContent = 'Error'; }
  finally { setOv(false); }
});

// ═══════════════════════════════════════════════════════════════
//  ANALYZE RANGE (±2.5 min around current position)
// ═══════════════════════════════════════════════════════════════
$('analyzeRangeBtn').addEventListener('click', async () => {
  if (!file || !dur) return;
  const HALF = 150; // 2.5 minutes
  const center = vid.currentTime;
  const rangeStart = Math.max(0, center - HALF);
  const rangeEnd   = Math.min(dur, center + HALF);
  const rangeLabel = `${fmt(rangeStart)} – ${fmt(rangeEnd)}`;
  setOv(true, 'Scanning range... 0%', `Analyzing range ${rangeLabel}`);
  window.api.onDetectProgress(p => { ovMsg.textContent = `Scanning range... ${p}%`; });
  try {
    const threshold = parseFloat(sensitivitySl.value) || 0.3;
    const { changePoints } = await window.api.detectScenesRange(originalFile || file, threshold, rangeStart, rangeEnd);
    // Merge results: remove any existing scenes fully inside the range, then insert new ones
    scenes = scenes.filter(sc => sc.end <= rangeStart || sc.start >= rangeEnd);
    // Build boundary list for the range
    const bnd = [rangeStart, ...changePoints.filter(t => t > rangeStart && t < rangeEnd), rangeEnd];
    for (let i = 0; i < bnd.length - 1; i++)
      scenes.push({ start: bnd[i], end: bnd[i+1], color: '', selected: false });
    // Sort and recolor all scenes
    scenes.sort((a, b) => a.start - b.start);
    scenes.forEach((sc, i) => sc.color = scColor(i));
    analyzed = true;
    scBadge.textContent = `${scenes.length} scene${scenes.length===1?'':'s'}`;
    updateExpBar();
    updateTrimBtns();
    drawTl();
  } catch(e) { scBadge.textContent = 'Error'; console.error(e); }
  finally { setOv(false); }
});

// ═══════════════════════════════════════════════════════════════
//  SEEKBAR (top mini bar) — fully synced
// ═══════════════════════════════════════════════════════════════
function updateSeekbar() {
  if (!dur) return;
  const p = (vid.currentTime / dur) * 100;
  seekFill.style.width = p + '%';
  seekThumb.style.left = p + '%';
  timeLbl.textContent = `${fmt(vid.currentTime)} / ${fmt(dur)}`;
}

seekWrap.addEventListener('mousedown', e => { seeking = true; doSeek(e); });
window.addEventListener('mousemove', e => { if (seeking) doSeek(e); });
window.addEventListener('mouseup', () => { seeking = false; });

function doSeek(e) {
  const r = seekWrap.getBoundingClientRect();
  const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  const t = p * dur;
  if (vid.fastSeek) vid.fastSeek(t); else vid.currentTime = t;
  scrollTlToTime(t);
}

// Scroll timeline so playhead stays visible
function scrollTlToTime(t) {
  if (!dur) return;
  const W = tlWrap.clientWidth;
  const px = t * pps();
  const margin = W * 0.15;
  if (px - tlOff < margin) {
    tlOff = Math.max(0, px - margin);
    clampOff();
  } else if (px - tlOff > W - margin) {
    tlOff = px - (W - margin);
    clampOff();
  }
}

// ═══════════════════════════════════════════════════════════════
//  PLAY / PAUSE
// ═══════════════════════════════════════════════════════════════
function setPlayIcon(playing) {
  icoPlay.innerHTML = playing
    ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>'
    : '<path d="M8 5v14l11-7z"/>';
}

btnPlay.addEventListener('click', togglePlay);
function togglePlay() {
  if (vid.paused) { vid.play().catch(() => {}); }
  else { vid.pause(); }
}

vid.addEventListener('play',  () => { setPlayIcon(true);  startRaf(); });
vid.addEventListener('pause', () => { setPlayIcon(false); stopRaf(); drawTl(); });
vid.addEventListener('ended', () => { setPlayIcon(false); stopRaf(); drawTl(); });
vid.addEventListener('seeked', () => { updateSeekbar(); drawTl(); });

// RAF loop: update seekbar + playhead while playing
function startRaf() {
  if (raf) return;
  function loop() {
    updateSeekbar();
    drawTl();
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);
}
function stopRaf() { if (raf) { cancelAnimationFrame(raf); raf = null; } }

btnFrameB.addEventListener('click', () => {
  const frameSec = 1 / fps;
  vid.currentTime = Math.max(0, vid.currentTime - frameSec);
});
btnFrameF.addEventListener('click', () => {
  const frameSec = 1 / fps;
  vid.currentTime = Math.min(dur, vid.currentTime + frameSec);
});

// ── Trim butonlarını aktif/pasif yap ──────────────────────────────────
function updateTrimBtns() {
  const ok = analyzed && scenes.length > 0;
  [btnSnapTrim, btnAddTrim].forEach(btn => {
    btn.style.opacity = ok ? '1' : '0.35';
    btn.style.cursor  = ok ? 'pointer' : 'not-allowed';
  });
  // Kutucuk ekle: sadece dosya yüklü olsun yeter, analiz şart değil
  const hasFile = !!file && dur > 0;
  btnAddScene.style.opacity = hasFile ? '1' : '0.35';
  btnAddScene.style.cursor  = hasFile ? 'pointer' : 'not-allowed';
}

// ── Snap Trim: en yakın trim çizgisini playhead konumuna taşı ──────────
btnSnapTrim.addEventListener('click', () => {
  if (!analyzed || scenes.length === 0) return;
  saveUndo();
  const t = vid.currentTime;
  const MIN = 0.1;

  let bestDist = Infinity, bestIdx = -1, bestSide = null;
  for (let i = 0; i < scenes.length; i++) {
    const dStart = Math.abs(t - scenes[i].start);
    if (dStart < bestDist) { bestDist = dStart; bestIdx = i; bestSide = 'start'; }
    const dEnd = Math.abs(t - scenes[i].end);
    if (dEnd < bestDist) { bestDist = dEnd; bestIdx = i; bestSide = 'end'; }
  }
  if (bestIdx < 0) return;

  const sc   = scenes[bestIdx];
  const prev = scenes[bestIdx - 1];
  const next = scenes[bestIdx + 1];

  if (bestSide === 'start') {
    const newStart = Math.max(prev ? prev.start + MIN : 0, Math.min(sc.end - MIN, t));
    if (prev) prev.end = newStart;
    sc.start = newStart;
  } else {
    const newEnd = Math.min(next ? next.end - MIN : dur, Math.max(sc.start + MIN, t));
    if (next) next.start = newEnd;
    sc.end = newEnd;
  }
  updateExpBar();
  drawTl();
});

// ── Trim Ekle: playhead konumuna yeni bir bölme çizgisi ekle ──────────
btnAddTrim.addEventListener('click', () => {
  if (!analyzed || scenes.length === 0) return;
  const t = vid.currentTime;
  const MIN = 0.1;

  const idx = scenes.findIndex(s => t > s.start + MIN && t < s.end - MIN);
  if (idx < 0) return;

  saveUndo();
  const sc = scenes[idx];
  const oldEnd = sc.end;

  sc.end = t;
  scenes.splice(idx + 1, 0, { start: t, end: oldEnd, color: '', selected: sc.selected });
  scenes.forEach((s, i) => s.color = scColor(i));

  scBadge.textContent = `${scenes.length} scene${scenes.length===1?'':'s'}`;
  updateExpBar();
  drawTl();
});

// ── Kutucuk Ekle: playhead konumuna bağımsız yeni bir kutucuk ekle ─────
// No analysis required. Creates a range that doesn't overlap existing scenes:
// 5-second segment from playhead (or to end of video).
btnAddScene.addEventListener('click', () => {
  if (!file || dur <= 0) return;
  saveUndo();

  const t   = vid.currentTime;
  const DEF = 5; // varsayılan genişlik (sn)
  const MIN = 0.5;

  // Determine start and end of new segment
  let newStart = t;
  let newEnd   = Math.min(dur, t + DEF);

  // If overlapping existing scenes, shift start to after last scene
  // (simple approach: sort all scenes, find a gap)
  const sorted = [...scenes].sort((a, b) => a.start - b.start);

  // Find which scene contains t
  const inside = sorted.findIndex(s => t >= s.start && t <= s.end);
  if (inside >= 0) {
    // Inside an existing scene — split it (like Add Trim)
    const sc = sorted[inside];
    const origIdx = scenes.indexOf(sc);
    if (t <= sc.start + MIN || t >= sc.end - MIN) {
      // Too close to an edge, do nothing
      undoStack.pop(); // revert saveUndo
      return;
    }
    const oldEnd = sc.end;
    sc.end = t;
    scenes.splice(origIdx + 1, 0, { start: t, end: oldEnd, color: '', selected: false });
  } else {
    // Empty area: add new independent segment
    // Extend to start of next scene, max 30s
    const nextSc = sorted.find(s => s.start > t);
    if (nextSc) newEnd = Math.min(nextSc.start, Math.min(dur, t + 30));
    else         newEnd = Math.min(dur, t + DEF);

    if (newEnd - newStart < MIN) { undoStack.pop(); return; }
    scenes.push({ start: newStart, end: newEnd, color: '', selected: false });
    scenes.sort((a, b) => a.start - b.start);
  }

  analyzed = true; // scenes now exist
  scenes.forEach((s, i) => s.color = scColor(i));
  scBadge.textContent = `${scenes.length} scene${scenes.length===1?'':'s'}`;
  updateExpBar();
  updateTrimBtns();
  drawTl();
});

// Player scroll wheel → scrub ±2s
player.addEventListener('wheel', e => {
  if (!file) return;
  e.preventDefault();
  vid.currentTime = Math.max(0, Math.min(dur, vid.currentTime + (e.deltaY > 0 ? 2 : -2)));
}, { passive: false });

muteBtn.addEventListener('click', () => { vid.muted = !vid.muted; volSl.value = vid.muted ? 0 : vid.volume; });
volSl.addEventListener('input', () => { vid.volume = volSl.value; });
volSl.addEventListener('wheel', e => {
  e.preventDefault();
  vid.volume = Math.max(0, Math.min(1, vid.volume + (e.deltaY > 0 ? -0.05 : 0.05)));
  volSl.value = vid.volume;
}, { passive: false });
fsBtn.addEventListener('click', () => { document.fullscreenElement ? document.exitFullscreen() : player.requestFullscreen(); });

// ═══════════════════════════════════════════════════════════════
//  TIMELINE — CANVAS
// ═══════════════════════════════════════════════════════════════
const RULER_H = 28;   // height of ruler
const BLOCK_Y = RULER_H + 6;
const EDGE_W  = 8;    // px sensitivity for edge grab

function tlH() { return tlCanvas.clientHeight; }
function blockH() { return Math.max(30, tlH() - BLOCK_Y - 10); }

function resizeTl() {
  const r = tlWrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  tlCanvas.width  = r.width  * dpr;
  tlCanvas.height = r.height * dpr;
  tlCanvas.style.width  = r.width  + 'px';
  tlCanvas.style.height = r.height + 'px';
  ctx.scale(dpr, dpr);
  clampOff();
  drawTl();
}
new ResizeObserver(resizeTl).observe(tlWrap);

function clampOff() {
  const maxOff = Math.max(0, dur * pps() - tlWrap.clientWidth);
  tlOff = Math.max(0, Math.min(maxOff, tlOff));
}

function drawTl() {
  const W = tlCanvas.clientWidth, H = tlH();
  ctx.clearRect(0, 0, W, H);

  // bg
  ctx.fillStyle = '#0d0d10';
  ctx.fillRect(0, 0, W, H);

  if (!dur) return;

  // ── Ruler ──
  ctx.fillStyle = '#141418';
  ctx.fillRect(0, 0, W, RULER_H);
  ctx.fillStyle = '#2a2a38';
  ctx.fillRect(0, RULER_H-1, W, 1);

  const minPx = 55;
  const ivs = [0.5,1,2,5,10,15,30,60,120,300,600];
  const iv = ivs.find(v => v * pps() >= minPx) || 600;
  const t0 = Math.floor(x2t(0) / iv) * iv;

  ctx.fillStyle = '#55557a';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  for (let t = t0; t <= x2t(W) + iv; t += iv) {
    const x = t2x(t);
    if (x < -2 || x > W+2) continue;
    ctx.fillStyle = '#2a2a38';
    ctx.fillRect(x, RULER_H-6, 1, 6);
    ctx.fillStyle = '#55557a';
    ctx.fillText(fmt(t), x, RULER_H - 9);
  }

  // ── Scene blocks (seamless) ──
  const BH = blockH();
  scenes.forEach((sc, i) => {
    const x = t2x(sc.start);
    const w = Math.max(2, (sc.end - sc.start) * pps());
    if (x + w < 0 || x > W) return;

    // Fill
    ctx.globalAlpha = sc.selected ? 1 : 0.55;
    ctx.fillStyle = sc.color;
    // Only round outer corners: left for first or if gap, right for last or if gap
    const isFirst = i === 0;
    const isLast  = i === scenes.length - 1;
    drawBlock(x, BLOCK_Y, w, BH, isFirst ? 5 : 0, isLast ? 5 : 0);

    // Selected highlight
    if (sc.selected) {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#fff';
      drawBlock(x, BLOCK_Y, w, BH, isFirst ? 5 : 0, isLast ? 5 : 0);
    }

    ctx.globalAlpha = 1;

    // Divider line between scenes (right edge of each non-last block)
    if (!isLast) {
      const ex = x + w;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(ex - 1, BLOCK_Y, 2, BH);
    }

    // Resize handles (left & right) — subtle white strips
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(x + (isFirst?1:0), BLOCK_Y+2, 5, BH-4);
    ctx.fillRect(x + w - 6, BLOCK_Y+2, 5, BH-4);

    // Label
    if (w > 36) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x+2, BLOCK_Y, w-4, BH);
      ctx.clip();
      ctx.font = `bold ${w > 80 ? 11 : 10}px sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,0.88)';
      const label = w > 120
        ? `S${i+1}  ${fmt(sc.start)}→${fmt(sc.end)}  (${fmt(sc.end-sc.start)})`
        : w > 70 ? `S${i+1} ${fmt(sc.end-sc.start)}` : `S${i+1}`;
      ctx.fillText(label, x + 8, BLOCK_Y + BH/2 + 4);
      ctx.restore();
    }

    ctx.globalAlpha = 1;
  });

  // ── Keyframe ticks on timeline (shown when zoom > 3x) ──
  if (tlZoom >= 3 && keyframes.length > 0) {
    const KF_COLOR = 'rgba(34,211,238,0.45)';
    keyframes.forEach(kft => {
      const kx = t2x(kft);
      if (kx < -1 || kx > W + 1) return;
      ctx.strokeStyle = KF_COLOR;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.moveTo(kx, BLOCK_Y); ctx.lineTo(kx, BLOCK_Y + BH); ctx.stroke();
      ctx.setLineDash([]);
    });
  }

  // ── Playhead ──
  const ph = t2x(vid.currentTime);
  if (ph >= 0 && ph <= W) {
    ctx.strokeStyle = '#ff4060';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(ph, 0); ctx.lineTo(ph, H); ctx.stroke();
    // triangle
    ctx.fillStyle = '#ff4060';
    ctx.beginPath(); ctx.moveTo(ph-6, 0); ctx.lineTo(ph+6, 0); ctx.lineTo(ph, 10); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawBlock(x, y, w, h, rLeft, rRight) {
  const r = 5;
  ctx.beginPath();
  ctx.moveTo(x + rLeft, y);
  ctx.lineTo(x + w - rRight, y);
  if (rRight) ctx.quadraticCurveTo(x+w, y, x+w, y+rRight);
  else ctx.lineTo(x+w, y);
  ctx.lineTo(x+w, y+h-rRight);
  if (rRight) ctx.quadraticCurveTo(x+w, y+h, x+w-rRight, y+h);
  else ctx.lineTo(x+w, y+h);
  ctx.lineTo(x+rLeft, y+h);
  if (rLeft) ctx.quadraticCurveTo(x, y+h, x, y+h-rLeft);
  else ctx.lineTo(x, y+h);
  ctx.lineTo(x, y+rLeft);
  if (rLeft) ctx.quadraticCurveTo(x, y, x+rLeft, y);
  else ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fill();
}

// ═══════════════════════════════════════════════════════════════
//  TIMELINE INTERACTIONS
// ═══════════════════════════════════════════════════════════════
function hitTest(px, py) {
  const BH = blockH();
  if (py < BLOCK_Y || py > BLOCK_Y + BH) return null;
  // Check edges first (priority)
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    const x = t2x(sc.start), w = (sc.end - sc.start) * pps();
    // Left edge (shared with prev scene's right edge)
    if (i > 0 && Math.abs(px - x) <= EDGE_W) return { idx: i, side: 'start' };
    // Right edge
    if (i < scenes.length-1 && Math.abs(px - (x+w)) <= EDGE_W) return { idx: i, side: 'end' };
  }
  // Block hit
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    const x = t2x(sc.start), w = (sc.end - sc.start) * pps();
    if (px >= x && px <= x+w) return { idx: i, side: null };
  }
  return null;
}

tlCanvas.addEventListener('mousedown', e => {
  if (e.button !== 0) return; // left click only
  const r = tlCanvas.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  const hit = hitTest(px, py);

  if (hit && hit.side) {
    // Edge drag — resize scene boundary; undo snapshot ÖNCE al
    saveUndo();
    dragging = { type: 'edge', idx: hit.idx, side: hit.side, ox: px,
      origStart: scenes[hit.idx].start, origEnd: scenes[hit.idx].end };
  } else if (hit && !hit.side) {
    // Block hit: start as potential click; becomes scrub if dragged
    const t = x2t(px);
    if (vid.fastSeek) vid.fastSeek(t); else vid.currentTime = t;
    dragging = { type: 'scrub', idx: hit.idx, ox: px, moved: false };
  } else {
    // Empty area: seek + start scrub
    const t = x2t(px);
    if (t >= 0 && t <= dur) {
      if (vid.fastSeek) vid.fastSeek(t); else vid.currentTime = t;
    }
    dragging = { type: 'scrub', idx: -1, ox: px, moved: false };
  }
});

tlCanvas.addEventListener('mousemove', e => {
  const r = tlCanvas.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;

  // Cursor
  const hit = hitTest(px, py);
  if (hit && hit.side) tlCanvas.style.cursor = 'ew-resize';
  else if (hit) tlCanvas.style.cursor = dragging?.type === 'scrub' ? 'col-resize' : 'pointer';
  else tlCanvas.style.cursor = dragging?.type === 'scrub' ? 'col-resize' : 'default';

  if (!dragging) return;

  if (dragging.type === 'scrub') {
    if (Math.abs(px - dragging.ox) >= 3) {
      dragging.moved = true;
      const t = Math.max(0, Math.min(dur, x2t(px)));
      if (vid.fastSeek) vid.fastSeek(t); else vid.currentTime = t;
      drawTl();
    }
    return;
  }

  if (dragging.type === 'edge') {
    const dt = (px - dragging.ox) / pps();
    const sc = scenes[dragging.idx];
    const MIN = 0.2;

    if (dragging.side === 'start') {
      // Moving left edge: expand/shrink this scene, shrink/expand previous
      const prev = scenes[dragging.idx - 1];
      const newStart = Math.max(
        prev ? prev.start + MIN : 0,
        Math.min(sc.end - MIN, dragging.origStart + dt)
      );
      if (prev) prev.end = newStart;
      sc.start = newStart;
    } else {
      // Moving right edge: expand/shrink this scene, shrink/expand next
      const next = scenes[dragging.idx + 1];
      const newEnd = Math.min(
        next ? next.end - MIN : dur,
        Math.max(sc.start + MIN, dragging.origEnd + dt)
      );
      if (next) next.start = newEnd;
      sc.end = newEnd;
    }

    // Seek video to the edge time for live preview
    const previewT = dragging.side === 'start' ? sc.start : sc.end;
    if (vid.fastSeek) vid.fastSeek(previewT); else vid.currentTime = previewT;

    drawTl();
    updateExpBar();
  } else if (dragging.type === 'pan') {
    tlOff = dragging.origOff - (px - dragging.ox);
    clampOff();
    drawTl();
  }
});

tlCanvas.addEventListener('mouseup', e => {
  const r = tlCanvas.getBoundingClientRect();
  const px = e.clientX - r.left;

  if (e.button === 0 && dragging?.type === 'scrub' && !dragging.moved && dragging.idx >= 0) {
    // Short left click = select/deselect
    scenes[dragging.idx].selected = !scenes[dragging.idx].selected;
    updateExpBar(); drawTl();
  }
  dragging = null;
  tlCanvas.style.cursor = 'default';
});

tlCanvas.addEventListener('mouseleave', () => { dragging = null; });

// Double-click → jump to scene start
tlCanvas.addEventListener('dblclick', e => {
  const r = tlCanvas.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  const hit = hitTest(px, py);
  if (hit && !hit.side) { vid.currentTime = scenes[hit.idx].start; vid.play().catch(()=>{}); }
});

// Right-click
let ctxIdx = -1;
tlCanvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  const r = tlCanvas.getBoundingClientRect();
  const hit = hitTest(e.clientX - r.left, e.clientY - r.top);
  if (!hit) return;
  ctxIdx = hit.idx;
  ctxMenu.style.left = e.clientX + 'px';
  ctxMenu.style.top  = e.clientY + 'px';
  ctxMenu.classList.add('on');
});
document.addEventListener('click', () => ctxMenu.classList.remove('on'));
$('ctxStart').addEventListener('click', () => { if (ctxIdx>=0) vid.currentTime=scenes[ctxIdx].start; });
$('ctxEnd').addEventListener('click', () => { if (ctxIdx>=0) vid.currentTime=Math.max(0,scenes[ctxIdx].end-0.05); });

// "Trim buraya ayarla" — moves scene boundary to current video position
$('ctxTrimStart').addEventListener('click', () => {
  if (ctxIdx < 0) return;
  saveUndo();
  const t = vid.currentTime;
  const sc = scenes[ctxIdx];
  const prev = scenes[ctxIdx - 1];
  const MIN = 0.1;
  const newStart = Math.max(prev ? prev.start + MIN : 0, Math.min(sc.end - MIN, t));
  if (prev) prev.end = newStart;
  sc.start = newStart;
  updateExpBar(); drawTl();
});
$('ctxTrimEnd').addEventListener('click', () => {
  if (ctxIdx < 0) return;
  saveUndo();
  const t = vid.currentTime;
  const sc = scenes[ctxIdx];
  const next = scenes[ctxIdx + 1];
  const MIN = 0.1;
  const newEnd = Math.min(next ? next.end - MIN : dur, Math.max(sc.start + MIN, t));
  if (next) next.start = newEnd;
  sc.end = newEnd;
  updateExpBar(); drawTl();
});
$('ctxDel').addEventListener('click', () => {
  if (ctxIdx < 0) return;
  saveUndo();
  // Remove trim edge = merge this scene with the next
  // Left scene expands, right scene is removed
  const next = scenes[ctxIdx + 1];
  if (next) {
    // Merge with right scene: current scene's end extends to right scene's end
    scenes[ctxIdx].end = next.end;
    scenes.splice(ctxIdx + 1, 1);
  } else if (ctxIdx > 0) {
    // If last scene, merge with the previous one
    scenes[ctxIdx - 1].end = scenes[ctxIdx].end;
    scenes.splice(ctxIdx, 1);
  }
  scenes.forEach((sc,i) => sc.color = scColor(i));
  scBadge.textContent = `${scenes.length} scene${scenes.length===1?'':'s'}`;
  updateExpBar(); drawTl();
});

// Wheel on timeline: Ctrl = zoom, else pan
tlWrap.addEventListener('wheel', e => {
  e.preventDefault();
  const r = tlWrap.getBoundingClientRect();
  const mx = e.clientX - r.left;
  if (e.ctrlKey) {
    // Ctrl held: zoom toward mouse position
    const tAtMouse = x2t(mx);
    tlZoom = Math.max(1, Math.min(30, tlZoom * (e.deltaY < 0 ? 1.12 : 0.89)));
    zoomSl.value = tlZoom;
    zoomLbl.textContent = tlZoom.toFixed(1)+'×';
    tlOff = tAtMouse * pps() - mx;
  } else {
    // Normal scroll: horizontal pan
    tlOff += e.deltaY > 0 ? 100 : -100;
  }
  clampOff(); drawTl();
}, { passive: false });

// Zoom via Ctrl+scroll only
// (wheel handler below handles all zooming)

// ═══════════════════════════════════════════════════════════════
//  EXPORT BAR
// ═══════════════════════════════════════════════════════════════
function updateExpBar() {
  const sel = scenes.filter(s => s.selected);
  const n = sel.length;
  expBtn.disabled = n === 0;
  clearSelBtn.style.display = n ? '' : 'none';
  if (!analyzed) {
    expInfo.innerHTML = 'Press <b>🔍 Analyze All</b> to detect scenes automatically';
    selBadge.style.display = 'none';
    return;
  }
  selBadge.style.display = n ? '' : 'none';
  selBadge.textContent = `${n} selected`;
  expInfo.innerHTML = n === 0
    ? 'Click a segment to select it · Double-click to play from that point'
    : `<b>${n} segment${n===1?'':' s'}</b> selected · total ${fmt(sel.reduce((a,s)=>a+(s.end-s.start),0))}`;
}

clearSelBtn.addEventListener('click', () => {
  scenes.forEach(s => s.selected = false);
  updateExpBar(); drawTl();
});

// Merge adjacent/overlapping selected segments before export.
// e.g. segments [1-3s][3-7s][7-10s] selected → one merged segment [1-10s]
// This prevents timestamp glitches when consecutive segments are exported.
function mergeAdjacentSegments(segs) {
  if (segs.length === 0) return [];
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  const merged = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const cur  = sorted[i];
    // Merge if current starts within 0.1s of previous end (adjacent or overlapping)
    if (cur.start <= prev.end + 0.1) {
      prev.end = Math.max(prev.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

expBtn.addEventListener('click', async () => {
  const rawSel = scenes.filter(s => s.selected).map(s => ({ start: s.start, end: s.end }));
  if (!rawSel.length) return;
  const sel = mergeAdjacentSegments(rawSel);
  const ext = (file.match(/\.([^.]+)$/) || ['','mp4'])[1];
  const base = file.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  const out = await window.api.openSaveDialog(`${base}_kesim.${ext}`);
  if (!out) return;

  // Read cut mode from UI selector
  const cutModeEl = document.getElementById('cutMode');
  const mode = cutModeEl ? cutModeEl.value : 'smart';

  expBtn.disabled = true; clearSelBtn.disabled = true;
  prog.classList.add('on'); progFill.style.width = '5%'; statLbl.textContent = 'Starting...';

  const methodLabel = { lossless: '⚡ Lossless', smart: '🧠 Smart' };

  window.api.onExportProgress(d => {
    if (d.status==='scanning')   { statLbl.textContent='Scanning video...'; progFill.style.width='5%'; }
    else if (d.status==='keyframes') { statLbl.textContent=`Finding keyframes ${d.current}/${d.total}...`; progFill.style.width=Math.round(5+(d.current/d.total)*10)+'%'; }
    else if (d.status==='cutting') {
      const m = methodLabel[d.method] || '';
      statLbl.textContent=`${m} Cutting ${d.current}/${d.total}...`;
      progFill.style.width=Math.round(15+(d.current/d.total)*70)+'%';
    }
    else if (d.status==='merging') { statLbl.textContent='Merging...'; progFill.style.width='90%'; }
    else if (d.status==='done')    { progFill.style.width='100%'; }
  });

  try {
    const fp = await window.api.exportScenes({ inputPath: originalFile || file, scenes: sel, outputPath: out, mode });
    statLbl.textContent = '✅ Done!';
    setTimeout(() => {
      window.api.showInFolder(fp);
      prog.classList.remove('on'); progFill.style.width='0%'; statLbl.textContent='';
      expBtn.disabled=false; clearSelBtn.disabled=false;
    }, 2000);
  } catch(err) {
    statLbl.textContent = '❌ ' + err.message.split('\n')[0];
    prog.classList.remove('on'); expBtn.disabled=false; clearSelBtn.disabled=false;
  }
});

// ═══════════════════════════════════════════════════════════════
//  KEYBOARD
// ═══════════════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
  if (!file || e.target.tagName==='INPUT') return;
  // Ctrl+Z — undo
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); return; }
  switch(e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case ',': e.preventDefault(); vid.currentTime=Math.max(0, vid.currentTime - 1/fps); break;
    case '.': e.preventDefault(); vid.currentTime=Math.min(dur, vid.currentTime + 1/fps); break;
    case 'ArrowUp':    e.preventDefault(); vid.volume=Math.min(1,vid.volume+0.1); volSl.value=vid.volume; break;
    case 'ArrowDown':  e.preventDefault(); vid.volume=Math.max(0,vid.volume-0.1); volSl.value=vid.volume; break;
    case 'm': case 'M': muteBtn.click(); break;
    case 'f': case 'F': fsBtn.click(); break;
  }
});

// ═══════════════════════════════════════════════════════════════
//  OPEN FILE
// ═══════════════════════════════════════════════════════════════
openBtn.addEventListener('click', async () => { const f=await window.api.openFileDialog(); if(f) loadFile(f); });
document.addEventListener('dragover', e=>e.preventDefault());
document.addEventListener('drop', e=>{ e.preventDefault(); const f=e.dataTransfer.files[0]; if(f) loadFile(f.path); });

// ═══════════════════════════════════════════════════════════════
//  KEYFRAME DISPLAY — tick strip + KF indicator
// ═══════════════════════════════════════════════════════════════
const kfStrip     = $('kfStrip');
const kfIndicator = $('kfIndicator');
const KF_NEAR_MS  = 120; // ms — "on keyframe" tolerance for indicator

// Fetch a sample of keyframes from the whole file (every ~5 seconds) for the tick strip
async function fetchKeyframesSample() {
  if (!file || !dur) return;
  keyframes = [];
  kfStrip.innerHTML = '';
  try {
    // Fetch KFs from ffprobe in chunks of 60s; for long files skip_frame makes this fast
    const kfs = await window.api.getKeyframesNear(originalFile || file, dur / 2, dur / 2 + 5);
    // For the strip we do a broader probe: entire file, just key frames
    const result = await new Promise(resolve => {
      // Use a quick whole-file keyframe extraction (skip non-reference frames)
      // We call main process via a special wide window centered at mid
      // Actually just call with a huge window to cover the whole file
      window.api.getKeyframesNear(originalFile || file, dur / 2, dur / 2 + 1).then(() => {}).catch(() => {});
      resolve([]);
    });
  } catch(e) {}
}

// Render keyframe ticks on the seekbar strip
function renderKfTicks(kfs) {
  if (!kfStrip || !dur) return;
  kfStrip.innerHTML = '';
  const W = kfStrip.offsetWidth || seekWrap.offsetWidth || 800;
  kfs.forEach(t => {
    if (t < 0 || t > dur) return;
    const pct = (t / dur) * 100;
    const tick = document.createElement('div');
    tick.className = 'kf-tick';
    tick.style.left = pct + '%';
    kfStrip.appendChild(tick);
  });
  keyframes = kfs;
}

// Check if current time is near a keyframe and show indicator
function updateKfIndicator() {
  if (!kfIndicator || keyframes.length === 0) return;
  const t = vid.currentTime;
  const near = keyframes.some(kf => Math.abs(kf - t) * 1000 <= KF_NEAR_MS);
  kfIndicator.style.display = near ? '' : 'none';
}

// After loading a file, fetch keyframes for the whole timeline
// We do a background probe — non-blocking, updates strip when done
async function fetchAndRenderAllKfs() {
  if (!file || !dur || !window.api.getKeyframesNear) return;
  try {
    // Probe the whole file by using a very wide window
    const kfs = await window.api.getKeyframesNear(originalFile || file, dur / 2, dur / 2 + 2);
    if (kfs.length > 0) renderKfTicks(kfs);
  } catch(e) {}
}

// Hook into video timeupdate for KF indicator
vid.addEventListener('timeupdate', updateKfIndicator);
vid.addEventListener('seeked', updateKfIndicator);

// Debounced KF fetch when playhead stops (e.g. after dragging a trim edge)
// to show KFs around the current position
function scheduleKfFetch() {
  if (kfFetchTimer) clearTimeout(kfFetchTimer);
  kfFetchTimer = setTimeout(async () => {
    if (!file || !dur) return;
    try {
      const t = vid.currentTime;
      const nearby = await window.api.getKeyframesNear(originalFile || file, t, 20);
      // Merge with existing keyframes (no duplicates)
      const all = [...new Set([...keyframes, ...nearby])].sort((a,b)=>a-b);
      renderKfTicks(all);
    } catch(e) {}
  }, 400);
}

vid.addEventListener('pause', scheduleKfFetch);
vid.addEventListener('seeked', scheduleKfFetch);

// ── Cut Mode badge update ─────────────────────────────────────
const cutModeEl = $('cutMode');
function updateCutModeBadge() {
  if (!cutModeEl) return;
  // Update export button label to hint the mode
  const labels = {
    smart:    '✂️ Export (Smart Cut)',
    lossless: '✂️ Export (Lossless)',

  };
  const expBtn = $('expBtn');
  if (expBtn) expBtn.textContent = labels[cutModeEl.value] || '✂️ Export';
}
if (cutModeEl) cutModeEl.addEventListener('change', updateCutModeBadge);

// ── Hook fetchAndRenderAllKfs into loadFile ────────────────────
// Patch loadFile to also trigger KF fetch after load
const _origLoadFile = loadFile;
// We'll call fetchAndRenderAllKfs from the open file handlers directly

// ═══════════════════════════════════════════════════════════════
//  PREVIEW CACHE MODAL
// ═══════════════════════════════════════════════════════════════
const cacheModal   = $('cacheModal');
const cacheInfo    = $('cacheInfo');
const cacheDirLabel= $('cacheDirLabel');

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  return (b/(1024*1024)).toFixed(1) + ' MB';
}

async function openCacheModal() {
  cacheModal.classList.add('on');
  cacheInfo.textContent = 'Checking cache…';
  cacheDirLabel.textContent = '';
  try {
    const info = await window.api.getPreviewCacheInfo();
    cacheDirLabel.textContent = info.dir;
    if (info.count === 0) {
      cacheInfo.innerHTML = 'Cache is <span>empty</span>.';
    } else {
      cacheInfo.innerHTML = `<span>${info.count}</span> preview file${info.count===1?'':'s'} · <span>${fmtBytes(info.sizeBytes)}</span>`;
    }
  } catch(e) {
    cacheInfo.textContent = 'Could not read cache.';
  }
}

$('cacheBtn').addEventListener('click', openCacheModal);
$('cacheClose').addEventListener('click', () => cacheModal.classList.remove('on'));
cacheModal.addEventListener('click', e => { if (e.target === cacheModal) cacheModal.classList.remove('on'); });

$('cacheOpenFolder').addEventListener('click', () => window.api.openPreviewFolder());

$('cacheClear').addEventListener('click', async () => {
  $('cacheClear').disabled = true;
  $('cacheClear').textContent = 'Clearing…';
  try {
    const result = await window.api.clearPreviewCache();
    cacheInfo.innerHTML = `Deleted <span>${result.deleted}</span> file${result.deleted===1?'':'s'}.`;
    cacheDirLabel.textContent = '';
  } catch(e) {
    cacheInfo.textContent = 'Failed to clear cache.';
  }
  $('cacheClear').disabled = false;
  $('cacheClear').textContent = '🗑 Clear Cache';
});
