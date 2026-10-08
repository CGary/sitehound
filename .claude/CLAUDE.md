# sitehound

Task-agnostic browser harness (TypeScript + Playwright) to explore, test, analyze and clone websites. Users log in by hand once; the session is saved as a reusable **profile** and loaded by later runs.

To USE sitehound as an agent (tests, scraping, component capture), follow AGENTS.md.

## Architecture

- `packages/core` — task-agnostic: session/browser (`openSession`), profiles, paths (`ensurePrivateDir`, `assertSafeName`), task contract (`defineTask`, `createRunDir`). `run.ts` (`runTask`) runs a task in a fresh session and always writes a redacted `result.json`; `session.ts` holds the heuristic session check (`checkSession`) and cookie stats; `redact.ts` strips query strings and fragments from recorded URLs and error messages; `trace.ts` + `zip.ts` turn a raw Playwright trace into a redacted `debug-trace.zip` + `steps.json` (`runTask({ trace })`, CLI `--trace`; the raw zip is parsed only there and always deleted). Must not contain task-specific logic.
- `packages/capture` — reusable capture helpers (e.g. `capturePage`) that tasks compose.
- `packages/cli` — `pnpm hound` entrypoint (`login`, `run`, `exec`, `check`, `mcp`, `tasks`, `profiles`, `forget`). `mcp.ts` wraps the official Playwright MCP server with a profile preloaded in memory.
- `tasks/<name>/` — one workspace package per task, `index.ts` default-exports `defineTask({ name, description, run })`. Loaded dynamically by the CLI.

## Commands

- `fnm use` — switch to the Node version in `.nvmrc` (reads `.nvmrc`; the Node version lives only there)
- Agent shells may not load the fnm hook: prefix every command with `fnm exec --using=.nvmrc --` (e.g. `fnm exec --using=.nvmrc -- pnpm typecheck`). Install with `fnm exec --using=.nvmrc -- corepack pnpm install`; an engine error from pnpm means the wrong Node, not a dependency problem.
- `corepack pnpm install` — install deps (also sets `core.hooksPath=.githooks`)
- `pnpm typecheck` — `tsc -p tsconfig.json`; run before finishing any change
- `pnpm browsers` — install Chromium for Playwright
- `pnpm hound <login|run|exec|check|mcp|tasks|profiles|forget> ...` — run the CLI
- `pnpm hound exec <file.ts> <url> [--profile <name>]` — run a single-file script; writes `result.json`
- `pnpm hound check <profile>` — is the saved session still valid? Exit 0 valid, 2 expired, 3 unknown
- `pnpm hound mcp [--profile <name>] [--headed]` — Playwright MCP server over stdio, profile preloaded

## Conventions

- ESM only (`"type": "module"`), strict TypeScript 7, `node:` prefix for builtins.
- No build step: `tsx` runs the sources directly. Packages export `.ts` (`"exports": "./src/index.ts"`).
- Inside a package, import with an explicit `.ts` extension (`./paths.ts`); across packages, import by name (`@sitehound/core`).
- Keep dependencies minimal; prefer Node/Playwright built-ins over new packages.
- Runtime is Node (>=22) now; Bun later once Playwright support is stable. Stay runtime-portable: `node:` APIs, `.ts` extension imports, no Node-only hacks.

## Adding a task

1. Create `tasks/<name>/package.json` (copy `tasks/snapshot`: `"type": "module"`, `"exports": "./index.ts"`, `workspace:*` deps on `@sitehound/core` / `@sitehound/capture`).
2. Create `tasks/<name>/index.ts` with `export default defineTask({ name, description, async run({ page, url, outDir, args, log }) {...} })`.
3. Write output only under `outDir` (from `createRunDir`); reuse `@sitehound/capture` helpers, and put anything reusable there rather than in the task.
4. `corepack pnpm install`, `pnpm typecheck`, `pnpm hound tasks`.

## HARD security rules (never violate)

- NEVER read, print, copy, summarize or commit `.hound/profiles/` (profiles are bearer credentials), `.env` files, HAR files or Playwright traces. This includes `cat`, `grep`, and pasting them into output or commits. Tasks that need network data must write a redacted derivative (no cookies/auth headers) to `outDir`.
- Run outputs in `.hound/runs/` MAY be read for analysis, but NEVER committed, published or sent to external services.
- All runtime output goes through `createRunDir` / `ensurePrivateDir` (dirs 0700, files 0600). Any new file writer must set `mode: 0o600` and use a private dir.
- NEVER weaken `.gitignore` or `.githooks/pre-commit` (no removed patterns, no loosened scans).
- NEVER use `git commit --no-verify` or otherwise bypass the hook. If the hook blocks a commit, unstage and fix the cause.
- A new dependency that needs install scripts must be explicitly added to `allowBuilds` in `pnpm-workspace.yaml`, with a justification in the PR/commit. Default is not allowed.
- Respect pnpm's minimum release age. NEVER add `minimumReleaseAgeExclude`; wait or pick an older version.
- Commit `pnpm-lock.yaml`; do not add `.npmrc` with credentials.
- Captures of authenticated pages may contain tokens/PII: never log or echo page content, cookies or headers to the console.
