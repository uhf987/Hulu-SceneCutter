# ✂️ Scene Cutter

A fast, lossless video editor with automatic scene detection — built with Electron + FFmpeg.

![Scene Cutter Screenshot](https://raw.githubusercontent.com/yourusername/scene-cutter/main/screenshot.png)

## Features

- **🔍 Auto scene detection** — detects cuts automatically using FFmpeg's scene filter; adjustable sensitivity
- **🧠 Smart Cut** — frame-accurate cuts with near-zero quality loss: only the tiny non-keyframe boundary is re-encoded, the rest is a lossless stream copy (same approach as LosslessCut)
- **⚡ Lossless mode** — pure `-c copy`, instant, snaps to nearest keyframe
- **🔄 Re-encode mode** — full quality-matched re-encode for maximum compatibility
- **🎬 Wide format support** — MP4, MKV, MOV, AVI, WebM, TS, MXF, MPEG, DivX, and more
- **📺 MPEG / incompatible format preview** — automatically creates a low-quality H.264 proxy for playback; all cuts still use the original file
- **🗂 Preview cache manager** — see, open, and clear the proxy cache from within the app
- **Timeline** — drag trim edges, add/remove segments, undo/redo, zoom with Ctrl+scroll
- **Keyframe indicators** — cyan ticks on the seekbar and timeline show keyframe positions

## Getting Started

```bash
npm install
npm start
```

Requires [Node.js](https://nodejs.org/) ≥ 18.

## Cut Modes

| Mode | Quality | Speed | Notes |
|------|---------|-------|-------|
| **Smart Cut** | ✅ Frame-accurate | ⚡ Fast | Re-encodes only non-KF boundaries (typically < 2s per edge) |
| **Lossless** | ☑️ KF-snapped | ⚡⚡ Fastest | Pure stream copy, no re-encode at all |
| **Re-encode** | ✅ Quality-matched | 🐢 Slow | Full re-encode at source bitrate |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `,` / `.` | Step one frame back / forward |
| `↑` / `↓` | Volume up / down |
| `M` | Mute |
| `F` | Fullscreen |
| `Ctrl+Z` | Undo |
| `Ctrl+Scroll` | Zoom timeline |

## How Smart Cut Works

When you cut at a non-keyframe position:
1. FFprobe scans for the nearest keyframe **after** your start point and **before** your end point
2. The tiny segment between your cut and the keyframe is re-encoded (often < 1 second)
3. The rest of the segment is copied losslessly

This gives frame-accurate cuts while keeping 99%+ of the file as a lossless copy.

## License

MIT
