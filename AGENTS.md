# AGENTS.md: using sitehound

sitehound drives a Chromium browser from a CLI. It can read public pages, read or act on logged-in sites (through a saved **profile**), run tests, and capture components. Every command prints one JSON object, so you never need to parse human text.

## When to use sitehound

- Read or browse a website step by step, including logged-in sites.
- Run an end-to-end test or an extraction script with a structured result.
- Capture a UI component (HTML, computed styles, assets, hover and focus states) for study or rebuilding.
- Check whether a saved login is still valid.

Do not use it for plain HTTP requests, API calls, or sites you are not authorized to automate. The detailed how-to is in `.claude/skills/sitehound/SKILL.md`.

## Running commands

Run the CLI from the repo as `bin/hound` (or `/home/gary/dev/sitehound/bin/hound` from anywhere). The wrapper pins Node from `.nvmrc` through fnm, works from any directory, and keeps runtime data in the repo's `.hound/`. `pnpm hound` also works. The old commands (`login`, `run`, `exec`, `check`, `tasks`, `profiles`, `forget`) are deprecated aliases; use the domain commands below.

If fnm is missing, `bin/hound` runs the current Node and prints a warning on stderr. Report that in your summary.

Install dependencies once with `corepack pnpm install`. If pnpm fails with an engine error, you are on the wrong Node.

## Default agent flags

- Always pass `--json` (it is also the default when stdout is not a TTY).
- Always pass `--no-input`. The CLI never prompts when this is set.
- Read `--schema` for a command's inputs, enums and examples. Do not read long `--help` output.
- Use `--output <file>` (on `page snapshot`, `page screenshot` and `page pdf`) or read `data.file` for large results. `--output` (also on `element download` and `diag request`) fails with `CONFLICT` if the file exists (add `--if-exists overwrite`) and refuses directories and symlinks; the daemon writes through a private temp file and never follows a link. Do not `cat` big files; use `head -c 20000`.
- A value that starts with `-` must be passed as `--flag=value` (for example `--value=-5`).
- Prefer `--actions read` (the default for `browser open`). Use `--actions interact` only when the user asked you to submit or change something.
- Use `--timeout <seconds>` for slow pages. A `TIMEOUT` on a state-changing action (navigate, click, fill, select, press, back, forward, reload, tabs new/close) returns `retryable: false`: it may still have been applied. Run `page snapshot` before retrying.

## Output envelope

stdout holds exactly one JSON object.

Success:

```json
{ "ok": true, "command": "page.navigate", "summary": "...", "data": {}, "next_actions": [{ "command": "...", "reason": "..." }] }
```

`next_actions` has at most 3 complete, runnable commands.

Error:

```json
{ "ok": false, "command": "element.click", "error": { "code": "REF_NOT_FOUND", "message": "...", "field": "ref", "received": "e999", "allowed": [] }, "retryable": true, "suggested_fix": { "command": "..." } }
```

`field`, `received` and `allowed` appear only when they apply. `data` may hold partial results.

Exit codes: `0` success, `2` usage error (`UNKNOWN_COMMAND`, `INVALID_ARGUMENT`, `MISSING_REQUIRED_FLAG`, `INVALID_ENUM`, `CONFIRMATION_REQUIRED`), `1` any other error (including `RUN_FAILED`, `RUN_ERROR` and `PARTIAL_SUCCESS` from `batch`).

`profile check` exits `0` when it succeeds. Read `data.state` (`valid`, `expired`, `unknown`).

## Common commands

Examples include `--json`; keep it on every call. Session names use letters, digits, `-`, `_` and `.`.

1. Browse loop, interactive: `hound browser open --session-name shop --json`, then `hound page navigate --session-name shop --url https://example.com --json`.
2. Read the page with element refs: `hound page snapshot --session-name shop --json`. Refs look like `e12` or `f3e4` (from the latest snapshot). Use `--limit-chars` to shorten inline output; the full text goes to `data.file`.
3. Click by ref: `hound element click --session-name shop --ref e12 --json`. After any click or navigation, take a new snapshot before using refs again.
4. Fill a form (only with interact): `hound browser open --session-name shop --actions interact --json`, then `hound element fill --session-name shop --ref e7 --value-file -` (read the value from stdin for secrets).
5. Close when done: `hound browser close --session-name shop --json`. Idle sessions also close themselves after 30 minutes.
6. Test with a script: `hound script run --file .hound/scripts/home-h1.ts --url https://example.com --profile work --json`. The script default-exports `async (ctx) => ({ summary?, data? })` and uses `ctx.page`, `ctx.url`, `ctx.check(name, ok, detail?)`, `ctx.log(msg)`, `ctx.args`. A failed check fails the run. Read `data.status`, `data.checks[]`, `data.files`, `data.runDir`.
7. Capture a component: `hound task run --task component --url https://example.com --arg selector=<css> --arg viewports=375,1280 --arg states=hover,focus --json`. Read `data.files` for the files per viewport. Only `--arg key=value` works; `--selector=` is not a flag.
8. Full-page snapshot task: `hound task run --task snapshot --url https://example.com --json`.
9. Check a saved login: `hound profile check --profile work --json` (add `--site <origin>` to check one site). Read `data.state`.
10. List what exists: `hound profile list --json`, `hound browser list --json`, `hound task list --json`.
11. Several steps in one call: `hound batch --session-name shop --file steps.json --json` (or `--file -` from stdin). Steps are a JSON array of `{"command": "element click", "args": {"ref": "e12"}}` (page, element and diag commands and `browser status`; flag names without `--`; no `session-name`; `timeout` per step allowed). Every step is validated with its command's rules before any runs (exit 2, `field: steps[i].args.<flag>`). Reuse earlier data with `"$prev.<path>"` or `"$steps[i].<path>"` (e.g. `"$prev.matches.0.ref"` after `page find`). A string arg that merely starts with `$$prev`/`$$steps` is a literal `$prev`/`$steps`; no other `$` is touched. It stops at the first failure unless `--continue-on-error` (exit 1, or 2 when no step succeeded and the first failure was a usage-code error); read `data.steps[]` (`ok`, `summary`, `data`, `error`), `completed`, `failed`, `skipped`.
12. Turn an exploration into a test: `hound script export --session-name shop --json` (before `browser close`), then run the `next_actions[0]` command with your own `--arg` values. Typed values, prompt answers and upload paths were never recorded: they are the parameters in `data.params`. Lines with `TODO verify locator` (ambiguous elements, `data.ambiguous`) need a look before you rely on the test. `--include-query` keeps URL queries (they may hold tokens); path tokens stay masked. `page wait --for text` values are page text copied into the script as written.

Other useful verbs: `page snapshot --ref <ref>` (only that element's subtree; its refs work for element commands) and `page snapshot --diff` (unified diff against the previous snapshot of the same tab with the same `--ref`/`--depth`: `data {diff, added, removed, baseline}`; the first call, `baseline: false`, returns the full snapshot in `data.snapshot`; every snapshot becomes the new baseline; `--limit-chars`, `--output` and `data.file` then hold the diff) are token savers for big pages, next to `page find --text <s>|--regex </re/i>` (matching snapshot lines with refs; `--limit 1..200`, `--context 0..3`; the cheap alternative to a full `page snapshot`), `page resize --viewport 375x812` and `browser open --viewport WxH [--device-scale-factor 1..4] [--mobile]`, `browser open --block analytics,ads,images,media,fonts` (refuses those request categories for the session; `diag network --state all` lists them as failure `blocked` with `blocked: <category>`, never as failures; well-known tracker/ad hosts only, pages needing a blocked resource may look broken; it disables the HTTP cache), `browser open --locale es-AR --timezone Europe/Madrid --geolocation=-34.6037,-58.3816[,accuracy]` (BCP 47 tag, IANA zone, `LAT,LON[,ACCURACY]`; geolocation also grants the geolocation permission; all three shown by `browser open|status`), `element check|uncheck --ref <r>` (checkbox, radio or switch, input or ARIA role; idempotent: `data {ref, checked, changed}`, nothing is clicked when already in that state; a radio cannot be unchecked; interact; takes `--dialog`/`--dialog-text`), `page pdf [--format A4|Letter|Legal] [--landscape] [--background] [--output <file>] [--if-exists overwrite]` (headless sessions only, else `CONFLICT`; `data {file, bytes, pages}`, 0600 under the session runs dir), `page emulate --color-scheme|--media|--reduced-motion|--reset`, `element read --ref <r> [--attr <name>]` (text or one attribute, redacted: tokens, Luhn card numbers and 4-8 digit codes next to a code/PIN/OTP label are masked, other numbers are not; password, hidden, card, OTP, CSRF-like fields give `ACTION_BLOCKED`; `page find` masks the same shapes), `element drag --ref <r> --to-ref <r> [--method auto|html5|mouse] [--steps 1..50]` (interact; `auto` tries HTML5 drag-and-drop, waits up to 1 s for any sign it worked (dragstart, DOM/URL/request change, the element moving), then repeats with a real pointer path of `--steps` moves; `data.method` says which ran; takes `--dialog`/`--dialog-text`), `page wait --for text|text-gone|url|ref|ref-hidden|request|load --value <v>` (`--within <ref>` scopes text; `text-gone`/`ref-hidden` return `wasPresent`, false when the target was never visible; `--for request` matches a finished request after the last click, `--method`, `--since-index`, value = substring or `/regex/imsu` of at most 200 characters; result has `index` for `diag request`), `page scroll`, `page tabs`, `page screenshot`, `element hover|select|press`, `element click` (`--count 1..3`, `--button`, `--modifiers`: interact), `element type` (real key events, for search-as-you-type fields; interact), `element upload --ref <r> --file <path>...` (interact; only files the user named, never secrets: `.hound/`, `.env*`, HAR/trace, SSH/cloud/docker/kube keys and config, browser profiles, shell histories and credential files are refused with `ACTION_BLOCKED`; hard-linked files are refused, copy them first; 20 files, 50 MiB), `element download` (click and save the file; `data.file`), `diag dialogs`, `diag console`, `diag network` (failed requests by default; each has an `index`), `diag request --index <n> --part request-body|response-body` (redacted body, never headers; the last 500 requests are kept). Run `hound <domain> <verb> --schema` for flags.

## Error handling

- Follow `suggested_fix.command` when present. Replace the quoted placeholders (for example `--ref "<ref>"`) yourself. For `INVALID_ENUM` the fix is the nearest allowed value; when nothing is close there is no fix, read `error.allowed`.
- Ranges and patterns are checked before anything runs (`--schema` lists them, exit 2): `--limit-chars` 1..200000, `--depth` 0..1000, `--limit` 1..500, `--idle-timeout` 1..1440, names `^[a-z0-9][a-z0-9._-]{0,63}$` (case-insensitive).
- `CONFIRMATION_REQUIRED` (exit 2): `profile delete` needs `--dry-run` or `--yes`; `profile login` on an existing profile needs an explicit `--mode extend|replace`. Pick one of `data.alternatives`.
- `TIMEOUT` on a state-changing action: the action may have been applied. `page snapshot` first, then decide. A click, key press or download that timed out because its request never got an answer has its pending navigation cancelled, so the next op is not stuck behind it.
- `REF_NOT_FOUND`: the page changed. Run `page snapshot` again and use the new refs.
- `ACTION_BLOCKED`: the session is read-only. Do not reopen it with `--actions interact` on your own. Ask the user first, then close and reopen it. For `element upload` (`field: file`) it means the file is protected: do not look for a way around it.
- `NO_TTY` from `profile login` (not retryable; the message holds the command for the human), or a profile that checks `expired`: stop and ask the human to log in. Agents cannot log in. Do not try to re-authenticate.
- `SESSION_NOT_FOUND`: run `browser list` and open the session again.
- `PROFILE_NOT_FOUND`: run `profile list`; do not guess names.
- `RUN_FAILED`: a check failed. Read `data.checks[]` and the failure files in `data.runDir`.
- `RUN_ERROR`: the run threw. Read `data.summary` and `result.json` in `data.runDir`.
- `PARTIAL_SUCCESS` (`batch`): some steps ran, one failed. Read `data.steps[]`: the steps that ran changed the page, so take a `page snapshot` and continue from the failed step instead of rerunning the whole batch.
- `retryable: false`: fix the input before retrying.
- Report the error code and the next step to the user. Do not paste page content into the report.

## Dialogs

JavaScript dialogs (alert, confirm, prompt, beforeunload) never hang a session. They are dismissed by default (`browser open --dialog dismiss`); each action that handled one reports `data.dialogs: [{type, message, action}]`, and `diag dialogs` lists the last 100. Accept only when the user asked for the action behind the dialog (for example "delete this record"): `--dialog accept` (and `--dialog-text` for a prompt, never echoed) on `element click|press|select|type|download|upload|drag` and `page navigate|back|forward|reload`, or `browser open --dialog accept`. Accepting needs `--actions interact`. `page navigate|back|forward|reload` always accept a `beforeunload` dialog (leaving is what you asked for) and report it in `data.dialogs`. An override also covers a dialog raised by a timer or request within 2 s after the action returned; it shows in `diag dialogs` (with `op`) and in the `data.dialogs` of any op running then (such as `page wait`).

## Read level and what it blocks

Browser sessions default to `--actions read`. It allows navigation, reading, screenshots, scrolling, hovering, waits, tabs, diagnostics, and clicks on real http(s) links (not `#fragment` links) and `<summary>`, with a plain single left click. It blocks fills, selects, key presses, check/uncheck, uploads, drags, accepting dialogs, `--count`/`--button`/`--modifiers` clicks, and clicks on buttons, submit controls or anything inside a form (`ACTION_BLOCKED`). It also refuses links that look like GET side effects (`ACTION_BLOCKED`, "side-effect link", needs `--actions interact`): a path segment, query key (or the value of `action=`/`op=`/`do=`...) or short link text that is, as a whole word, logout, sign out, log off, cerrar (la) sesión, delete, remove, destroy, eliminar, quitar, borrar, unsubscribe, unfollow, unregister, darse de baja, cancel subscription, revoke, deactivate, desactivar, desconectar, salir or close account. Also blocked: a link with `data-method` / `data-turbo-method` / `data-http-method` other than get (Rails, Laravel) and a query `_method=delete|put|patch|post`. Destructive verbs (and salir) only count in short segments (up to 3 words) and labels (up to 5), and "remove filter" style labels are exempt, so `/deleted-items`, `/planes-para-salir-de-noche` and `/blog/how-to-remove-stains` pass, while a docs page like `/delete-account-help` is blocked. The same rule applies to `element download`.

## Privacy and hard rules

- NEVER read, print, copy or summarize `.hound/profiles/`, `.env` files, HAR files or Playwright traces. This includes `cat`, `grep` and pasting them into output.
- NEVER echo page content, cookies or headers to the console. Put results in the JSON envelope or in run files, not in logs.
- Write outputs only through the CLI (under `.hound/`). Never commit `.hound/`.
- Respect each site's terms of service, `robots.txt` and copyright.
- Automate only sites the user owns or is authorized to use.
- Privacy: run outputs of logged-in pages (tax, banking, health or other sensitive data) are sent to the AI model provider when you read them. Confirm with the user before reading such outputs.

## Known limitations

- `sessionStorage` is not saved in profiles. localStorage and IndexedDB are.
- The read-level rules are heuristics. A link can have side effects in JavaScript, or be a GET link whose URL and text give nothing away (a redirect, `/go?to=...`), and a read session may still click it.
- Shadow DOM content may not appear in snapshots or be reachable by ref. Check with a screenshot or a script.
- The expiry check is a heuristic (password fields, login-looking URLs, origin changes). It can be wrong.
- No bot-detection evasion. Some sites will block or challenge automated browsers.
- Chromium only.
- No full HAR capture. `diag network` and `failedRequests` list failures and HTTP >= 400 responses only. Clean traces list requests without headers, cookies, bodies or query strings.
- A clean trace keeps visible page text, the page title and URL origins and paths as recorded (no screenshots, no form values, no query strings, no non-error console text). Treat it as private run output.

## Deprecated

`mcp` (the Playwright MCP server, `bin/hound mcp`) still works but is deprecated. Use the CLI commands above instead.
