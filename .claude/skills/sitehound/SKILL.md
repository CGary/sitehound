---
name: sitehound
description: Use when you need to browse, read, test or capture a website, including logged-in sites, through the sitehound CLI (`hound`): open a browser session (optionally with a saved login profile), navigate, snapshot or search the page, click, type, fill, upload or drag by ref, handle confirm dialogs, download files, inspect redacted network requests, emulate mobile or dark mode, run an end-to-end test script, capture a component, or check a saved login profile. Do NOT use for plain HTTP requests or API calls, for sites the user has not authorized, or for logging in on the user's behalf (a human must log in).
---

# sitehound CLI

Run it as `hound` (on the PATH; fallback `/home/gary/dev/sitehound/bin/hound`). It pins Node through fnm and works from any directory, including other projects. Runtime data (sessions, runs, default snapshot and screenshot files) always stays in sitehound's private, git-ignored `.hound/`, whatever the current directory. Always pass `--json` and `--no-input`. Read `hound <domain> <verb> --schema` for flags; do not read long help.

## When to use / not to use

- Use: step-by-step browsing, reading pages with element refs, logged-in pages through a saved profile, end-to-end test scripts, component capture.
- Do not use: plain HTTP or API calls; sites the user is not authorized to automate; logging in (ask the human: `profile login` needs a TTY and only a person can do it).

## Required flags for agents

- `--json`, `--no-input` on every call.
- Browser and page commands need `--session-name <id>` (`^[a-z0-9][a-z0-9._-]{0,63}$`, case-insensitive).
- `browser open` defaults to `--actions read`. Add `--actions interact` only when the user asked you to submit or change something.
- `task run` and `script run` need `--url`; `script run` also needs `--file`.

## All verbs

- `browser`: open, close, list, status. `open` takes `--profile <name>` (saved login), `--actions read|interact`, `--viewport WxH`, `--mobile`, `--dialog`, `--display headed`, `--trace on`, `--block analytics,ads,images,media,fonts`, `--locale`, `--timezone`, `--geolocation=LAT,LON`.
- `page`: navigate, snapshot (`--ref`, `--diff`), find, screenshot (`--scope viewport|full|element`), pdf, wait, back, forward, reload, scroll, tabs, resize, emulate.
- `element`: click, hover, fill, type, select, press, check, uncheck, download, upload, drag, read.
- `diag`: console, network, request, dialogs, trace (export a redacted trace of a session opened with `--trace on`).
- `profile`: list, check, login (human only), delete. `task`: list, run. `script`: run, export.
- `batch` (no verb): `--session-name <s> --file <steps.json>|-`, JSON array of `{"command": "page find", "args": {...}}`; args are strings/numbers (booleans only for switches; `$$prev` = literal `$prev`); `"$prev.matches.0.ref"` / `"$steps[i].<path>"` reuse earlier step data; `--continue-on-error`.

Batch several steps to save round trips; export a session to a script to make an exploration a repeatable test.

## Common commands

```sh
hound browser open --session-name shop --json
hound browser open --session-name erp --profile work --actions interact --json   # logged-in session that may change data
hound element fill --session-name shop --ref e7 --value "jane" --json            # plain inputs; select/press/hover work the same way
hound page screenshot --session-name shop --scope full --json                    # data.file; Read the PNG to see it
hound page navigate --session-name shop --url https://example.com --json
hound page snapshot --session-name shop --limit-chars 4000 --json   # refs like e12 or f3e4
hound page find --session-name shop --text "add to cart" --json                  # cheap: matching lines + refs, not the whole snapshot
hound page snapshot --session-name erp --ref e40 --json     # only that subtree; refs stay valid   (also: --diff = only what changed since the last snapshot of the tab)
hound element click --session-name shop --ref e12 --json
hound element read --session-name shop --ref e12 --attr href --json             # text or one attribute (masked: tokens, card numbers, one-time codes; password/card/OTP-like fields blocked)
hound element drag --session-name shop --ref e12 --to-ref e30 --json             # interact; --method auto|html5|mouse, --steps 1..50 for pointer-move libraries
hound page resize --session-name shop --viewport 375x812 --json                  # or browser open --viewport 375x812 --mobile
hound page emulate --session-name shop --color-scheme dark --media print --json  # --reduced-motion, --reset
hound element check --session-name erp --ref e15 --json                         # also uncheck; idempotent, data.changed (checkbox/radio/switch; interact)
hound page pdf --session-name shop --format A4 --landscape --json               # data.file (headless only)
hound browser open --session-name es --block analytics,ads --locale es-AR --timezone America/Argentina/Buenos_Aires --json   # fewer requests; --geolocation=-34.6,-58.4
hound element type --session-name shop --ref e7 --value "mar" --clear --json    # real key events (interact)
hound element download --session-name shop --ref e30 --json                      # click + save the file; data.file
hound element upload --session-name shop --ref e9 --file ./invoice.pdf --json    # input[type=file] or its button (interact)
hound element click --session-name shop --ref e7 --dialog accept --json          # confirm a "Delete?" dialog (interact)
hound element click --session-name shop --ref e7 --count 2 --button right --modifiers Shift --json   # interact
hound page wait --session-name shop --for text-gone --value "Cargando" --within e41 --json   # also ref-hidden, request
hound page wait --session-name shop --for request --value /api/orders --method POST --json   # after a click; then diag request
hound diag dialogs --session-name shop --json                                    # dialogs the session handled
hound diag network --session-name shop --state all --json                        # each request has an index
hound diag request --session-name shop --index 14 --part request-body --json     # redacted body, no headers
hound browser close --session-name shop --json
hound script run --file "$TMP/home-h1.ts" --url https://example.com --json
printf '%s' '[{"command":"page find","args":{"text":"Guardar"}},{"command":"element click","args":{"ref":"$prev.matches.0.ref"}}]' | hound batch --session-name erp --file - --json   # validated up front; data.steps[]
hound script export --session-name shop --json   # data.file: a script run test; typed values become --arg params (data.params); before browser close; wait --for text values are copied as written
hound task run --task component --url https://example.com --arg selector=<css> --arg viewports=375,1280 --json
hound profile check --profile work --json        # data.state: valid | expired | unknown
hound profile list --json
hound browser list --json
```

Prefer `page find --text|--regex` over reading a whole snapshot on big pages (refs it returns work with `element` commands); `page snapshot --ref <ref>` reads one region and `page snapshot --diff` returns only the lines that changed since the tab's previous snapshot (the first call gives the full snapshot, `data.baseline` false), which saves tokens on big ERP pages. Use `element type` (not `fill`) for search-as-you-type fields and comboboxes; it needs `--actions interact`. Dialogs (alert, confirm, prompt, beforeunload) are dismissed by default and listed in `data.dialogs` (navigate/back/forward/reload always accept `beforeunload`; a late dialog within 2 s of an override shows in `diag dialogs`); accept one (`--dialog accept`, optional `--dialog-text` for prompts, or `browser open --dialog accept`) only when the user asked for that action, and it needs `--actions interact`. Upload only files the user named, never secrets: `.hound/`, `.env*`, HAR/trace files, SSH/cloud keys, browser profiles and credential files are refused (`ACTION_BLOCKED`). `page wait --for text` matches text anywhere unless you pass `--within <ref>`. Downloads and request bodies follow the same file-location rules below (`data.file`, `--output`, `--if-exists`). Never paste bodies or downloaded files into reports.

## Where to write files (`--output`, `--file`, scripts)

Captured pages can contain personal data, tokens or account details. Never let them land where they could be committed, shared or published.

- Prefer no `--output` at all: by default files go to sitehound's private `.hound/runs/`, and `data.file` gives the path.
- If you need a path you choose, use the system temp dir: `TMP=$(mktemp -d)` and write under `"$TMP"`.
- Or use a folder of the current repository that git ignores. Check it first with `git check-ignore -q <path>`; if the command fails, the path is NOT ignored and you must not write there.
- Never write captures into tracked folders, the repo root, shared or synced folders, or anything you will paste into a PR, issue or chat.
- Test scripts for `script run` follow the same rule: keep them in `"$TMP"` or an ignored folder.

## JSON contract

- Success: `{ ok: true, command, summary, data, next_actions? }`. Use `data` for results and `summary` for a one-line status.
- Error: `{ ok: false, command, error: { code, message, field?, received?, allowed? }, retryable, suggested_fix?: { command } }`.
- Exit codes: `0` success; `2` usage error (`UNKNOWN_COMMAND`, `INVALID_ARGUMENT`, `MISSING_REQUIRED_FLAG`, `INVALID_ENUM`, `CONFIRMATION_REQUIRED`); `1` any other error.
- `profile check` exits `0`; read `data.state`.
- Large snapshots are truncated inline; read `data.file` with `head -c 20000`, never a bare `cat` of a big file. `--output` fails with `CONFLICT` if the file exists (`--if-exists overwrite`). Values starting with `-` need `--flag=value`.
- The read level clicks only real http(s) links and `<summary>`, and refuses links that look like GET side effects (logout, sign out, delete, remove, unsubscribe, cerrar sesión, eliminar... in the path, query or link text, or a non-GET `data-method`) with `ACTION_BLOCKED`; that is a heuristic, so still do not click blindly.

## Error handling

- Follow `suggested_fix.command`; replace quoted placeholders such as `--url "<url>"` yourself. `INVALID_ENUM` suggests the nearest value, or nothing: read `error.allowed`.
- Ranges and patterns are in `--schema` and checked before anything runs (exit 2).
- `CONFIRMATION_REQUIRED`: `profile delete` needs `--dry-run`/`--yes`; `profile login` on an existing profile needs `--mode extend|replace`. Choose from `data.alternatives`.
- `TIMEOUT` on a state-changing action returns `retryable: false`: it may have been applied. Run `page snapshot` before retrying.
- `REF_NOT_FOUND`: take a new `page snapshot`, then use the new refs.
- `ACTION_BLOCKED`: do not reopen with `--actions interact` on your own. Ask the user first.
- `NO_TTY`, or `profile check` returns `expired`: stop and ask the human to log in again.
- `RUN_FAILED` (a check failed) or `RUN_ERROR` (the run threw): read `data.checks[]`, `data.summary` and the files in `data.runDir`.
- Never print cookies, headers, profile files or page content into your report; quote only the codes and summaries.
