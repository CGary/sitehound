# AGENTS.md — using sitehound

sitehound is a Playwright/TypeScript harness in this repo. It opens a browser, optionally loads a saved login (a **profile**), runs your code against the page, and writes a private, structured result. You are handed this repo path and a goal; this file tells you how to reach it.

## Use cases

1. **E2E tests** requested in natural language: turn the request into a script, run it, report pass/fail with evidence.
2. **Studying or imitating components and pages**: capture a component's HTML, computed styles, assets and states per viewport, then rebuild it.
3. **Reading information from sites**, including logged-in ones: capture clean text or return extracted data.

## Running commands

Run every project command with the Node version pinned in `.nvmrc` (22.22.2). Agent shells are often non-interactive and may not load the fnm shell hook, so they can silently run another Node. Either prefix each command:

```sh
fnm exec --using=.nvmrc -- pnpm typecheck
fnm exec --using=.nvmrc -- pnpm hound tasks
fnm exec --using=.nvmrc -- pnpm hound exec .hound/scripts/home-h1.ts https://example.com
```

or run `fnm use` once in the same shell, then use plain `pnpm`. If fnm is not installed, use any Node that matches `.nvmrc` and say so in your report.

Install dependencies with `fnm exec --using=.nvmrc -- corepack pnpm install`. If pnpm fails with an engine error (`engineStrict` is on), you are on the wrong Node. Switch to the pinned version. It is not a dependency problem.

Every `pnpm ...` example in this file assumes the fnm-pinned Node.

## Choosing a mode

- Repeatable test or report with a structured result: **`exec` script** (`pnpm hound exec`).
- Exploring a page step by step, clicking around, deciding the next step from what you see: **`mcp`** (interactive Playwright MCP server).
- Read a page as text or capture a component with no custom logic: **built-in tasks** (`snapshot`, `component`), via `pnpm hound run`.
- Need a logged-in session: check it first (see Profiles). Every mode above accepts `--profile`.

## Workflow: E2E test

1. Write `.hound/scripts/<name>.ts`. No imports are needed. Default-export an async function `(ctx) => { summary?, data? } | void`. Use `ctx.page`, `ctx.url`, `ctx.log(msg)`, and `ctx.check(name, ok, detail?)`, which records an assertion. Any failed check fails the run.
2. Run it: `pnpm hound exec .hound/scripts/<name>.ts <url> [--profile <name>] [--headed]`. Exit code: `0` pass, `1` fail or error.
3. Read `result.json` in the printed run directory (`.hound/runs/exec-<name>/<timestamp>/`):
   - `status`: `pass`, `fail`, or `error` (the script threw, or the browser could not start).
   - `summary`: one-line result. `checks[]`: each `{name, ok, detail?}`.
   - `data`: whatever the script returned.
   - `error`: the message if status is `error`.
   - `consoleErrors[]`, `pageErrors[]`: browser console errors and uncaught page exceptions.
   - `failedRequests[]`: requests that failed, or responses with HTTP >= 400 (URLs have query strings removed).
   - `session`: present only with `--profile`; `state` is `valid`, `expired` or `unknown`, with a `reason`. An `expired` session turns a passing run into `fail`.
   - `files`: every file in the run directory.
4. If status is not `pass`, read `failure.png` (screenshot taken at the end of the run) and `text.md` only if the script wrote it. Report the failing check names and details.

Minimal complete example, `.hound/scripts/home-h1.ts`:

```ts
export default async function ({ page, url, check }) {
  const response = await page.goto(url, { waitUntil: "load" });
  check("HTTP 2xx", response?.ok() === true, `status ${response?.status()}`);
  const h1 = page.getByRole("heading", { level: 1 });
  check("h1 is visible", await h1.isVisible());
  return { summary: "Home page shows a visible h1" };
}
```

Run: `pnpm hound exec .hound/scripts/home-h1.ts https://example.com`

A failed check always fails the run. A returned `status` can only turn a pass into `"fail"`, never hide a failed check. String values in `data` have query strings and fragments stripped from URLs.

## Debugging with a clean trace

Add `--trace` to `run` or `exec` (or `--trace on-failure` to keep it only when the run is not a `pass`). The run directory then gets two extra files and `result.json` gets a `trace` field:

- `steps.json`: read this first. `actions[]` in order, each `{ id, title, api, selector?, params, startTime, durationMs, error? }` (times in ms from the start of the run), plus `consoleErrors[]` (error and warning text only, 300 characters at most) and `pageErrors[]`. Every typed or selected value shows as `[redacted]`, and `evaluate` expressions and init scripts are removed.
- `debug-trace.zip`: the cleaned Playwright trace (DOM snapshots with form values blanked, no screenshots; `failure.png` is separate). A human can open it with `pnpm exec playwright show-trace <path>`. Do not unzip it to read entries; use `steps.json`.
- `result.json` → `trace`: `{ file, steps, actions, redactions: { headers, cookies, bodies, inputValues, urls } }`, or `{ error }` if the trace could not be cleaned (then no trace files exist).

The raw trace is never kept. Never record or read a raw trace yourself with `context.tracing` in a script; use `--trace`.

## Workflow: reading information

- Cheap, full view of one page: `pnpm hound run snapshot <url> [--profile <name>]`. Read `text.md` (title, URL without query, visible body text) and `aria.yml` (accessibility tree). Do not read `page.html` unless you need markup; it is large. Other files: `screenshot.png`, `meta.json`, and `result.json`.
- Extracting specific fields: write an `exec` script that returns them in `data`, then read `result.json` → `data`. This is the preferred route for structured output.

## Workflow: components

Run:

```sh
pnpm hound run component <url> --selector "<css>" --viewports 375,768,1280 --states hover,focus [--profile <name>]
```

Flags use `=` or a space. `--viewports` defaults to `1280`; `--states` accepts `hover` and `focus` (optional). The selector must match a visible element, or the run errors.

Output in `.hound/runs/component/<timestamp>/`:

- `result.json` → `data.files` lists the files per viewport.
- `<width>/page.png`: full-page screenshot at that width.
- `<width>/element.png`: screenshot of the element. Use it as the visual reference.
- `<width>/element.html`: the element's `outerHTML`. Structure and text.
- `<width>/styles.json`: a tree of nodes (`id`, `parent`, `selector`, computed styles that differ from the browser default, `box`, `pseudo`), plus `customProperties` (CSS variables). Capped at 300 nodes; `truncated` tells you if it was cut.
- `<width>/assets.json`: URLs the element uses (images, fonts, backgrounds), without query strings. `data:` URLs are summarized.
- `<width>/element.hover.png`, `<width>/styles.hover.json` (and `focus`): the state screenshot, plus the style changes against the base state. Focus files include `focusTarget`.

To rebuild: write the markup from `element.html`, map the `styles.json` values to CSS (keep the node tree, and use the custom properties), reference the assets, then compare your rebuild against `element.png` at each width. Use the `hover`/`focus` diffs for the states. `styles.json` gives computed values, not the original source CSS, so expect to simplify. Do not download or reuse assets from sites you are not authorized to copy.

## Profiles and sessions

- Agents cannot log in. A human runs `pnpm hound login <url> --profile <name>`, signs in by hand in the window that opens, and presses Enter. Ask for this when needed.
- Before any logged-in job, run `pnpm hound check <profile>`. It navigates to the saved landing page, then prints `valid: …`, `expired: …` or `unknown: …` and cookie counts. Exit codes: `0` valid, `2` expired, `3` unknown. Exit `1` means the profile or its metadata is missing, or an error occurred.
- If the check exits `2` (expired), stop and ask the human to log in again. Do not try to re-authenticate.
- If the check exits `3` (unknown), you may continue, but report that the session could not be confirmed.
- Every `run`/`exec` with `--profile` records `session` in `result.json`. That state is judged from the page at the end of the run, so a script that navigates away can make it `unknown`.
- `pnpm hound mcp --profile <name>` preloads the profile in memory. The profile file is not modified.

## Interactive exploration: `mcp`

Register once (the `--silent` flag keeps stdout clean for the protocol):

```sh
claude mcp add sitehound -- pnpm --silent --dir /path/to/sitehound hound mcp --profile <name>
```

Omit `--profile` for anonymous browsing. `--headed` shows a window. Screenshots and other artifacts go to `.hound/runs/mcp/<timestamp>/`. Flags after a standalone `--` go to `@playwright/mcp`.

The server exposes all of its tools, including `browser_evaluate`, `browser_network_requests` and `browser_file_upload`. There is no flag to disable them in this version. Apply the rules below to them as you would to any script: do not dump cookies, storage or headers, and do not upload local files that are not needed for the task.

## Rules for agents (hard)

- NEVER read, print, copy or summarize `.hound/profiles/`, `.env` files, HAR files or Playwright traces. This includes `cat`, `grep` and pasting them into output.
- NEVER echo page content, cookies or headers to the console. Put results in `result.json` (`summary`, `data`), not in logs.
- Write outputs only under `.hound/` (use `pnpm hound` commands and the `ctx.outDir` directory). Never commit `.hound/`.
- Respect each site's terms of service, `robots.txt` and copyright.
- Automate only sites the user owns or is authorized to use.
- Privacy: reading run outputs of logged-in pages (tax, banking, health, or other sensitive data) sends that content to the AI model provider. Confirm with the user before reading such outputs.

## Known limitations

- `sessionStorage` is not saved in profiles. localStorage and IndexedDB are.
- The expiry check is a heuristic (password fields, login-looking URLs, origin changes). It can be wrong.
- No bot-detection evasion. Some sites will block or challenge automated browsers.
- Chromium only.
- No full HAR capture. `failedRequests` in `result.json` lists failures and HTTP >= 400 responses only. The clean trace lists requests without headers, cookies, bodies or query strings.
- A clean trace keeps visible page text, the page title and URL origins and paths as recorded (no screenshots, no form values, no query strings, no non-error console text); treat it as private run output.
