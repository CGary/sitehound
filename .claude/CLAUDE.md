# sitehound

Task-agnostic browser harness (TypeScript + Playwright) to explore, test, analyze and clone websites. Users log in by hand once; the session is saved as a reusable **profile** and loaded by later runs.

To USE sitehound as an agent (browsing, tests, scraping, component capture), follow AGENTS.md (CLI-first; the agent skill is in `.claude/skills/sitehound/SKILL.md`).

## Architecture

- `packages/core`: task-agnostic. Session and browser (`openSession`, `openBrowserSession`), profiles, paths (`ensurePrivateDir`, `assertSafeName`), task contract (`defineTask`, `createRunDir`), `errors.ts` (`HoundError`, `ERROR_CODES`, `USAGE_ERROR_CODES`, the public error contract: never rename codes). `run.ts` (`runTask`) runs a task in a fresh session and always writes a redacted `result.json`. `session.ts` holds the heuristic session check (`checkSession`) and cookie stats. `redact.ts` strips query strings and fragments from recorded URLs and error messages. `trace.ts` and `zip.ts` turn a raw Playwright trace into a redacted `debug-trace.zip` and `steps.json`; the raw zip is parsed only there and always deleted. `browserd/` is the browser daemon: one detached Node process per session that owns one Chromium, one context and its pages, listening on a unix socket under `.hound/sessions/<name>/`. Must not contain task-specific logic.
- `packages/capture`: reusable capture helpers (`capturePage`, `captureText`, `captureElement`) that tasks compose.
- `packages/cli`: the CLI (`bin/hound`, also `pnpm hound`). `src/index.ts` is the entrypoint. `src/framework/` is the generic CLI machinery (argument parsing, registry, envelope and exit codes, help, `--schema`, `lifecycle.ts` process guards). Every validation rule (min/max, pattern, maxLength, `requires`, `requiresWhen`, `confirm`) is declared on the command and shown by `--schema`; add rules there, not in `run`. Final output goes through `claimOutput()` so exactly one envelope is written; `process.exit` is intercepted while a task/script runs. `src/commands/` holds one file per domain (`browser`, `page`, `element`, `diag`, `profile`, `task`, `script`) plus `legacy.ts` (deprecated aliases) and `runner.ts`. `mcp.ts` is the deprecated Playwright MCP bridge.
- `tasks/<name>/`: one workspace package per task, `index.ts` default-exports `defineTask({ name, description, run })`. Loaded dynamically by the CLI.
- `bin/hound`: shell wrapper. It resolves the repo root from its own path, runs `node packages/cli/src/index.ts` through `fnm exec --using=.nvmrc`, and never changes the caller's cwd.

## Commands

- `fnm use`: switch to the Node version in `.nvmrc` (the Node version lives only there).
- Agent shells may not load the fnm hook: prefix every command with `fnm exec --using=.nvmrc --` (e.g. `fnm exec --using=.nvmrc -- pnpm typecheck`). Install with `fnm exec --using=.nvmrc -- corepack pnpm install`; an engine error from pnpm means the wrong Node, not a dependency problem.
- `corepack pnpm install`: install deps (also sets `core.hooksPath=.githooks`).
- `pnpm typecheck`: `tsc -p tsconfig.json`; run before finishing any change.
- `pnpm browsers`: install Chromium for Playwright.
- `bin/hound <domain> <verb> [flags]`: run the CLI from anywhere (`pnpm hound ...` also works). Domains: `browser`, `page`, `element`, `diag`, `profile`, `task`, `script`. Deprecated: `mcp`, and the legacy aliases `login run exec check tasks profiles forget`.
- `bin/hound task run --task <name> --url <url>`: run a built-in task (`snapshot`, `component`).
- `bin/hound profile check --profile <name>`: is the saved session still valid? Data in `data.state`; exit 0 on success.

## Conventions

- ESM only (`"type": "module"`), strict TypeScript, `node:` prefix for builtins.
- No build step and no tsx. The CLI runs its TypeScript sources directly with Node's native type stripping. `tsconfig.base.json` sets `erasableSyntaxOnly`, so use only erasable syntax (no enums, no namespaces, no parameter properties).
- Packages export `.ts` (`"exports": "./src/index.ts"`).
- Inside a package, import with an explicit `.ts` extension (`./paths.ts`); across packages, import by name (`@sitehound/core`).
- Keep dependencies minimal; prefer Node/Playwright built-ins over new packages.
- Runtime is Node (>=22, pinned in `.nvmrc`). Bun later once Playwright support is stable. Stay runtime-portable: `node:` APIs, `.ts` extension imports, no Node-only hacks.

## Adding a task

1. Create `tasks/<name>/package.json` (copy `tasks/snapshot`: `"type": "module"`, `"exports": "./index.ts"`, `workspace:*` deps on `@sitehound/core` / `@sitehound/capture`).
2. Create `tasks/<name>/index.ts` with `export default defineTask({ name, description, async run({ page, url, outDir, args, log }) {...} })`.
3. Write output only under `outDir` (from `createRunDir`); reuse `@sitehound/capture` helpers, and put anything reusable there rather than in the task.
4. `corepack pnpm install`, `pnpm typecheck`, `bin/hound task list --json`.

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
