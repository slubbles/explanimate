# Contributing to Explanimate

Thanks for helping. The project overview and code guide live in
[AGENTS.md](AGENTS.md) and [docs/code-map.md](docs/code-map.md); this file is
just the workflow.

## Setup

```bash
git clone https://github.com/slubbles/explanimate && cd explanimate
pnpm install
cp .env.example .env   # add keys; never commit this file
pnpm typecheck && pnpm test
```

You need Node 22+, pnpm, `ffmpeg`, and Chrome or Chromium. Tests need no API
keys.

## Checks

Before opening a PR, run:

```bash
pnpm lint
pnpm format:check   # or pnpm format to rewrite
pnpm typecheck
pnpm test
```

CI runs the same checks plus the web build and the Playwright browser tests
(`pnpm test:e2e`, `pnpm test:e2e:auth`, after a build) on every push and PR.

## Commits and PRs

- Small, auditable commits: `type(scope): plain subject`, a blank line, one
  sentence on why, then `-` bullets.
- Open a PR with a meaningful title, wait for green CI, then rebase-merge.
- No force-pushes, no pushes that skip CI.
- Never commit secrets, `.env` files, or API keys. The pre-commit secret scan
  is `scripts/check-secrets.sh`.
- Match the surrounding code: same helpers, same error shapes, same test style
  (`node:test` + `node:assert/strict`).

## Conduct

Be kind and stay on topic. The full code of conduct is
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
