<div align="center">

# Explanimate

**Turn any GitHub repo, article or topic into a short narrated whiteboard video.**

[![CI](https://github.com/slubbles/explanimate/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/slubbles/explanimate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Live site](https://img.shields.io/badge/live-explanimate.co-black)](https://explanimate.co)

[Website](https://explanimate.co) · [Gallery](https://explanimate.co/gallery) · [Docs](https://explanimate.co/docs) · [Architecture](docs/architecture.md)

</div>

![A frame from the Explanimate video about facebook/react: a tap on Like flowing from the browser through React and the reconciler to React DOM](docs/assets/hero-react.jpg)

<!-- DEMO_LINK -->

**Watch the demo:** [demo video](https://explanimate.co/meta-hackathon-demo-video.mp4)

## What is Explanimate?

Explanimate reads a GitHub repo, an article, an X post or a plain topic and makes a short video that draws how it works, with a voice explaining each part in plain words. Meta's Muse Spark model plans the explanation and checks every box it draws against the real files. You also get the drawing as a board you can keep editing.

## Features

- **Three formats:** Short, Deep and Anatomy, or Auto to let Muse Spark choose.
- **Tap a box:** after a repo video, tap any box for a short explanation, a 15-20 second deep dive, or "what breaks at 10x traffic?".
- **Editable boards:** download the drawing for [tldraw](https://www.tldraw.com) or [Excalidraw](https://excalidraw.com).
- **`/explanimate` in your editor:** an MCP server for Claude Code, Cursor, Codex and Muse Code that explains the folder you're in.
- **Sign-in:** a 6-digit email code, Google or GitHub. Temporary email addresses are refused.
- **Limits:** 3 videos per account per day on the hosted site, a per-IP rate limit and a spend cap.

## How it works

1. You paste a link or type a topic on the site, in the CLI or from your coding agent.
2. It reads the source. For a repo that means the file tree, manifests, entry points and configs. Secret files are never opened.
3. Muse Spark maps the parts, checks each one against the code, and writes the scenes and narration.
4. A voice reads the script, and each box draws in on the word that names it.
5. The board is rendered to a 1920x1080 MP4 with captions and exported as `.tldr` and `.excalidraw` files.
6. Before you see it, the frames are checked for cut-off words and blank frames, and the voiceover is transcribed and compared with the script.

More detail: [docs/architecture.md](docs/architecture.md).

## Built with Meta Muse models

Muse Spark (the planning and chat calls) goes through OpenRouter when `OPENROUTER_API_KEY` is set, and the Meta Model API otherwise; `EXPLANIMATE_LLM_PROVIDER` picks one explicitly. Images, SAM and the voiceover check always use the Meta Model API. See [`packages/models/src/index.ts`](packages/models/src/index.ts).

| Model                       | What it does                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `muse-spark-1.3`            | Plans the video, maps the architecture, reviews every box against real files, writes the narration, answers tap-a-box |
| `muse-voice-transcribe-1.0` | Transcribes the finished voiceover and checks it says what the script says                                            |
| `muse-image-1.0`            | Draws the doodle icons on the whiteboard                                                                              |
| `sam-3.1`                   | Finds the drawn object so each icon is cropped cleanly                                                                |

## Quick start

**Prerequisites:** Node 22+, pnpm 9 (`corepack enable` gets it), ffmpeg on your PATH, and Chrome or Chromium.

```bash
git clone https://github.com/slubbles/explanimate && cd explanimate
pnpm install
cp .env.example .env   # empty works: the app boots with no keys
pnpm dev               # web app on http://localhost:3000
```

Check that it runs:

```bash
curl -s http://localhost:3000/api/health
```

It answers `{"ok":true}` when a video can be made. With no keys the pages load but videos can't be made yet. To make videos, add `OPENROUTER_API_KEY` or `MODEL_API_KEY` to `.env`. Add `DEEPGRAM_API_KEY` for the voice; without it videos render silent with captions. The error "MODEL_API_KEY is not set" means no model key is set: add `MODEL_API_KEY` (Meta) or `OPENROUTER_API_KEY`.

- **No Chrome?** Run `npx playwright-core install chromium`, or point `EXPLANIMATE_CHROME` at an installed browser.
- **Windows:** if PowerShell refuses to run `pnpm.ps1`, use `pnpm.cmd` instead.
- **Docker:** `docker compose up` serves the same app on port 3000.
- **Command line:** `pnpm explanimate <link or "a topic">` renders one video into `explanimate-out/`. Run `pnpm explanimate --help` for options.

## Use it from your coding agent

`packages/mcp` is an MCP server that runs Explanimate on your machine. For Claude Code:

```bash
claude mcp add explanimate --transport stdio \
  --env MODEL_API_KEY=your-meta-key \
  --env DEEPGRAM_API_KEY=your-deepgram-key \
  -- node /path/to/explanimate/packages/mcp/bin/explanimate-mcp.mjs
```

Then ask `/explanimate explain this repo`. Configs for Cursor, Codex, Muse Code, Claude Desktop and VS Code are in [docs/mcp.md](docs/mcp.md) and at [explanimate.co/docs](https://explanimate.co/docs).

## Configuration

All settings live in [`.env.example`](.env.example), with a comment on each. The main ones:

| Variable                                                         | Purpose                                             |
| ---------------------------------------------------------------- | --------------------------------------------------- |
| `OPENROUTER_API_KEY`                                             | Muse Spark through OpenRouter                       |
| `MODEL_API_KEY`                                                  | Meta Model API (Muse Spark, icons, voiceover check) |
| `EXPLANIMATE_LLM_PROVIDER`                                       | Pick `meta` or OpenRouter for Muse Spark            |
| `DEEPGRAM_API_KEY`                                               | Voice (Deepgram Aura)                               |
| `CARTESIA_API_KEY`                                               | Backup voice (Cartesia Sonic)                       |
| `EXPLANIMATE_META_CAP_USD`                                       | Spend cap for Meta calls                            |
| `EXPLANIMATE_VOICE_CAP_USD`                                      | Spend cap for voice calls                           |
| `EXPLANIMATE_DAILY_VIDEOS`                                       | Videos per account per day                          |
| `EXPLANIMATE_AUTH_ENABLED`                                       | Turn sign-in on                                     |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`                          | Sign-in sessions                                    |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                       | Google sign-in                                      |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`                       | GitHub sign-in                                      |
| `EXPLANIMATE_TURNSTILE_SITE_KEY`, `EXPLANIMATE_TURNSTILE_SECRET` | Bot check on the sign-in form                       |
| `EXPLANIMATE_RENDERER`                                           | `skia` (default) or `chrome` for drawing frames     |

Before putting it on a public server, read [docs/deploy.md](docs/deploy.md).

## Project structure

```
apps/web/          Next.js site, sign-in, live progress, gallery
packages/
  core/            shared types and checks
  models/          Meta Muse, OpenRouter, Deepgram and Cartesia clients
  ingest/          reads repos, articles, X posts and topics
  planner/         brief, architecture, scenes and follow-ups (Muse Spark)
  voice/           text to speech and voiceover checks
  render/          hand-drawn canvas, Skia or Chrome frames, ffmpeg
  cli/             the `pnpm explanimate` command
  api/             local job server
  mcp/             the /explanimate MCP server
docs/              architecture, MCP setup, deploy and plugin guides
```

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Before opening a PR, run:

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
```

The tests need ffmpeg and Chrome but no API keys. Run them with no model keys exported in your shell, for example `env -u MODEL_API_KEY -u OPENROUTER_API_KEY pnpm test`. `pnpm build` builds the web app (about a minute). Report security issues as described in [SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE). Fonts and libraries are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Not affiliated with or endorsed by Meta, tldraw or Excalidraw.
