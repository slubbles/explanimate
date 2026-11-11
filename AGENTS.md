# Explanimate: contributor and coding-agent guide

This file is the single entry point for anyone picking up the project: what it is,
how to run it, how the code fits together, and the conventions to follow.
For the deeper code guide, see [`docs/code-map.md`](docs/code-map.md).

## 1. What it is

Explanimate turns a GitHub repo, an article, an X post, or a plain topic
("how DNS works") into a narrated, hand-drawn whiteboard explainer video (mp4),
plus the same drawing as `.tldr` and `.excalidraw` boards.

- Public site: https://explanimate.co
- Repo: https://github.com/slubbles/explanimate (`main` is the only branch; keep it shippable)
- License: MIT. The footer wording "Powered by Meta Muse models" stays wherever it is.

## 2. How to run

Prerequisites: Node 22+, pnpm, `ffmpeg` on PATH, and Chrome or Chromium.
Keys live in a gitignored `.env` file (see [`.env.example`](.env.example));
never print, commit, or send key values anywhere.

```bash
git clone https://github.com/slubbles/explanimate && cd explanimate
pnpm install
cp .env.example .env   # add OPENROUTER_API_KEY; MODEL_API_KEY for icons and the
                       # voiceover check; DEEPGRAM_API_KEY for the voice
pnpm typecheck
pnpm test
pnpm explanimate https://github.com/milind-soni/OpenMausBot --out ./out/openmausbot
pnpm web               # web app on http://localhost:3000
```

Notes:

- Without a Deepgram key the video renders silent, with timed captions.
- Chrome is found in its standard install folders; set `EXPLANIMATE_CHROME` otherwise.
- On Windows, if PowerShell refuses to run `pnpm.ps1`, use `pnpm.cmd ...` instead.
- CLI flags: `--out <dir>`, `--fresh` (plan again, ignore caches), `--no-qa`.
  `pnpm explanimate --help` lists the rest.
- Each run writes `plan.json`, `architecture.json`, `manifest.json`, the mp4,
  both boards, and a contact sheet into the out dir.

## 3. Architecture

| Package            | Owns                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ingest`  | Fetches repos, articles, X posts, and cited sources for plain topics. SSRF guard, size limits, timeouts; secret-looking files are never opened.                |
| `packages/planner` | Brief, architecture map plus review, scene plan, self-checks, narration polish, speech gate, per-line beats.                                                   |
| `packages/models`  | Muse Spark client: OpenRouter (`meta/muse-spark-1.3`) when `OPENROUTER_API_KEY` is set, else the Meta Model API. Cost ledger, timeouts, retries, hedged calls. |
| `packages/voice`   | Deepgram Aura TTS with word timings; Muse Transcribe voiceover check.                                                                                          |
| `packages/render`  | Board layout, line cards, composition, placement check, Skia frames (Chrome fallback), frame check, ffmpeg, music and sound effects.                           |
| `packages/core`    | Shared schemas, plain-language rules, pacing, text helpers.                                                                                                    |
| `packages/cli`     | `pnpm explanimate <link or topic>`; `pipeline.ts` runs the stages.                                                                                             |
| `packages/api`     | Local job API on 127.0.0.1:7311 (`/v1/jobs`).                                                                                                                  |
| `packages/mcp`     | `/explanimate` MCP server (`explain`, `explain_status`, `explain_cancel`).                                                                                     |
| `apps/web`         | Next.js app: job queue, gallery (`/gallery`), voice mode, spend guard, rate limits, `/api/health`.                                                             |

Pipeline stages (`packages/cli/src/pipeline.ts`): ingest, brief, architecture
(repos), scene plan, voice, compose, render and encode. Plans (per repo commit),
voice, repos, and icons are cached. Details live in
[`docs/code-map.md`](docs/code-map.md); the explainer rules live in
[`docs/explaining-playbook.md`](docs/explaining-playbook.md).

## 4. Key decisions and why

- **Muse Spark through OpenRouter is the default LLM path.** `MODEL_API_KEY`
  is still needed for doodle icons and the voiceover check.
- **Skia renders by default, with Chrome as the fallback.** It is faster;
  Chrome also backs the frame check.
- **Plan and narration calls are raced (hedged)** to cut wait time.
- **One visual per narration line.** Every line gets a beat (`title`, `board`,
  `kinetic`, `chips`, `terminal`, `output`, `browser`, `number`, `contrast`,
  `doodle`); on-screen words are spoken in that same line and synced to their
  anchor words. Cards whose words are not said are demoted by `checkBeats`.
- **Every fact is grounded in the README and the code.** Real part names, each
  explained in one plain clause; familiar tools appear as text chips, never logos.
- **Settled shots hold every lit box a margin inside the frame** (`EDGE_PX` in
  `packages/render/src/placement.ts`).
- **Old `EXPLAINLIKE_*` setting names still work** as a silent fallback
  (the `EXPLANIMATE_*` name wins); pre-rename output folders are still used
  when the new ones do not exist.
- **Private links are refused everywhere by default** (CLI, local API, MCP),
  with `--allow-private` for local intranet use only.

## 5. Conventions

- Small, auditable commits: `type(scope): plain subject`, a blank line, one
  sentence on why, then `-` bullets.
- Open a PR with a meaningful title, wait for green CI, then rebase-merge.
- No force-push, no pushes that skip CI, no commits with secrets in them.
- Match the surrounding code: same helpers, same error shapes, same test style
  (`node:test` + `node:assert/strict`, one file per area under `test/`).
- See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor notes.

## 6. Checks and CI

```bash
pnpm typecheck                     # tsc, must be clean
pnpm lint                          # eslint, must be clean
pnpm format:check                  # prettier, must be clean (pnpm format rewrites)
pnpm test                          # node:test across packages and the web app
pnpm --filter @explanimate/web build
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs lint,
format:check, typecheck, tests, the web build, and the Playwright browser tests
(`pnpm test:e2e`, `pnpm test:e2e:auth`, which use a stand-in pipeline and cost
nothing) on every push and PR. The required check on `main` is `check`.
The tests need `ffmpeg` and Chrome but no API keys. The Skia tests need the
`@napi-rs/canvas` native module; CI installs it.

## 7. Deployment

The app ships as a Docker container; [`docs/deploy.md`](docs/deploy.md) has the
generic recipe (any VPS, Docker, Caddy or Cloudflare in front). The maintainer
keeps private deployment notes outside the repo.
