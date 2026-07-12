# 🎬 Repurpose Studio

**By Manthan Patel (@LeadGenMan)**

🔗 [LinkedIn](https://www.linkedin.com/in/leadgenmanthan/) • 📸 [Instagram](https://www.instagram.com/leadgenman/) • 📘 [Facebook](https://www.facebook.com/leadgenman/) • 🎥 [YouTube](https://www.youtube.com/@LeadGenMan) • 🎵 [TikTok](https://www.tiktok.com/@leadgenmanthan) • 🎓 [Skool Community](https://www.skool.com/ai-inner-circle/about) • 🎬 [TiltIt](https://tiltit.video) • ✏️ [PenAnywhere](https://apps.apple.com/us/app/penanywhere/id6760774183) • 🗣️ [Impromptly AI](https://impromptly.ai/)

---

A local, browser-based video editor that turns one long-form video into ready-to-post vertical Reels. Load your raw footage, pick the short you want, and it builds a 50/50 split-screen clip with captions, sound effects, transitions, and an optional Claude mascot that hops on every word.

Runs entirely on your machine. No uploads, no per-clip credits, no subscription. Your footage never leaves your laptop.

Built with Claude Code. Free to clone, personalize, and make your own.

> Want the full video pipeline? Six skills for rough cut, captions, YouTube descriptions, Instagram captions, reel overlays, and content series live in **[leadgenman-video-skills](https://github.com/manthanpatelll/leadgenman-video-skills)**, and the standalone SFX generator lives in **[soundeffects-claude-code](https://github.com/manthanpatelll/soundeffects-claude-code)**.

## What it does

- **Auto-clips long videos into shorts.** Feed it a face-cam recording and a screen recording, and it reads the transcript, finds the strongest moments, and assembles a vertical 1080x1920 Reel.
- **50/50 split screen.** Screen recording on top, face cam on the bottom, with a draggable split handle so you can favor whichever matters in each scene.
- **Auto retake removal.** Recorded a line nine times? It keeps the cleanest take and drops the rest, then tightens the silences.
- **Captions, your way.** Multiple caption styles including karaoke, bold outline, and a pixel Claude mascot that hops word to word. Fonts, colors, size, casing, bounce, all customizable.
- **Sound effects and music.** Drop contextual SFX and background music on the timeline.
- **Full manual control.** Delete words or whole scenes, reorder clips, set per-clip pan and zoom, import B-roll and screenshots as overlays, undo/redo everything.
- **Local and private.** Projects save to disk and reopen exactly as you left them, weeks later. Nothing hits a server.
- **Fast export.** Renders MP4 with your system GPU. Preview equals export, no quality loss from your raw files.

## Quick start

```bash
git clone https://github.com/manthanpatelll/repurpose-studio.git
cd repurpose-studio
npm install
npm run dev
```

Open http://localhost:3000 and you land straight in the studio.

You will also need **ffmpeg** on your PATH (used for video remux, proxies, and thumbnails). See [SETUP.md](SETUP.md) for the full step-by-step, prerequisites, and how to personalize it.

## How you use it

1. Record your long-form video (face cam + screen recording, frame-locked, same start and length).
2. Drop the two video files plus the transcript into `~/Downloads`.
3. `npm run dev`, open the studio.
4. Load your raw footage. The tool transcribes locally and populates the timeline with the keeper takes.
5. Pick the short you want, customize captions, add SFX and music, set your framing.
6. Export. Your vertical Reel downloads to `~/Downloads`, ready to post.

Full walkthrough in [SETUP.md](SETUP.md).

## Make it yours

This is a starting point, not a finished product you have to accept as-is. It was built with Claude Code from plain-English prompts, and you can extend it the same way:

- Add your own caption templates (open Claude Code, describe the style you want, preview it as an Artifact, then import the one you like).
- Swap the Claude mascot for your own brand character.
- Change the split ratios, transitions, fonts, and colors to match your channel.
- Wire in your own sound effect library.

You do not need to write code. Open Claude Code in your terminal, tell it what you want, and let it build the feature.

## Tech stack

Next.js 15 (App Router), React 19, TypeScript, Canvas 2D (no WebGL), Zustand, WebCodecs + Mediabunny for export, Tailwind v4, shadcn/ui. Local-only, not deployed anywhere.

## 🎓 Join the community

I share how I build tools like this with Claude Code, plus the rest of my content workflow, inside my free Skool community.

👉 **[Join the AI Inner Circle on Skool (free)](https://www.skool.com/ai-inner-circle/about)**

## 🔗 Connect with me

* Instagram: https://www.instagram.com/leadgenman/
* LinkedIn: https://www.linkedin.com/in/leadgenmanthan/
* Facebook: https://www.facebook.com/leadgenman/
* TikTok: https://www.tiktok.com/@leadgenmanthan
* YouTube: https://www.youtube.com/@LeadGenMan
* Community: https://www.skool.com/ai-inner-circle/about

## 🚀 My products

* TiltIt: https://tiltit.video
* PenAnywhere: https://apps.apple.com/us/app/penanywhere/id6760774183
* Impromptly AI: https://impromptly.ai/

## Credits

- Built with [Claude Code](https://claude.com/claude-code) by [Anthropic](https://anthropic.com).
- Claude mascot pixel art inspired by the [Claude Code Mascot Generator](https://claude-code-mascot-generator.replit.app/).

## License

MIT. See [LICENSE](LICENSE). Use it, fork it, ship it.

---

⭐ **If this saved you time, star the repo and [join the community](https://www.skool.com/ai-inner-circle/about).**
