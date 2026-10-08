# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.x (`main`) | Yes |

## Reporting a vulnerability

Report privately. Do **not** open a public issue or pull request.

Use GitHub private vulnerability reporting: on [CGary/sitehound](https://github.com/CGary/sitehound), go to **Security > Advisories > Report a vulnerability**. Include reproduction steps, affected version/commit and impact. Never attach real profiles, HAR files or traces; redact tokens and personal data.

## Handling sensitive data

sitehound saves logged-in browser sessions, so treat its output as secret.

- **Profiles are bearer credentials.** A file in `.hound/profiles/` (cookies, localStorage, IndexedDB) grants access to the account it was saved from, with no password or 2FA. Never share, upload, paste or commit one.
- **`.hound/` layout and protections.** All runtime data (`profiles/`, `runs/`) lives under `.hound/` (or `HOUND_HOME`). It is gitignored, contains its own `.gitignore` with `*`, and is created with `0700` directories and `0600` files. The `.githooks/pre-commit` hook (enabled by `pnpm install`) blocks staged files that look like sessions, captures or secrets, and scans staged text for cookie/authorization headers and common token shapes. Do not bypass it with `--no-verify`.
- **Captures may contain secrets.** HARs, traces, screenshots and saved HTML of authenticated pages can include tokens, cookies and personal data. Do not share or attach them to issues; redact first.
- **If a profile leaks:** log out / revoke sessions on the affected site (and change the password if the site does not invalidate sessions on logout), then run `bin/hound profile delete --profile <profile> --yes` to delete the local copy. Rotate any tokens that appeared in captures.
- **Supply chain.** Install scripts are denied except for packages listed in `allowBuilds` in `pnpm-workspace.yaml`; pnpm's minimum release age is respected (no `minimumReleaseAgeExclude`); `pnpm-lock.yaml` is committed and reviewed with dependency changes.
