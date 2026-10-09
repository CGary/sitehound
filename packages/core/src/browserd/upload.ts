/**
 * Safety checks for `element upload`: which local files may be handed to a web page.
 * Real paths are resolved first (a symlink cannot smuggle a protected file in under a harmless name); only regular files
 * are accepted; sitehound's own data and obvious secrets are refused; the total size is capped.
 */
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { HoundError } from "../errors.ts";
import { HOUND_HOME } from "../paths.ts";
import { UPLOAD_MAX_BYTES, UPLOAD_MAX_FILES } from "./limits.ts";

/** File names that are refused wherever they live. */
const BLOCKED_NAMES: readonly (readonly [RegExp, string])[] = [
  [/^\.env(\..*)?$|\.env$|^\.envrc$/i, "an environment file (.env)"],
  [/\.har$/i, "a HAR network capture"],
  [/(^|[-_.])trace.*\.zip$/i, "a Playwright trace"],
  [/^id_(rsa|ed25519|ecdsa|dsa)/i, "an SSH private key"],
  [/\.(pem|key|p12|pfx|kdbx?)$/i, "a key, certificate or password-vault file"],
  [/^\.(netrc|pgpass|npmrc|pypirc|git-credentials|vault-token)$/i, "a credentials file"],
  [/^(service[-_]?account.*|credentials|client_secrets?)\.json$/i, "a credentials file"],
  [/^\.?(bash|zsh|fish|python|node_repl|psql|mysql|sqlite)_history$/i, "a shell or REPL history"],
];

/** Directories (relative to the home directory) that are refused with everything under them. */
const BLOCKED_HOME_DIRS: readonly string[] = [
  ".ssh", ".aws", ".gnupg", ".docker", ".kube", ".azure", ".terraform.d", ".password-store", ".mozilla",
  join(".config", "gcloud"), join(".config", "gh"), join(".config", "google-chrome"), join(".config", "chromium"), join(".config", "BraveSoftware"),
  join(".local", "share", "keyrings"),
];
/** System directories that expose process and kernel data, not user files. */
const BLOCKED_SYSTEM_DIRS: readonly string[] = ["/proc", "/sys", "/dev"];

export interface UploadFile {
  /** Real, absolute path to hand to the browser. */
  path: string;
  /** Basename only: all that is ever reported. */
  name: string;
  bytes: number;
}

const isUnder = (path: string, dir: string): boolean => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

const refuse = (name: string, why: string): HoundError =>
  new HoundError("ACTION_BLOCKED", `Refusing to upload "${name}": ${why}. Upload only files the user named, never credentials or sitehound data.`, {
    field: "file",
    received: name,
    retryable: false,
  });

/** Why `path` must not be uploaded, or undefined. `dirs` are the blocked directory roots (raw and real). */
function blockReason(path: string, dirs: readonly string[]): string | undefined {
  const name = basename(path);
  for (const [re, what] of BLOCKED_NAMES) if (re.test(name)) return `it is ${what}`;
  if (path.split(sep).includes(".hound")) return "it is inside a .hound directory (sitehound profiles, sessions and runs)";
  if (dirs.some((d) => isUnder(path, d))) return "it is inside sitehound's data, a credentials directory (~/.ssh, ~/.aws, ~/.gnupg, ~/.kube, ~/.docker, cloud CLIs), a browser profile or a system directory (/proc, /sys, /dev)";
  return undefined;
}

async function blockedDirs(): Promise<string[]> {
  const home = homedir();
  const roots = [HOUND_HOME, ...BLOCKED_HOME_DIRS.map((d) => join(home, d)), ...BLOCKED_SYSTEM_DIRS];
  const real = await Promise.all(roots.map((d) => realpath(d).catch(() => undefined)));
  return [...new Set([...roots, ...real.filter((d): d is string => d !== undefined)])];
}

/**
 * Validates the paths of one upload and returns them resolved. Throws FILE_NOT_FOUND (missing), ACTION_BLOCKED (protected),
 * INVALID_ARGUMENT (not a regular file, too many files, over the size cap). Messages carry basenames only.
 */
export async function resolveUploadFiles(paths: readonly string[]): Promise<UploadFile[]> {
  if (paths.length === 0 || paths.length > UPLOAD_MAX_FILES) {
    throw new HoundError("INVALID_ARGUMENT", `--file must be given 1 to ${UPLOAD_MAX_FILES} times, got ${paths.length}.`, { field: "file", received: paths.length });
  }
  const dirs = await blockedDirs();
  const out: UploadFile[] = [];
  let total = 0;
  for (const given of paths) {
    const abs = resolve(given);
    const name = basename(abs);
    // Lexical check first, so a protected name is refused without revealing whether it exists.
    const first = blockReason(abs, dirs);
    if (first) throw refuse(name, first);
    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      throw new HoundError("FILE_NOT_FOUND", `File not found: ${name}`, { field: "file", received: name, retryable: true });
    }
    const second = blockReason(real, dirs);
    if (second) throw refuse(name, second);
    const info = await stat(real);
    if (!info.isFile()) throw new HoundError("INVALID_ARGUMENT", `"${name}" is not a regular file.`, { field: "file", received: name, retryable: true });
    if (info.nlink > 1) {
      throw new HoundError("INVALID_ARGUMENT", `"${name}" is a hard-linked file (${info.nlink} names), which could be a protected file under another name; copy it to a new file first.`, {
        field: "file",
        received: name,
        retryable: true,
      });
    }
    total += info.size;
    if (total > UPLOAD_MAX_BYTES) {
      throw new HoundError("INVALID_ARGUMENT", `The files total more than ${UPLOAD_MAX_BYTES / (1024 * 1024)} MiB; upload fewer or smaller files.`, {
        field: "file",
        received: name,
        retryable: false,
      });
    }
    out.push({ path: real, name: basename(real), bytes: info.size });
  }
  return out;
}
