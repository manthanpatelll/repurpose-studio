# Setup Guide

Step-by-step to get Repurpose Studio running on your machine, plus how to personalize it. No coding required.

## 1. Prerequisites

Install these first.

### Node.js 20 or newer

Check what you have:

```bash
node --version
```

If you see `v20` or higher, you are good. If not, install it from [nodejs.org](https://nodejs.org/) (pick the LTS build) or with a version manager like [nvm](https://github.com/nvm-sh/nvm).

### ffmpeg (required)

Repurpose Studio uses ffmpeg to remux video, generate playback proxies, and make thumbnails. Without it the studio still opens, but playback falls back to your raw files and thumbnails will not show.

Check:

```bash
ffmpeg -version
ffprobe -version
```

Install if missing:

- **macOS** (with [Homebrew](https://brew.sh/)): `brew install ffmpeg`
- **Windows**: download from [ffmpeg.org](https://ffmpeg.org/download.html) and add it to your PATH, or `winget install ffmpeg`
- **Linux**: `sudo apt install ffmpeg` (Debian/Ubuntu) or your distro's equivalent

### Git

Check with `git --version`. Install from [git-scm.com](https://git-scm.com/) if needed.

## 2. Clone and install

```bash
git clone https://github.com/manthanpatelll/repurpose-studio.git
cd repurpose-studio
npm install
```

`npm install` pulls all the dependencies (about 400 packages). This takes a minute the first time.

## 3. Run it

```bash
npm run dev
```

Open **http://localhost:3000** in your browser. You land directly in the studio.

To stop the server, press `Ctrl + C` in the terminal.

## 4. Prepare your footage

The tool works best with two frame-locked recordings:

- **Face cam** recording (you talking)
- **Screen recording** (your screen)

Frame-locked means both start at the same moment and are the same length and frame rate. If you record both at once (for example in Descript or with a screen recorder that also captures your camera), they will be aligned.

Put the video files in one of these folders so the studio can read them:

- `~/Downloads`
- `~/Desktop`
- `~/Documents`
- `~/Movies`

These are the allow-listed roots. The app only reads local files from inside them.

## 5. Build your first short

1. In the studio, load your **raw footage** (face cam + screen recording).
2. The tool transcribes locally and fills the timeline with the clean keeper takes, retakes removed and silences tightened.
3. Pick the section you want to clip into a short.
4. Choose a caption style. Try the Claude mascot styles for the hopping-mascot look, or a clean karaoke style.
5. Adjust framing: drag the split handle, set pan and zoom per scene, import screenshots or B-roll as overlays.
6. Add sound effects and background music from the bottom panels (optional).
7. Click **Export**. Your vertical 1080x1920 MP4 downloads to `~/Downloads`. What you preview is exactly what exports.

Press `?` in the studio for the full keyboard shortcut list.

## 6. Where your data lives

Everything stays on your machine:

- **Projects**: `~/Downloads/repurpose-projects` (JSON, reopen anytime and it is exactly as you left it)
- **Overlays and SFX**: `~/Downloads/repurpose-overlays`
- **Playback proxy cache**: your system temp folder (auto-managed, 10 GB budget, cleaned after 30 days)

Nothing is uploaded. There is no account, no server, no cloud.

## 7. Personalize it (the fun part)

This repo is a starting point. Open **Claude Code** in the project folder and describe what you want changed in plain English. Some ideas:

- **New caption templates**: "Create a caption style with a glow effect." Claude builds a preview page you can view before adding it to the app.
- **Swap the mascot**: replace the Claude pixel mascot with your own brand character.
- **Change the look**: different fonts, colors, split ratios, transitions.
- **Your own sound library**: point the SFX panel at your own effects.

You describe the feature, Claude writes the code, you approve it. That is the whole workflow.

## Optional: automatic sound effects engine

The "generate SFX" button expects a small Python sound-effects engine at `scripts/sfx-engine/build_sfx_track.py`, which is not shipped in this repo. Everything else works without it. If you want to add your own, point the app at your engine directory with an environment variable:

```bash
REPURPOSE_SFX_ENGINE_DIR=/path/to/your/sfx-engine npm run dev
```

## Troubleshooting

- **Thumbnails or previews not loading** → ffmpeg is not on your PATH. See step 1.
- **A video file will not load** → make sure it is inside one of the allow-listed folders (`~/Downloads`, `~/Desktop`, `~/Documents`, `~/Movies`).
- **Port 3000 already in use** → run on another port: `npm run dev -- -p 3001`, then open http://localhost:3001.
- **Export button does nothing** → check the browser console. Export uses WebCodecs, which needs a recent Chrome, Edge, or Chromium-based browser.

## Questions

This is a community giveaway project. Fork it, break it, rebuild it however you like.
