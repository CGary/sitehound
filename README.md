**English** · [Español](README.es.md)

# sitehound

Task-agnostic browser harness to explore, test (visual and data), analyze and clone websites. Built with TypeScript and Playwright.

It works on public sites and on sites behind a login: you sign in by hand once, and the saved session is reused in later runs.

> **Status:** early (v0.1.0). The core, the CLI, two built-in tasks (`snapshot`, `component`), single-file `exec` scripts, `check` and an MCP bridge exist today. See [Roadmap](#roadmap).

## Features

- **Reusable sessions.** Log in manually once; cookies, localStorage and IndexedDB are saved as a named profile and loaded with `--profile`.
- **Agnostic core.** The harness opens a browser, loads a profile and hands a page to a task. Each use case lives in its own task package, or in a single-file script.
- **Structured results.** Every run writes a `result.json` with checks, errors, failed requests and session state.
- **Agent-ready.** Scripts for repeatable tests, and an MCP server preloaded with a profile. See [AGENTS.md](AGENTS.md).
- **Private by default.** All runtime data goes to a git-ignored `.hound/` directory with restrictive permissions.
- **Small CLI.** `login`, `run`, `exec`, `check`, `mcp`, `tasks`, `profiles`, `forget`.

## Requirements

- Node.js 22.22.2, pinned in `.nvmrc` (the only place the Node version is set)
- pnpm 12, via corepack
- AI agents: see [AGENTS.md](AGENTS.md) ("Running commands") for running commands through fnm with the pinned Node.

## Quick start

Install [fnm](https://github.com/Schniz/fnm) and add its shell hook once, so Node switches version when you enter the repo:

```sh
# fish (config.fish)
fnm env --use-on-cd | source
# bash / zsh (.bashrc / .zshrc)
eval "$(fnm env --use-on-cd)"
```

Then:

```sh
fnm install          # reads .nvmrc
fnm use
corepack enable
pnpm install
pnpm browsers        # installs Chromium for Playwright
pnpm hound run snapshot https://example.com
```

If you use nvm instead, `nvm use` also reads `.nvmrc`.

The `snapshot` task writes a full-page screenshot, the rendered HTML, visible text, an accessibility tree and basic metadata to a private run directory under `.hound/runs/snapshot/<timestamp>/`, plus a `result.json`.

## Usage

```sh
pnpm hound login <url> --profile <name>      # log in by hand once; the session is saved
pnpm hound run <task> <url> [--profile <name>] [--headed] [task flags]
pnpm hound exec <file.ts> <url> [--profile <name>] [--headed] [flags]
pnpm hound check <profile>                   # is the saved session still valid? (0 valid, 2 expired, 3 unknown)
pnpm hound mcp [--profile <name>] [--headed] [-- <@playwright/mcp flags>]
pnpm hound tasks                             # list available tasks
pnpm hound profiles                          # list saved profiles
pnpm hound forget <profile>                  # delete a saved profile
```

Flags accept `--key value` or `--key=value`. A flag with no value is `true`. Task flags go after the URL.

### Authenticated sites

```sh
# 1. A browser window opens. Log in, then press Enter in the terminal.
pnpm hound login https://app.example.com --profile my-app

# 2. Check that the session is still valid before a logged-in job.
pnpm hound check my-app

# 3. Reuse the session in any run.
pnpm hound run snapshot https://app.example.com/dashboard --profile my-app
```

The session is stored in `.hound/profiles/my-app.json` (mode `0600`). Profile and task names accept letters, digits, `.`, `_` and `-`.

`check` opens the profile, navigates to the page where you logged in, and reports `valid`, `expired` or `unknown` with a reason. The check is a heuristic: it looks for login forms and login-like URLs.

### Exec scripts

An `exec` script is a single `.ts` file with no imports. Its default export receives a context with `page`, `url`, `outDir`, `args`, `log` and `check`:

```ts
// .hound/scripts/home-h1.ts
export default async function ({ page, url, check }) {
  const response = await page.goto(url, { waitUntil: "load" });
  check("HTTP 2xx", response?.ok() === true, `status ${response?.status()}`);
  check("h1 is visible", await page.getByRole("heading", { level: 1 }).isVisible());
  return { summary: "Home page shows a visible h1" };
}
```

```sh
pnpm hound exec .hound/scripts/home-h1.ts https://example.com
```

Scripts are meant for tests and reports. Keep them in `.hound/scripts/`, which is git-ignored.

### Configuration

Copy `.env.example` to `.env` (git-ignored). The CLI loads it if present.

| Variable            | Default  | Purpose                                                              |
| ------------------- | -------- | -------------------------------------------------------------------- |
| `HOUND_HOME`        | `.hound` | Root for runtime data (profiles, runs). Must stay git-ignored.       |
| `HOUND_HEADLESS`    | `true`   | Run headless by default; `--headed` overrides it per command.        |
| `ANTHROPIC_API_KEY` | empty    | Optional. Reserved for AI-assisted tasks; unused by the current code. |

## Results (result.json)

Every `run` and `exec` writes `result.json` into its run directory. Exit code is `0` for `pass` and `1` otherwise.

| Field             | Meaning                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `status`          | `pass`, `fail` or `error` (the task threw, or the browser could not start).              |
| `summary`         | One-line result, from the task.                                                          |
| `checks`          | Named assertions: `{ name, ok, detail? }`. Any failed check makes the run `fail`.        |
| `data`            | Whatever the task returned as `data`.                                                    |
| `consoleErrors`   | Browser console errors, with the script location.                                        |
| `pageErrors`      | Uncaught exceptions in the page.                                                         |
| `failedRequests`  | Requests that failed, or responses with HTTP 400 or higher. Query strings are removed.   |
| `session`         | With `--profile` only: `state` (`valid`, `expired`, `unknown`), `reason`, cookie counts. |
| `trace`           | With `--trace` only: `{ file, steps, actions, redactions }`, or `{ error }`. See below.  |
| `files`           | Every file in the run directory, including `result.json`.                                |

URLs in results have their query strings and fragments removed. Headers, cookies and response bodies are never recorded. If a run fails, a `failure.png` screenshot is saved next to it.

### Clean trace

Add `--trace` to `run` or `exec` to record a Playwright trace. `--trace on-failure` keeps it only when the run is not a `pass`. Raw traces contain cookies, auth headers, request bodies and form values, so sitehound never keeps one: it records into a private temporary directory, writes a redacted copy, and always deletes the raw file, even if cleaning fails.

```sh
pnpm hound exec .hound/scripts/login-test.ts https://example.com --profile work --trace on-failure
pnpm exec playwright show-trace .hound/runs/exec-login-test/<timestamp>/debug-trace.zip
```

| File              | Content                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `debug-trace.zip` | The cleaned trace. Opens in `playwright show-trace`: actions, DOM snapshots, console, network list. No screencast. |
| `steps.json`      | Ordered actions (title, selector, redacted params, start time, duration, error) and console errors, so an agent can debug without unzipping. |

`result.json` → `trace.redactions` counts what was removed (`headers`, `cookies`, `bodies`, `inputValues`, `urls`). If cleaning fails, `trace` holds a short `error` and no partial file is kept.

What the clean trace keeps: action names, selectors and timings; the DOM structure and visible page text of each snapshot; CSS, images and fonts; the network list (method, status, content type, sizes, timings) with URLs reduced to origin and path; error and warning console text (redacted, 300 characters at most); error messages cut to a safe length.

What it removes, conservatively:

- Screencast: no screenshots or video frames are recorded, because pixels can show typed values. The DOM snapshots (with form values blanked) are the visual record. `failure.png` is a separate, explicit artifact, not part of the trace.
- Network: every header except `content-type`, `content-length`, `accept`, `cache-control` and `location` (without query); cookies, query lists and request bodies; response bodies except CSS, images and fonts; query strings and fragments in every URL; token-like path segments (shown as `:token`).
- Context options: storage state, extra headers, HTTP credentials, proxy and client certificates.
- Actions: the values of every value-entry call (`fill`, `type`, `pressSequentially`, `selectOption`, `setInputFiles`, keyboard text, printable key presses), in params, titles, call logs and error text, whatever the selector; code and markup params (`evaluate` expressions, init scripts, `setContent` HTML); evaluate arguments and return values other than numbers and booleans; any parameter whose name looks like a secret.
- DOM snapshots: all form values (inputs, text areas, options, buttons, checkboxes), text inside text areas and `contenteditable` elements, hidden fields, CSRF meta tags and secret-looking attributes; query strings in URL attributes, `data-*` values and CSS (`url()`, `@import`).
- Console: `log`, `info` and `debug` text and all arguments (only type and location stay).
- Any string: JWTs, `Bearer` values and long letter-and-digit runs (24 characters or more) are replaced with `[token]`.
- Anything the cleaner does not recognize.

Limits: visible page text, URL origins and paths, and the page title are kept as recorded and can contain personal data; the trace is still private run output: never commit or share it. Playwright's raw trace files live in a private directory under `.hound/tmp/traces/` while the browser runs and are removed when the run ends.

## Component capture

```sh
pnpm hound run component https://example.com --selector "h1" --viewports 375,768,1280 --states hover,focus
```

For each viewport the run writes, under `.hound/runs/component/<timestamp>/<width>/`:

- `page.png`: full-page screenshot.
- `element.png`: screenshot of the element.
- `element.html`: the element's HTML.
- `styles.json`: a tree of computed styles that differ from the browser defaults, plus custom properties.
- `assets.json`: the assets the element uses, without query strings.
- With `--states`: `element.<state>.png` and `styles.<state>.json`, listing what changed on hover or focus.

The file list is in `result.json` under `data.files`. Use the screenshots and HTML as the reference, and `styles.json` to rebuild the markup and CSS.

## Agents and MCP

[AGENTS.md](AGENTS.md) explains how an AI agent should use sitehound: when to write an `exec` script, when to use the interactive `mcp` server, how to read results, and the rules that apply to logged-in data.

`pnpm hound mcp` runs the official Playwright MCP server over stdio, with a profile preloaded in memory. To register it with Claude Code:

```sh
claude mcp add sitehound -- pnpm --silent --dir /path/to/sitehound hound mcp --profile my-app
```

The MCP server exposes all of its tools, including `browser_evaluate`. Use it only on sites you are authorized to use.

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
  async run({ page, url, outDir, args, log, check }) {
    await page.goto(url);
    const title = await page.title();
    check("title is not empty", title.length > 0);
    log(`${title} (extra flags: ${JSON.stringify(args)})`);
    return { summary: "Title read", data: { title } };
  },
});
```

Run `pnpm install` once to link the new package, then:

```sh
pnpm hound run page-title https://example.com
```

The task receives a context with:

| Field     | Description                                                                              |
| --------- | ---------------------------------------------------------------------------------------- |
| `url`     | The URL passed on the command line.                                                      |
| `page`    | A Playwright `Page`, already in a context with the chosen profile.                       |
| `context` | The Playwright `BrowserContext`.                                                         |
| `outDir`  | Private, git-ignored run directory: `.hound/runs/<task>/<timestamp>`.                    |
| `args`    | Extra `--flags` from the command line.                                                   |
| `log`     | Prefixes messages with the task name and prints them. Do not log page content.           |
| `check`   | `check(name, ok, detail?)` records an assertion in `result.json` and returns `ok`. A failed check fails the run. |

The task may return `{ status?, summary?, data? }`. `summary` and `data` are written to `result.json`. A failed check always fails the run; a returned `status` can only downgrade a pass to `fail`. With `--profile`, a session that looks expired at the end also fails the run.

`@sitehound/capture` provides helpers that tasks compose:

- `capturePage(page, outDir)`: saves `page.html`, `screenshot.png` and `meta.json`. Used by `snapshot`.
- `captureText(page, outDir)`: saves `text.md` (visible text) and `aria.yml` (accessibility tree).
- `captureElement(page, selector, outDir, opts)`: saves the element and its styles, assets and hover/focus states. Used by `component`.

## Project structure

```text
.
├── .claude/                 Claude Code project instructions and settings
├── .githooks/pre-commit     Blocks commits that stage sessions or secrets
├── .github/workflows/ci.yml Typecheck
├── packages/
│   ├── core/                Sessions, profiles, runs, results, paths, task API
│   ├── capture/             Page, text and element capture helpers
│   └── cli/                 The `pnpm hound` command, including the MCP bridge
├── tasks/
│   ├── component/           Component capture (screenshot, HTML, styles, states)
│   └── snapshot/            Page snapshot (screenshot, HTML, text, aria tree)
├── AGENTS.md                Instructions for AI agents using sitehound
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
- Full network and HAR capture for data tests. Today `result.json` lists failed requests and HTTP errors only.
- Analysis (axe-core, Lighthouse)
- Page and site cloning (SingleFile, wget/Browsertrix)
- AI-assisted exploration (Stagehand). The `mcp` command gives agents interactive browser control today, but Stagehand is not used.
- Stealth mode (Patchright)
- Bun runtime, once Playwright support is stable

Already implemented: `component` capture (a component's markup, styles and states). Component cloning, meaning automatic code generation from a capture, is not implemented.

## Responsible use

Use sitehound only on sites you own or are authorized to test. Respect each site's terms of service, `robots.txt` and copyright.

## License

[MIT](LICENSE)
