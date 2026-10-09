**English** · [Español](README.es.md)

# sitehound

Task-agnostic browser harness to explore, test (visual and data), analyze and clone websites. Built with TypeScript and Playwright.

It works on public sites and on sites behind a login: you sign in by hand once, the session is saved as a named **profile**, and later runs reuse it. One profile can hold several sites.

> **Status:** early (v0.1.0). The core, the domain CLI (`bin/hound`), browser sessions, the built-in tasks `snapshot` and `component`, and single-file scripts exist today. See [Roadmap](#roadmap).

## Features

- **Browser sessions.** Open a persistent browser, navigate, read the page as an accessibility tree with element refs, click, fill and diagnose it from one command at a time.
- **Reusable profiles.** Log in by hand once; cookies, localStorage and IndexedDB are saved and loaded with `--profile`. `profile login --mode extend` adds a site without redoing the others.
- **Agnostic core.** The harness opens a browser, loads a profile and hands a page to a task or script. Each use case lives in its own task package, or in a single-file script.
- **Structured results.** Every command prints one JSON envelope. Tasks and scripts write a `result.json` with checks, errors, failed requests and session state.
- **Agent-ready.** One JSON contract, stable error codes and exit codes. See [AGENTS.md](AGENTS.md).
- **Private by default.** All runtime data goes to a git-ignored `.hound/` directory with restrictive permissions.

## Requirements

- Node.js 22.22.2, pinned in `.nvmrc` (the only place the Node version is set).
- [fnm](https://github.com/Schniz/fnm) to switch to that version. `bin/hound` runs Node through fnm, so you do not need to change your shell.
- pnpm 12, via corepack.

If fnm is not installed, `bin/hound` runs the Node on your `PATH` and prints a warning when it differs from `.nvmrc`.

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
corepack enable
corepack pnpm install
corepack pnpm browsers        # installs Chromium for Playwright
bin/hound task run --task snapshot --url https://example.com
```

`bin/hound` works from any directory. `pnpm hound ...` also works from the repo root. To let AI agents in other projects use it, see [the `sitehound` skill](#the-sitehound-skill).

The `snapshot` task writes a full-page screenshot, the rendered HTML, visible text, an accessibility tree and basic metadata to a private run directory under `.hound/runs/snapshot/<timestamp>/`, plus a `result.json`.

## Usage

The CLI is `bin/hound <domain> <verb> [flags]`. Every command prints one JSON object on stdout when `--json` is set or stdout is not a terminal. Add `--schema` to any command to see its inputs.

| Domain    | Verbs                                                                 | Purpose                                              |
| --------- | --------------------------------------------------------------------- | ---------------------------------------------------- |
| `browser` | `open`, `close`, `list`, `status`                                     | Persistent browser sessions                          |
| `page`    | `navigate`, `snapshot`, `find`, `screenshot`, `pdf`, `wait`, `back`, `forward`, `reload`, `scroll`, `tabs`, `resize`, `emulate` | Move around, read and resize the current page |
| `element` | `click`, `check`, `uncheck`, `drag`, `read`, `hover`, `fill`, `type`, `select`, `press`, `upload`, `download` | Act on or read an element by its ref |
| `diag`    | `console`, `dialogs`, `network`, `request`, `trace`                   | Errors, handled dialogs, requests, redacted request bodies and the clean trace of a session |
| `profile` | `list`, `check`, `login`, `delete`                                    | Saved logins                                         |
| `task`    | `list`, `run`                                                         | Built-in capture tasks (`snapshot`, `component`)     |
| `script`  | `run`, `export`                                                       | Single-file test or extraction script; export a session's actions as one |
| `batch`   | (none: `bin/hound batch ...`)                                         | Several page/element/diag steps of one session in one call |

Universal flags: `--json`, `--plain`, `--quiet`, `--debug`, `--no-input`, `--timeout <seconds>`, `--schema`, `--help`, `--version`.

```sh
bin/hound --help                              # domains
bin/hound page --help                         # verbs of one domain
bin/hound element click --schema              # inputs of one command
```

Flags accept `--key value` or `--key=value`. Use `--arg key=value` to pass arguments to a task or script.

### Legacy and deprecated commands

These still work and print a one-line deprecation notice on stderr. They will be removed in a later version.

| Old command                         | New command                                           |
| ----------------------------------- | ----------------------------------------------------- |
| `pnpm hound login <url> --profile n`| `bin/hound profile login --profile n --url <url>`     |
| `pnpm hound run <task> <url>`       | `bin/hound task run --task <task> --url <url>`        |
| `pnpm hound exec <file> <url>`      | `bin/hound script run --file <file> --url <url>`      |
| `pnpm hound check <profile>`        | `bin/hound profile check --profile <profile>`         |
| `pnpm hound tasks`                  | `bin/hound task list`                                 |
| `pnpm hound profiles`               | `bin/hound profile list`                              |
| `pnpm hound forget <profile>`       | `bin/hound profile delete --profile <profile> --dry-run` (add `--yes` to delete) |

`mcp` (the Playwright MCP server) is deprecated in favor of the CLI. See [Agents and MCP](#agents-and-mcp).

## Browser sessions

A session is one browser that stays open between commands, so you can navigate, read and act step by step.

```sh
bin/hound browser open --session-name shop --json                     # read level (default)
bin/hound page navigate --session-name shop --url https://example.com --json
bin/hound page snapshot --session-name shop --json                    # accessibility tree with refs such as e12
bin/hound element click --session-name shop --ref e12 --json
bin/hound browser close --session-name shop --json
```

- `--profile <name>` opens the session with a saved login.
- `--actions read` (the default) allows navigation, reading, screenshots, scrolling, waits, tabs, diagnostics, and clicks on real http(s) links and `<summary>` (links that look like GET side effects, such as `/logout`, `/account/delete`, a "Sign out" label, `data-method="delete"` or `?_method=delete`, are refused with `ACTION_BLOCKED`; this is a heuristic). `--actions interact` also allows filling fields, selecting options, pressing keys and clicking buttons. Open with `interact` only when you need to submit or change something.
- `--display headed` shows the window; `headless` is the default.
- `--dialog dismiss` (the default) cancels JavaScript dialogs (alert, confirm, prompt, beforeunload) in every tab so none hangs a page; `--dialog accept` confirms them (for example "Delete this record?") and needs `--actions interact`. Override it per action with `--dialog` / `--dialog-text` on `element click|press|select|type|download|upload|drag` and `page navigate|back|forward|reload`; the override also covers a dialog raised by a timer or request up to 2 seconds after the action returned. `page navigate|back|forward|reload` always accept a `beforeunload` dialog, since leaving is what you asked for. Handled dialogs appear in the action's `data.dialogs`, and `diag dialogs` lists the last 100.
- `element upload --ref <ref> --file <path> [--file ...]` (interact) sets files on an `<input type=file>` or on the button that opens the file chooser. It refuses sitehound's `.hound/`, `.env*`, HAR and trace files, SSH/cloud/docker/kube credentials, browser profiles, shell histories, password vaults and key files (`ACTION_BLOCKED`) as well as hard-linked files (copy them first), and caps a call at 20 regular files and 50 MiB.
- `--viewport <W>x<H>` (200..7680 x 200..4320), `--device-scale-factor 1..4` and `--mobile` set the size, pixel ratio and touch/mobile emulation of every tab; `browser status` shows the viewport, and `page resize --viewport <W>x<H>` changes the active tab. `page emulate` sets `--color-scheme light|dark|no-preference`, `--media screen|print` and `--reduced-motion reduce|no-preference` (or `--reset`) for the active tab and for tabs opened later.
- `page find --text <substring>|--regex </pattern/flags>` returns only the matching lines of a fresh snapshot, with line numbers and refs (`--limit 1..200`, `--context 0..3`); it is the cheap alternative to reading a whole snapshot, and its refs work with `element` commands. Regexes are capped (200 characters, 2000 per line) and run with a time budget. `element read --ref <ref> [--attr <name>] [--limit-chars 1..20000]` returns an element's text or one attribute with tokens masked and URL queries removed; password, hidden, card, OTP and CSRF-like fields are refused (`ACTION_BLOCKED`); in the text, card numbers (Luhn plus a card-like shape) and 4-8 digit codes next to a code/PIN/OTP label are masked, and `page find` does the same, while other numbers stay. `/url:` lines of snapshots lose their query strings. `element drag --ref <source> --to-ref <target>` (interact) drags and drops: `--method auto` (default) tries HTML5 drag-and-drop and, if the page did not react, repeats with a real pointer path of `--steps 1..50` moves (default 10); `html5` and `mouse` force one of them.
- `page snapshot --ref <ref>` returns only that element's subtree (its refs are the same as in a full snapshot, so they work with `element` commands), and `page snapshot --diff` returns only the lines added (`+`) or removed (`-`) since the previous snapshot of the same tab with the same `--ref` and `--depth`, as a compact unified diff with refs (`data.diff`, `added`, `removed`, `baseline`). The first call has no baseline and returns the full snapshot (`baseline: false`); every snapshot, diff or not, becomes the new baseline, and a line that only gained or lost the `[active]` focus marker is not a change. `--limit-chars`, `--output` and the saved file then hold the diff. Both cut tokens on big pages.
- `browser open --block analytics,ads,images,media,fonts` refuses those request categories for the whole session (well-known analytics and ad hosts by list, the others by resource type). Blocked requests show in `diag network --state all` with failure `blocked` and `blocked: <category>`, and are never counted as failures. Pages that need a blocked resource may look broken. Side effects: routing disables the browser's HTTP cache for the session, and service workers are blocked (their requests would bypass the routes), so offline/PWA features do not work. `browser open --locale <bcp47> --timezone <IANA> --geolocation <lat,lon[,accuracy]>` (pass a negative latitude as `--geolocation=-34.6,-58.4`) sets `navigator.language`, `Intl` and `Date` time zone, and a fixed `navigator.geolocation` position (the permission is granted); `browser open` and `browser status` show them.
- `element check|uncheck --ref <ref>` (interact) sets a checkbox, radio button or switch (native or ARIA) idempotently: `data {ref, checked, changed}`, nothing is clicked when it already is in that state, and a radio button cannot be unchecked. `page pdf [--format A4|Letter|Legal] [--landscape] [--background] [--output <file>]` prints the active tab to a PDF (0600; headless sessions only) and returns `{file, bytes, pages}`.
- `page wait --for text-gone|ref-hidden` waits for a spinner to go away, `--within <ref>` scopes a text wait to one element, and `--for request --value <substring or /regex/flags>` (with `--method`, `--since-index`) waits for a request that finished after the last click, fill or navigation (the value is a substring, or `/regex/imsu` of at most 200 characters). `text-gone` and `ref-hidden` return `wasPresent: false` when the target was never visible. `element click` also takes `--count 1..3`, `--button` and `--modifiers` (interact).
- A ref (like `e12` or `f3e4`) is valid only for the snapshot it came from. After a click or a navigation, take a new snapshot (`REF_NOT_FOUND` means the page changed).
- Sessions close themselves after 30 minutes of inactivity (`--idle-timeout`, 1 to 1440 minutes, changes it). A `TIMEOUT` on a state-changing action may still have been applied: take a snapshot before retrying. When a click, key press or download times out because its request never gets an answer, the pending navigation is cancelled so the next command is not stuck behind it.
- `--output <file>` (snapshot, screenshot) (also `element download`, `diag request`) fails with `CONFLICT` if the file exists unless `--if-exists overwrite`; directories and symlinks are refused, and the write goes through a private temp file in the destination folder, so a link that appears later is replaced, never followed. Values that start with `-` need `--flag=value`.
- Large snapshots are truncated inline; the full text is saved to a private file under `.hound/runs/browser/<session>/`.
- `bin/hound batch --session-name <s> --file <steps.json>|- [--continue-on-error] [--max-steps 1..200]` runs several steps in one call to save round trips. The file is a JSON array of `{"command": "element click", "args": {"ref": "e12"}}` (flag names without `--`; `session-name` is set by batch; `timeout` is the only universal flag allowed per step). Allowed: every `page`, `element` and `diag` command and `browser status`. Every step is validated up front with the same rules as the standalone command, so nothing runs when one is wrong (exit 2, `field: steps[i].args.<flag>`). A string arg can take a value from an earlier step's `data`: `"$prev.matches.0.ref"` or `"$steps[1].url"` (start a value with `$$prev` or `$$steps` for a literal `$prev` / `$steps`; any other `$`, such as a password `$$abc`, is passed as is, and values taken from earlier steps are never altered); one that cannot be resolved fails that step with `INVALID_ARGUMENT`. Steps stop at the first failure unless `--continue-on-error`. The envelope holds `data {steps: [{i, command, ok, summary, data?, error?}], completed, failed, skipped}`; any failure gives `ok: false` and exit 1 (`PARTIAL_SUCCESS` when a step succeeded); when no step succeeded, the exit code is that of the first failure's own error, so a usage-code error raised while the first step runs (for example `INVALID_ARGUMENT` from a reference that cannot be resolved) exits 2. A boolean for a flag that is not a switch is refused up front. Sensitive values (`value`, `dialog-text`) are never echoed; when the step data is too large for one envelope, later steps keep only file and URL fields and the full results go to `data.file` (0600).
- `bin/hound script export --session-name <s> [--output <file.ts>] [--if-exists overwrite] [--name <test>] [--include-query]` turns what was done in the session into a script for `script run` (see [Scripts](#scripts)). Export before closing the session: the action log lives in its memory.

## Authenticated sites

```sh
# 1. A browser window opens. Log in, then press Enter in the terminal. (A person must do this.)
bin/hound profile login --profile my-app --url https://app.example.com

# 2. Add another site to the same profile without redoing the first one. An existing profile needs an explicit --mode (extend keeps its sites, replace discards them).
bin/hound profile login --profile my-app --url https://admin.example.com --mode extend

# 3. Check every site of the profile, or one site with --site.
bin/hound profile check --profile my-app --json

# 4. Reuse the session in a session, a task or a script.
bin/hound browser open --session-name app --profile my-app --json
bin/hound task run --task snapshot --url https://app.example.com/dashboard --profile my-app --json
```

The profile is stored in `.hound/profiles/my-app.json` (mode `0600`). Profile and session names accept letters, digits, `.`, `_` and `-`.

`profile check` reports `valid`, `expired` or `unknown` in `data.state`, with a reason and cookie counts per site. Its exit code is `0` when the check runs. The check is a heuristic: it looks for login forms and login-like URLs.

`profile login` needs a terminal, so it cannot run from an agent. `profile delete` needs `--dry-run` (preview) or `--yes` (confirm).

## Scripts

A script is a single `.ts`, `.js` or `.mjs` file. Its default export receives a context with `page`, `url`, `outDir`, `args`, `log` and `check`:

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
bin/hound script run --file .hound/scripts/home-h1.ts --url https://example.com --json
```

Scripts are meant for tests and reports. Keep them in `.hound/scripts/`, which is git-ignored. A failed `check()` fails the run with `RUN_FAILED`.

### Export a session as a script

After exploring a flow in a browser session, `script export` writes it as a repeatable test:

```sh
bin/hound script export --session-name shop --json            # .hound/runs/browser/shop/export-<time>.ts (0600)
bin/hound script run --file <data.file> --url https://shop.example/cart --arg email=jane@example.com --arg password=... --json
```

- The session keeps its last 500 successful actions in memory: navigate, click, hover, fill, type, select, press, check/uncheck, drag, upload, download, back/forward/reload, tab select/new/close, waits, resize and emulate.
- Refs do not survive a page change, so before each action the session records a stable locator for the element: a test id, else role and accessible name, label, placeholder or exact text when that matches only this element, else `#id` or a short CSS path. When nothing is unique the script uses `.nth(i)` and a `// TODO verify locator` comment.
- Filled or typed values, prompt answers and upload paths are never recorded. They become required `--arg` parameters named after the field (`Email address` gives `email_address`), listed in the script header with the full `script run` command.
- URLs keep origin and path (token-like path segments are always masked, with a TODO); `--include-query` keeps queries and fragments. The value of `page wait --for url|request` gets the same treatment, but `--for text` values are page text copied into the script as written: check them for personal data before sharing it. Text typed into rich-text (contenteditable) editors and other fields is never used to name or find an element. Navigations on the start origin are written relative to `--url`, so the test can run against another host.
- Checks (`ctx.check`, in `result.json`): the URL path after each navigation and after clicks that changed it, each `page wait` condition, and the final path. `page wait --for request` is left as a TODO. Session settings such as `--locale` or `--block` are listed in the header, not replayed.

### Configuration

Copy `.env.example` to `.env` at the repo root (git-ignored). The CLI loads it if present, whatever the current directory; variables already set in the environment win.

| Variable         | Default  | Purpose                                                                 |
| ---------------- | -------- | ----------------------------------------------------------------------- |
| `HOUND_HOME`     | `.hound` | Root for runtime data (profiles, runs, sessions). Must stay git-ignored. |
| `HOUND_HEADLESS` | `true`   | Headless default when no display is given (set `false` for headed). `browser open` always uses its own `--display` flag (default `headless`). |

## Results (result.json)

Every task and script run writes `result.json` into its run directory. Its `status` is `pass`, `fail` or `error`. The CLI returns `ok: true` for `pass` and `ok: false` (`RUN_FAILED` or `RUN_ERROR`, exit code `1`) otherwise, with the same result in `data`.

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

Add `--trace on` to `browser open` (then export with `bin/hound diag trace --session-name <name> --action export`), or `--trace on|on-failure` to `task run` and `script run`. `on-failure` keeps the trace only when the run is not a `pass`. Raw traces contain cookies, auth headers, request bodies and form values, so sitehound never keeps one: it records into a private temporary directory, writes a redacted copy, and always deletes the raw file, even if cleaning fails.

```sh
bin/hound script run --file .hound/scripts/login-test.ts --url https://example.com --profile work --trace on-failure --json
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
bin/hound task run --task component --url https://example.com --arg selector=<css> --arg viewports=375,768,1280 --arg states=hover,focus --json
```

For each viewport the run writes, under `.hound/runs/component/<timestamp>/<width>/`:

- `page.png`: full-page screenshot.
- `element.png`: screenshot of the element.
- `element.html`: the element's HTML.
- `styles.json`: a tree of computed styles that differ from the browser defaults, plus custom properties.
- `assets.json`: the assets the element uses, without query strings.
- With `--arg states=...`: `element.<state>.png` and `styles.<state>.json`, listing what changed on hover or focus.

The file list is in the JSON result under `data.files`. Use the screenshots and HTML as the reference, and `styles.json` to rebuild the markup and CSS.

## Agents and MCP

[AGENTS.md](AGENTS.md) explains how an AI agent should use sitehound: the JSON envelope, error codes, the read level, and the rules that apply to logged-in data.

### The `sitehound` skill

`.claude/skills/sitehound/SKILL.md` is a short Claude Code skill that teaches an agent to drive the CLI. Inside this repo it loads automatically. To use it from any other project, put `hound` on your PATH and link the skill into your user skills:

```sh
ln -s /path/to/sitehound/bin/hound ~/.local/bin/hound
ln -s /path/to/sitehound/.claude/skills/sitehound ~/.claude/skills/sitehound
```

Then ask the agent to browse, test or read a site, or invoke `/sitehound` explicitly. The skill tells the agent to:

- always pass `--json --no-input` and read flags with `--schema`;
- open sessions at the read level and use `--actions interact` only when you asked it to change something;
- use `page find` to locate things without reading a whole snapshot, `element type` for search-as-you-type fields, `element read` for one element's text or attribute, `element download` for exported files, and `diag request` to inspect a redacted request or response body;
- use `browser open --viewport`, `page resize` and `page emulate` to check responsive layouts, dark mode and print styles;
- leave dialogs dismissed unless you asked for the action behind them, and upload only the files you named, never secrets;
- leave captures in sitehound's private `.hound/runs/`, or write `--output` only to a `mktemp -d` dir or a git-ignored folder, never to tracked or shared paths;
- stop and ask you when a login is needed or a profile has expired.

Runtime data always stays in sitehound's `.hound/`, whatever the agent's current directory.

Deprecated: `bin/hound mcp` runs the official Playwright MCP server over stdio, with a profile preloaded in memory. Prefer the CLI commands above. If you still need it, register it with Claude Code:

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

Run `corepack pnpm install` once to link the new package, then:

```sh
bin/hound task run --task page-title --url https://example.com --json
```

The task receives a context with:

| Field     | Description                                                                              |
| --------- | ---------------------------------------------------------------------------------------- |
| `url`     | The URL passed on the command line.                                                      |
| `page`    | A Playwright `Page`, already in a context with the chosen profile.                       |
| `context` | The Playwright `BrowserContext`.                                                         |
| `outDir`  | Private, git-ignored run directory: `.hound/runs/<task>/<timestamp>`.                    |
| `args`    | Extra `--arg key=value` pairs from the command line.                                     |
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
├── .claude/                 Claude Code project instructions, settings and the sitehound skill
├── .githooks/pre-commit     Blocks commits that stage sessions or secrets
├── .github/workflows/ci.yml Typecheck
├── bin/hound                The CLI entrypoint (pins Node through fnm)
├── packages/
│   ├── core/                Sessions, browser daemon (browserd/), profiles, runs, results, paths, errors, task API
│   ├── capture/             Page, text and element capture helpers
│   └── cli/                 The CLI: framework/ (parsing, envelope, help, schema) and commands/ (one file per domain, plus batch)
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
- No dependency is allowed to run install scripts.
- A pnpm minimum-release-age policy limits supply-chain exposure to freshly published packages.

See [SECURITY.md](SECURITY.md) for details and how to report a vulnerability.

## Roadmap

Planned, not implemented:

- Crawling (Crawlee)
- Visual diff (odiff)
- Full network and HAR capture for data tests. Today `diag network` and `result.json` list failed requests and HTTP errors only.
- Analysis (axe-core, Lighthouse)
- Page and site cloning (SingleFile, wget/Browsertrix)
- AI-assisted exploration (Stagehand). Agents drive browser sessions through the CLI today; Stagehand is not used.
- Stealth mode (Patchright)
- Bun runtime, once Playwright support is stable

Already implemented: browser sessions, `component` capture (a component's markup, styles and states). Component cloning, meaning automatic code generation from a capture, is not implemented.

## Responsible use

Use sitehound only on sites you own or are authorized to test. Respect each site's terms of service, `robots.txt` and copyright.

## License

[MIT](LICENSE)
