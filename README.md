**English** · [Español](README.es.md)

# sitehound

Task-agnostic browser harness to explore, test (visual and data), analyze and clone websites. Built with TypeScript and Playwright.

It works on public sites and on sites behind a login: you sign in by hand once, and the saved session is reused in later runs.

> **Status:** early (v0.1.0). The core, the CLI and one example task (`snapshot`) exist today. See [Roadmap](#roadmap).

## Features

- **Reusable sessions.** Log in manually once; cookies, localStorage and IndexedDB are saved as a named profile and loaded with `--profile`.
- **Agnostic core.** The harness opens a browser, loads a profile and hands a page to a task. Each use case lives in its own task package.
- **Private by default.** All runtime data goes to a git-ignored `.hound/` directory with restrictive permissions.
- **Small CLI.** Five commands: `login`, `run`, `tasks`, `profiles`, `forget`.

## Requirements

- Node.js >= 22 (see `.nvmrc`)
- pnpm 12, via corepack

## Quick start

```sh
corepack enable
pnpm install
pnpm browsers        # installs Chromium for Playwright
pnpm hound run snapshot https://example.com
```

The `snapshot` task writes a full-page screenshot, the rendered HTML and basic metadata to a private run directory under `.hound/runs/snapshot/<timestamp>/`.

## Usage

```sh
pnpm hound login <url> --profile <name>      # log in by hand once; the session is saved
pnpm hound run <task> <url> [--profile <name>] [--headed] [task flags]
pnpm hound tasks                             # list available tasks
pnpm hound profiles                          # list saved profiles
pnpm hound forget <profile>                  # delete a saved profile
```

### Authenticated sites

```sh
# 1. A browser window opens. Log in, then press Enter in the terminal.
pnpm hound login https://app.example.com --profile my-app

# 2. Reuse the session in any run.
pnpm hound run snapshot https://app.example.com/dashboard --profile my-app
```

The session is stored in `.hound/profiles/my-app.json` (mode `0600`). Profile and task names accept letters, digits, `.`, `_` and `-`.

### Configuration

Copy `.env.example` to `.env` (git-ignored). The CLI loads it if present.

| Variable            | Default  | Purpose                                                              |
| ------------------- | -------- | -------------------------------------------------------------------- |
| `HOUND_HOME`        | `.hound` | Root for runtime data (profiles, runs). Must stay git-ignored.       |
| `HOUND_HEADLESS`    | `true`   | Run headless by default; `--headed` overrides it per command.        |
| `ANTHROPIC_API_KEY` | empty    | Optional. Reserved for AI-assisted tasks; unused by the current code. |

## Write a task

A task is a workspace package in `tasks/<name>/` whose `index.ts` default-exports `defineTask(...)`.

```jsonc
// tasks/page-title/package.json
{
  "name": "@sitehound/task-page-title",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": "./index.ts",
  "dependencies": { "@sitehound/core": "workspace:*" }
}
```

```ts
// tasks/page-title/index.ts
import { defineTask } from "@sitehound/core";

export default defineTask({
  name: "page-title",
  description: "Prints the title of a page.",
  async run({ page, url, outDir, args, log }) {
    await page.goto(url);
    log(`${await page.title()} (extra flags: ${JSON.stringify(args)})`);
  },
});
```

Run `pnpm install` once to link the new package, then:

```sh
pnpm hound run page-title https://example.com
```

The task receives a context with:

| Field     | Description                                                             |
| --------- | ----------------------------------------------------------------------- |
| `url`     | The URL passed on the command line.                                     |
| `page`    | A Playwright `Page`, already in a context with the chosen profile.      |
| `context` | The Playwright `BrowserContext`.                                        |
| `outDir`  | Private, git-ignored run directory: `.hound/runs/<task>/<timestamp>`.   |
| `args`    | Extra `--flags` from the command line.                                  |
| `log`     | Prefixes messages with the task name and prints them.                   |

`@sitehound/capture` provides `capturePage(page, outDir)`, used by `snapshot`, to save HTML, a screenshot and metadata.

## Project structure

```text
.
├── .claude/                 Claude Code project instructions and settings
├── .githooks/pre-commit     Blocks commits that stage sessions or secrets
├── .github/workflows/ci.yml Typecheck
├── packages/
│   ├── core/                Sessions, profiles, paths, task API
│   ├── capture/             Page capture helpers
│   └── cli/                 The `pnpm hound` command
├── tasks/
│   └── snapshot/            Example task
├── .hound/                  Runtime data (git-ignored)
├── .env.example
├── .nvmrc
├── LICENSE                  MIT
├── README.md
├── README.es.md
└── SECURITY.md
```

## Security

A saved profile grants access to the account it was created for. Treat it like a password.

- All runtime data lives in the git-ignored `.hound/`, which also contains its own `.gitignore` with `*`.
- A pre-commit hook blocks staged sessions, HAR files, traces, `.env` files, keys, and common cookie and token patterns.
- Profiles and captures are written with `0600` permissions; run directories with `0700`.
- Only `esbuild` is allowed to run install scripts.
- A pnpm minimum-release-age policy limits supply-chain exposure to freshly published packages.

See [SECURITY.md](SECURITY.md) for details and how to report a vulnerability.

## Roadmap

Planned, not implemented:

- Crawling (Crawlee)
- Visual diff (odiff)
- Network and HAR capture for data tests
- Analysis (axe-core, Lighthouse)
- Component, page and site cloning (SingleFile, wget/Browsertrix)
- AI-assisted exploration (Stagehand)
- Stealth mode (Patchright)
- Bun runtime, once Playwright support is stable

## Responsible use

Use sitehound only on sites you own or are authorized to test. Respect each site's terms of service, `robots.txt` and copyright.

## License

[MIT](LICENSE)
