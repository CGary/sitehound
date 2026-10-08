---
name: sitehound
description: Use when you need to browse, read, test or capture a website, including logged-in sites, through the sitehound CLI (`hound`): open a browser session, navigate, snapshot the page, click or fill by ref, run a test script, capture a component, or check a saved login profile. Do NOT use for plain HTTP requests or API calls, for sites the user has not authorized, or for logging in on the user's behalf (a human must log in).
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

## Common commands

```sh
hound browser open --session-name shop --json
hound page navigate --session-name shop --url https://example.com --json
hound page snapshot --session-name shop --limit-chars 4000 --json   # refs like e12 or f3e4
hound element click --session-name shop --ref e12 --json
hound element type --session-name shop --ref e7 --value "mar" --clear --json    # real key events (interact)
hound element download --session-name shop --ref e30 --json                      # click + save the file; data.file
hound diag network --session-name shop --state all --json                        # each request has an index
hound diag request --session-name shop --index 14 --part request-body --json     # redacted body, no headers
hound browser close --session-name shop --json
hound script run --file "$TMP/home-h1.ts" --url https://example.com --json
hound task run --task component --url https://example.com --arg selector=<css> --arg viewports=375,1280 --json
hound profile check --profile work --json        # data.state: valid | expired | unknown
hound profile list --json
hound browser list --json
```

Use `element type` (not `fill`) for search-as-you-type fields and comboboxes; it needs `--actions interact`. Downloads and request bodies follow the same file-location rules below (`data.file`, `--output`, `--if-exists`). Never paste bodies or downloaded files into reports.

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
- The read level clicks only real http(s) links and `<summary>`; GET links with side effects (`/logout`) are not detected.

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
