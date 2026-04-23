const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

let ffmpegPath, ffprobePath;
// In packaged app, ffmpeg/ffprobe are in process.resourcesPath (extraResources)
// In dev, use the npm packages directly
if (app.isPackaged) {
  ffmpegPath  = path.join(process.resourcesPath, 'ffmpeg.exe');
  ffprobePath = path.join(process.resourcesPath, 'ffprobe.exe');
} else {
  try { ffmpegPath = require('ffmpeg-static'); ffprobePath = require('ffprobe-static').path; }
  catch(e) { ffmpegPath = 'ffmpeg'; ffprobePath = 'ffprobe'; }
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    backgroundColor: '#0d0d10',
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false
    }
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ─── helpers ─────────────────────────────────────────────────────────────────
function runFF(args, onStderr) {
  return new Promise((res, rej) => {
    const p = spawn(ffmpegPath, args);
    let err = '';
    p.stderr.on('data', d => { err += d; if (onStderr) onStderr(d.toString()); });
    p.on('close', c => c === 0 ? res() : rej(new Error(err.slice(-1500))));
    p.on('error', rej);
  });
}

function runFFprobe(args) {
  return new Promise((res, rej) => {
    const p = spawn(ffprobePath, args);
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', () => { try { res(JSON.parse(out)); } catch(e) { rej(new Error(err.slice(-500))); } });
    p.on('error', rej);
  });
}

// ─── dialogs ─────────────────────────────────────────────────────────────────
ipcMain.handle('open-file-dialog', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    filters: [
      { name: 'Video', extensions: ['mp4','mkv','mov','avi','webm','flv','m4v','wmv','ts','mts','mpg','mpeg','m2t','m2ts','3gp','mxf','ogv','vob','divx','rm','rmvb'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('open-save-dialog', async (_, name) => {
  const ext = (name.match(/\.([^.]+)$/) || ['','mp4'])[1].toLowerCase();
  const r = await dialog.showSaveDialog(mainWindow, {
    defaultPath: name || 'output.mp4',
    filters: [
      { name: ext.toUpperCase() + ' (original format)', extensions: [ext] },
      { name: 'MKV (universal — recommended)', extensions: ['mkv'] },
      { name: 'MP4', extensions: ['mp4'] },
      { name: 'Other', extensions: ['mov','avi','webm','ts'] }
    ]
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('get-video-info', async (_, fp) =>
  runFFprobe(['-v','quiet','-print_format','json','-show_format','-show_streams', fp])
);

ipcMain.handle('get-fps', async (_, fp) => {
  try {
    const info = await runFFprobe(['-v','quiet','-print_format','json','-show_streams','-select_streams','v:0', fp]);
    const st = (info.streams||[])[0];
    if (!st) return 25;
    const rfr = st.r_frame_rate || st.avg_frame_rate || '25/1';
    const [n, d] = rfr.split('/').map(Number);
    return d ? n/d : 25;
  } catch(e) { return 25; }
});

// ─── playability check ────────────────────────────────────────────────────────
const CHROMIUM_SAFE_CODECS = new Set(['h264','hevc','vp8','vp9','av1','theora']);
const CHROMIUM_SAFE_CONTAINERS = new Set(['.mp4','.mkv','.webm','.mov','.m4v','.ogv']);

ipcMain.handle('check-playability', async (_, fp) => {
  try {
    const info = await runFFprobe(['-v','quiet','-print_format','json','-show_streams','-show_format', fp]);
    const vStream = (info.streams||[]).find(s => s.codec_type === 'video');
    const ext = path.extname(fp).toLowerCase();
    const codec = vStream?.codec_name || '';
    return {
      playable: CHROMIUM_SAFE_CONTAINERS.has(ext) && CHROMIUM_SAFE_CODECS.has(codec),
      codec, ext, hasVideo: !!vStream
    };
  } catch(e) { return { playable: false, codec: '', ext: '', hasVideo: false }; }
});

// ─── preview transcoding ──────────────────────────────────────────────────────
const previewCache = new Map();

ipcMain.handle('make-preview', async (_, fp) => {
  const tmpDir = path.join(os.tmpdir(), 'scene-cutter-preview');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // Always delete ALL existing previews for this base filename before creating
  // a new one. This guarantees we never serve a stale preview regardless of
  // cache state, file size, or modification time.
  const baseName = path.basename(fp).replace(/[^a-zA-Z0-9]/g, '_');
  try {
    const existing = fs.readdirSync(tmpDir).filter(f => f.startsWith(`preview_${baseName}_`));
    for (const f of existing) {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch(_) {}
    }
  } catch(_) {}

  // Also clear this path from the in-memory cache entirely
  for (const [key] of previewCache) {
    if (key.startsWith(fp)) previewCache.delete(key);
  }

  // New unique filename: baseName + timestamp → always fresh
  const previewPath = path.join(tmpDir, `preview_${baseName}_${Date.now()}.mp4`);

  mainWindow.webContents.send('preview-progress', { status: 'converting', pct: 0 });
  await runFF([
    '-i', fp,
    '-vf', 'scale=trunc(iw/4)*2:trunc(ih/4)*2',
    '-vcodec', 'libx264', '-preset', 'ultrafast', '-crf', '28',
    '-acodec', 'aac', '-b:a', '96k',
    '-movflags', '+faststart', '-y', previewPath
  ], chunk => {
    const m = chunk.match(/time=(\d+):(\d+):([\d.]+)/);
    if (m) mainWindow.webContents.send('preview-progress', {
      status: 'converting', pct: +m[1]*3600 + +m[2]*60 + +m[3]
    });
  });
  previewCache.set(fp, previewPath);
  mainWindow.webContents.send('preview-progress', { status: 'done' });
  return previewPath;
});

// ─── keyframes near a time ────────────────────────────────────────────────────
ipcMain.handle('get-keyframes-near', async (_, fp, time, windowSec) => {
  const w = windowSec || 10;
  const from = Math.max(0, time - w);
  try {
    const info = await runFFprobe([
      '-v','quiet','-print_format','json','-select_streams','v:0',
      '-show_packets','-read_intervals', `${from}%+${w*2}`,
      '-show_entries','packet=pts_time,flags', fp
    ]);
    const kfs = (info.packets||[])
      .filter(p => p.flags && p.flags.includes('K'))
      .map(p => parseFloat(p.pts_time)).filter(t => !isNaN(t));
    if (kfs.length > 0) return kfs;
  } catch(e) {}
  // fallback
  try {
    const info2 = await runFFprobe([
      '-v','quiet','-print_format','json','-select_streams','v:0',
      '-show_frames','-read_intervals', `${Math.max(0,time-w)}%+${w*2}`,
      '-show_entries','frame=best_effort_timestamp_time,pkt_pts_time,key_frame', fp
    ]);
    return (info2.frames||[]).filter(f=>f.key_frame===1)
      .map(f=>parseFloat(f.pkt_pts_time??f.best_effort_timestamp_time)).filter(t=>!isNaN(t));
  } catch(e2) { return []; }
});

// ─── scene detection ─────────────────────────────────────────────────────────
ipcMain.handle('detect-scenes', async (_, fp, th) => new Promise((res, rej) => {
  const threshold = typeof th === 'number' ? th : 0.3;
  runFFprobe(['-v','quiet','-print_format','json','-show_format', fp]).then(info => {
    const duration = parseFloat(info.format.duration) || 0;
    const proc = spawn(ffmpegPath, ['-i', fp, '-vf', `select='gt(scene,${threshold})',showinfo`, '-vsync','0','-an','-f','null','-']);
    let stderr = '';
    proc.stderr.on('data', d => {
      const chunk = d.toString(); stderr += chunk;
      const m = chunk.match(/time=(\d+):(\d+):(\d+)/);
      if (m && duration > 0) mainWindow.webContents.send('detect-progress',
        Math.round(((+m[1]*3600 + +m[2]*60 + +m[3]) / duration) * 100));
    });
    proc.on('close', () => {
      const pts = []; const re = /pts_time:([\d.]+)/g; let m;
      while ((m = re.exec(stderr)) !== null) {
        const t = parseFloat(m[1]);
        if (!isNaN(t) && (pts.length === 0 || t - pts[pts.length-1] >= 2.0)) pts.push(t);
      }
      res({ changePoints: pts, duration });
    });
    proc.on('error', rej);
  }).catch(rej);
}));

ipcMain.handle('detect-scenes-range', async (_, fp, th, rangeStart, rangeEnd) => new Promise((res, rej) => {
  const threshold = typeof th === 'number' ? th : 0.3;
  const duration = rangeEnd - rangeStart;
  const proc = spawn(ffmpegPath, [
    '-ss', String(rangeStart), '-i', fp, '-t', String(duration),
    '-vf', `select='gt(scene,${threshold})',showinfo`, '-vsync','0','-an','-f','null','-'
  ]);
  let stderr = '';
  proc.stderr.on('data', d => {
    const chunk = d.toString(); stderr += chunk;
    const m = chunk.match(/time=(\d+):(\d+):(\d+)/);
    if (m && duration > 0) mainWindow.webContents.send('detect-progress',
      Math.round(((+m[1]*3600 + +m[2]*60 + +m[3]) / duration) * 100));
  });
  proc.on('close', () => {
    const pts = []; const re = /pts_time:([\d.]+)/g; let m;
    while ((m = re.exec(stderr)) !== null) {
      const t = parseFloat(m[1]) + rangeStart;
      if (!isNaN(t) && (pts.length === 0 || t - pts[pts.length-1] >= 2.0)) pts.push(t);
    }
    res({ changePoints: pts, rangeStart, rangeEnd });
  });
  proc.on('error', rej);
}));

// ═══════════════════════════════════════════════════════════════════════════════
//  EXPORT
//
//  Performance fix: eliminate the heavy filter_complex encode pass at merge.
//
//  Root insight: the concat demuxer with -c copy is near-instant BUT requires
//  each input file's timestamps to be continuous with the previous one.
//  If seg0 runs 0→10s and seg1 also runs 0→8s, the player gets confused.
//
//  Solution: write each piece with its CUMULATIVE timestamp offset baked in.
//  We compute the running duration total and pass it as -output_ts_offset
//  to each ffmpeg cut command. Then concat demuxer + -c copy works perfectly:
//  no decode, no encode, just a file join. Near-instant for any duration.
//
//  For the tiny re-encoded heads/tails in smart cut, we do the same — they
//  also get their cumulative offset so the final concat is always -c copy.
//
//  Modes:
//   lossless → cut each segment with -c copy + cumulative -output_ts_offset
//              → concat demuxer -c copy  (instant, no encode at merge)
//   smart    → same, but non-KF boundaries get a tiny encode first,
//              then offset-stamped copy join  (still instant at merge)
//   reencode → full filter_complex trim+concat in one pass (quality priority)
// ═══════════════════════════════════════════════════════════════════════════════
ipcMain.handle('export-scenes', async (_, { inputPath, scenes, outputPath, mode }) => new Promise(async (res, rej) => {
  const exportMode = mode || 'smart';
  const tmpDir = path.join(os.tmpdir(), 'scene-cutter-export');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const outExt = path.extname(outputPath).toLowerCase();
  const send = d => mainWindow.webContents.send('export-progress', d);

  // ── Probe source ──────────────────────────────────────────────────────────
  send({ status: 'scanning' });
  let vCodec = 'libx264', vBitrate = '4000k', aBitrate = '192k';
  let aCodec = 'aac', vPixFmt = 'yuv420p';
  let vFps = null, aSampleRate = null, aChannels = null;
  let hasAudioStream = false;

  try {
    const info = await runFFprobe(['-v','quiet','-print_format','json','-show_streams','-show_format', inputPath]);
    for (const s of (info.streams||[])) {
      if (s.codec_type === 'video') {
        const cm = { h264:'libx264', hevc:'libx265', h265:'libx265', vp9:'libvpx-vp9', vp8:'libvpx', av1:'libaom-av1', mpeg2video:'mpeg2video', mpeg1video:'mpeg1video', mpeg4:'mpeg4' };
        vCodec  = cm[s.codec_name] || 'libx264';
        vPixFmt = s.pix_fmt || 'yuv420p';
        if (s.bit_rate && parseInt(s.bit_rate) > 0) vBitrate = Math.round(parseInt(s.bit_rate)/1000)+'k';
        const rfr = s.r_frame_rate || s.avg_frame_rate;
        if (rfr) { const [n,d] = rfr.split('/').map(Number); if (d) vFps = n/d; }
      }
      if (s.codec_type === 'audio') {
        hasAudioStream = true;
        const am = { aac:'aac', mp3:'libmp3lame', opus:'libopus', vorbis:'libvorbis', flac:'flac', ac3:'ac3', eac3:'eac3', mp2:'libmp3lame', pcm_s16le:'pcm_s16le' };
        aCodec = am[s.codec_name] || 'aac';
        aSampleRate = s.sample_rate || null;
        aChannels   = s.channels   || null;
        if (s.bit_rate && parseInt(s.bit_rate) > 0) aBitrate = Math.round(parseInt(s.bit_rate)/1000)+'k';
      }
    }
    if (vBitrate === '4000k' && info.format && parseInt(info.format.bit_rate) > 0)
      vBitrate = Math.round(parseInt(info.format.bit_rate)/1000)+'k';
  } catch(e) {}

  function containerFlags(ext) {
    if (ext === '.mp4' || ext === '.m4v') return ['-movflags', '+faststart'];
    if (ext === '.ts' || ext === '.mts' || ext === '.m2ts') return ['-f', 'mpegts'];
    return [];
  }
  function vEncArgs() {
    const a = ['-vcodec', vCodec, '-b:v', vBitrate, '-pix_fmt', vPixFmt];
    if (vFps) a.push('-r', String(vFps));
    return a;
  }
  function aEncArgs() {
    const a = ['-acodec', aCodec, '-b:a', aBitrate];
    if (aSampleRate) a.push('-ar', String(aSampleRate));
    if (aChannels)   a.push('-ac', String(aChannels));
    return a;
  }

  // ── Keyframe probe ────────────────────────────────────────────────────────
  async function getKfsAround(time) {
    const WINDOW = 15;
    const from = Math.max(0, time - WINDOW);
    try {
      const info = await runFFprobe([
        '-v','quiet','-print_format','json','-select_streams','v:0',
        '-show_packets','-read_intervals',`${from}%+${WINDOW*2}`,
        '-show_entries','packet=pts_time,flags', inputPath
      ]);
      const kfs = (info.packets||[]).filter(p=>p.flags&&p.flags.includes('K'))
        .map(p=>parseFloat(p.pts_time)).filter(t=>!isNaN(t)&&t>=0).sort((a,b)=>a-b);
      if (kfs.length > 0) return kfs;
    } catch(e) {}
    try {
      const info2 = await runFFprobe([
        '-v','quiet','-print_format','json','-select_streams','v:0',
        '-show_frames','-read_intervals',`${from}%+${WINDOW*2}`,
        '-show_entries','frame=best_effort_timestamp_time,pkt_pts_time,key_frame', inputPath
      ]);
      return (info2.frames||[]).filter(f=>f.key_frame===1)
        .map(f=>parseFloat(f.pkt_pts_time??f.best_effort_timestamp_time))
        .filter(t=>!isNaN(t)&&t>=0).sort((a,b)=>a-b);
    } catch(e2) { return []; }
  }

  const sorted = [...scenes].sort((a,b) => a.start - b.start);
  const N = sorted.length;

  // ══════════════════════════════════════════════════════════════════════════
  //  FAST CONCAT: write pieces with cumulative offsets, join with -c copy
  //
  //  cutWithOffset(start, end, offset, outFile)
  //    Cuts [start,end] from inputPath, sets its first PTS to `offset`.
  //    Uses -c copy (lossless).
  //
  //  encodeWithOffset(start, end, offset, outFile)
  //    Same but re-encodes (for non-KF boundaries in smart cut).
  //
  //  After all pieces are written, concat demuxer + -c copy joins them
  //  in milliseconds — no decode/encode at merge step.
  // ══════════════════════════════════════════════════════════════════════════

  // Cut a segment losslessly and apply a timestamp offset so the output
  // file's first PTS = offsetSec. This makes concat demuxer -c copy work
  // without any timestamp gaps or overlaps.
  async function cutWithOffset(start, end, offsetSec, outFile) {
    await runFF([
      '-ss', String(start),
      '-i', inputPath,
      '-t', String(end - start),
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      // Shift all timestamps forward by offsetSec
      '-output_ts_offset', String(offsetSec),
      '-y', outFile
    ]);
  }

  // Encode a tiny segment (head or tail in smart cut) with timestamp offset
  async function encodeWithOffset(start, end, offsetSec, outFile) {
    await runFF([
      '-ss', String(start),
      '-i', inputPath,
      '-t', String(end - start),
      ...vEncArgs(), ...aEncArgs(),
      '-avoid_negative_ts', 'make_zero',
      '-output_ts_offset', String(offsetSec),
      '-y', outFile
    ]);
  }

  // Final join: concat demuxer + -c copy = near-instant, no encode
  async function joinPieces(pieces, outFile) {
    if (pieces.length === 1) {
      // Single piece: just remux container
      await runFF(['-i', pieces[0], '-c', 'copy', ...containerFlags(outExt), '-y', outFile]);
      return;
    }
    const listFile = path.join(tmpDir, `list_${Date.now()}.txt`);
    fs.writeFileSync(listFile, pieces.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
    await runFF([
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c', 'copy',
      ...containerFlags(outExt),
      '-y', outFile
    ]);
    [listFile, ...pieces].forEach(f => { try { fs.unlinkSync(f); } catch(_) {} });
  }


  // ══════════════════════════════════════════════════════════════════════════
  //  LOSSLESS MODE
  //  Cut each segment with -c copy + cumulative offset → join with -c copy.
  //  Cutting step: fast (stream copy). Merge step: instant (file join).
  // ══════════════════════════════════════════════════════════════════════════
  async function exportLossless() {
    if (N === 1) {
      send({ status: 'cutting', current: 1, total: 1, method: 'lossless' });
      await runFF(['-ss',String(sorted[0].start),'-i',inputPath,'-t',String(sorted[0].end-sorted[0].start),'-c','copy','-avoid_negative_ts','make_zero',...containerFlags(outExt),'-y',outputPath]);
      return;
    }
    const pieces = [];
    let offset = 0;
    for (let i = 0; i < N; i++) {
      send({ status: 'cutting', current: i+1, total: N, method: 'lossless' });
      const s = sorted[i];
      const dur = s.end - s.start;
      const f = path.join(tmpDir, `ll_${i}_${Date.now()}.mkv`);
      await cutWithOffset(s.start, s.end, offset, f);
      pieces.push(f);
      offset += dur;
    }
    send({ status: 'merging' });
    await joinPieces(pieces, outputPath);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SMART CUT MODE
  //  Non-KF boundaries: encode a tiny clip, offset-stamp it.
  //  KF-aligned parts: copy with offset.
  //  Merge: instant -c copy join.
  // ══════════════════════════════════════════════════════════════════════════
  async function exportSmart() {
    const KF_TOL = 0.08;

    // Step 1: probe all KFs
    send({ status: 'keyframes', current: 0, total: N });
    const segInfo = [];
    for (let i = 0; i < N; i++) {
      send({ status: 'keyframes', current: i+1, total: N });
      const s = sorted[i];
      const [kfsS, kfsE] = await Promise.all([getKfsAround(s.start), getKfsAround(s.end)]);
      const kfStart = kfsS.find(t => t >= s.start - KF_TOL);
      const kfEnd   = [...kfsE].reverse().find(t => t <= s.end + KF_TOL);
      const startOnKf = kfStart !== undefined && (kfStart - s.start) <= KF_TOL;
      const endOnKf   = kfEnd   !== undefined && (s.end - kfEnd)     <= KF_TOL;
      segInfo.push({ s, kfStart, kfEnd, startOnKf, endOnKf });
    }

    // Step 2: cut each piece with its cumulative offset
    const pieces = [];
    let offset = 0; // running total seconds written so far

    for (let i = 0; i < N; i++) {
      send({ status: 'cutting', current: i+1, total: N });
      const { s, kfStart, kfEnd, startOnKf, endOnKf } = segInfo[i];
      const uid = `${i}_${Date.now()}`;
      const segDur = s.end - s.start;

      if (startOnKf && endOnKf) {
        // Pure lossless copy — whole segment as one piece
        send({ status: 'cutting', current: i+1, total: N, method: 'lossless' });
        const f = path.join(tmpDir, `p_${uid}.mkv`);
        await cutWithOffset(s.start, s.end, offset, f);
        pieces.push(f);
        offset += segDur;

      } else if (!startOnKf && kfStart !== undefined && kfStart < s.end - 0.1) {
        // Start not on KF: encode head, copy body, maybe encode tail
        send({ status: 'cutting', current: i+1, total: N, method: 'smart' });

        const headDur = kfStart - s.start;
        const bodyEnd = (!endOnKf && kfEnd !== undefined) ? kfEnd : s.end;
        const bodyDur = bodyEnd - kfStart;
        const tailDur = (!endOnKf && kfEnd !== undefined) ? (s.end - kfEnd) : 0;

        if (headDur > 0.01) {
          const hf = path.join(tmpDir, `head_${uid}.mkv`);
          await encodeWithOffset(s.start, kfStart, offset, hf);
          pieces.push(hf);
          offset += headDur;
        }
        if (bodyDur > 0.01) {
          const bf = path.join(tmpDir, `body_${uid}.mkv`);
          await cutWithOffset(kfStart, bodyEnd, offset, bf);
          pieces.push(bf);
          offset += bodyDur;
        }
        if (tailDur > 0.01) {
          const tf = path.join(tmpDir, `tail_${uid}.mkv`);
          await encodeWithOffset(kfEnd, s.end, offset, tf);
          pieces.push(tf);
          offset += tailDur;
        }

      } else if (startOnKf && !endOnKf && kfEnd !== undefined && kfEnd > s.start + 0.1) {
        // Start on KF, end not: copy body, encode tail
        send({ status: 'cutting', current: i+1, total: N, method: 'smart' });

        const bodyDur = kfEnd - s.start;
        const tailDur = s.end - kfEnd;

        if (bodyDur > 0.01) {
          const bf = path.join(tmpDir, `body_${uid}.mkv`);
          await cutWithOffset(s.start, kfEnd, offset, bf);
          pieces.push(bf);
          offset += bodyDur;
        }
        if (tailDur > 0.01) {
          const tf = path.join(tmpDir, `tail_${uid}.mkv`);
          await encodeWithOffset(kfEnd, s.end, offset, tf);
          pieces.push(tf);
          offset += tailDur;
        }

      } else {
        // Fallback: encode whole segment
        send({ status: 'cutting', current: i+1, total: N, method: 'reencode-fallback' });
        const f = path.join(tmpDir, `p_${uid}.mkv`);
        await encodeWithOffset(s.start, s.end, offset, f);
        pieces.push(f);
        offset += segDur;
      }
    }

    // Step 3: join — near-instant, no encode
    send({ status: 'merging' });
    await joinPieces(pieces, outputPath);
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────
  try {
    if (exportMode === 'lossless') await exportLossless();
    else                        await exportSmart();

    send({ status: 'done' });
    res(outputPath);
  } catch(err) { rej(err); }
}));


ipcMain.handle('show-in-folder', async (_, fp) => shell.showItemInFolder(fp));

// ─── preview cache management ─────────────────────────────────────────────────
ipcMain.handle('get-preview-cache-info', async () => {
  const tmpDir = path.join(os.tmpdir(), 'scene-cutter-preview');
  if (!fs.existsSync(tmpDir)) return { count: 0, sizeBytes: 0, dir: tmpDir };
  const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.mp4'));
  let sizeBytes = 0;
  for (const f of files) { try { sizeBytes += fs.statSync(path.join(tmpDir, f)).size; } catch(_) {} }
  return { count: files.length, sizeBytes, dir: tmpDir };
});

ipcMain.handle('clear-preview-cache', async () => {
  const tmpDir = path.join(os.tmpdir(), 'scene-cutter-preview');
  if (!fs.existsSync(tmpDir)) return { deleted: 0 };
  const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.mp4'));
  let deleted = 0;
  for (const f of files) { try { fs.unlinkSync(path.join(tmpDir, f)); deleted++; } catch(_) {} }
  previewCache.clear();
  return { deleted };
});

ipcMain.handle('open-preview-folder', async () => {
  const tmpDir = path.join(os.tmpdir(), 'scene-cutter-preview');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  shell.openPath(tmpDir);
});
