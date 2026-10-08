/** Paths and on-disk state shared by the browserd client and daemon. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HoundError } from "../errors.ts";
import { RUNS_DIR, SESSIONS_DIR, assertSafeName } from "../paths.ts";
import type { BrowserOp, DaemonState } from "./types.ts";

/** The daemon's entry script; also how a pid is recognised as ours (via /proc/<pid>/cmdline). */
export const DAEMON_ENTRY = fileURLToPath(new URL("./daemon.ts", import.meta.url));

export const STATE_FILE = "state.json";
export const CONFIG_FILE = "config.json";
export const PID_FILE = "pid";
export const LOG_FILE = "daemon.log";
export const STARTUP_ERROR_FILE = "startup-error.json";
const SOCKET_NAME = "browserd.sock";
/** sun_path is 108 bytes on Linux, 104 on macOS; stay under both with a margin. */
const MAX_SOCKET_PATH = 100;

export function sessionDir(name: string): string {
  assertSafeName("session-name", name);
  return join(SESSIONS_DIR, name);
}

/** Where page-derived outputs (snapshots, screenshots, traces) of a session go. */
export function sessionRunsDir(name: string): string {
  assertSafeName("session-name", name);
  return join(RUNS_DIR, "browser", name);
}

function fallbackSocketRoot(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  return xdg ? join(xdg, "sitehound") : join(tmpdir(), `sitehound-${process.getuid?.() ?? "u"}`);
}

/**
 * The daemon's socket path, derived from the session dir alone (never read from state.json, which
 * could be forged): inside the dir, or (when that would be too long for a unix socket) a hashed
 * name in a private dir under $XDG_RUNTIME_DIR or the OS temp dir.
 */
export function socketPathFor(dir: string): string {
  const inDir = join(dir, SOCKET_NAME);
  if (Buffer.byteLength(inDir) <= MAX_SOCKET_PATH) return inDir;
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 24);
  return join(fallbackSocketRoot(), `browserd-${hash}.sock`);
}

export async function chooseSocketPath(dir: string): Promise<string> {
  const path = socketPathFor(dir);
  if (!path.startsWith(dir)) {
    const root = fallbackSocketRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
  }
  return path;
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export const readState = (dir: string): Promise<DaemonState | undefined> => readJson<DaemonState>(join(dir, STATE_FILE));

export async function readPid(dir: string): Promise<number | undefined> {
  const state = await readState(dir);
  if (state && Number.isInteger(state.pid)) return state.pid;
  const pid = Number.parseInt(await readFile(join(dir, PID_FILE), "utf8").catch(() => ""), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Signal 0 only checks existence; it never delivers anything. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Is this pid positively a sitehound daemon for this session dir? Reads /proc/<pid>/cmdline, so it is
 * false where /proc does not exist (the caller then treats the pid as unverified and never signals it).
 */
export function isDaemonProcess(pid: number, dir: string): boolean {
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return args.includes(DAEMON_ENTRY) && args.includes(dir);
  } catch {
    return false;
  }
}

/** Removes a session dir and its out-of-dir socket (derived from the dir, not from state.json). */
export async function removeSessionDir(dir: string): Promise<void> {
  const sock = socketPathFor(dir);
  if (!sock.startsWith(dir)) await rm(sock, { force: true }).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}

const STATE_CHANGING_OPS = new Set<BrowserOp>(["navigate", "click", "fill", "select", "press", "type", "download", "back", "forward", "reload"]);

/** Ops whose effect may have landed even if the caller saw a timeout (tabs: only new/close). */
export function isStateChanging(op: BrowserOp, params: Record<string, unknown>): boolean {
  if (op === "tabs") return params.action === "new" || params.action === "close";
  return STATE_CHANGING_OPS.has(op);
}

export const IDLE_TIMEOUT_MIN = 1;
export const IDLE_TIMEOUT_MAX = 1440;

/** Throws INVALID_ARGUMENT (field "idle-timeout") unless the minutes are a finite number in 1..1440. */
export function assertIdleTimeout(minutes: unknown): void {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < IDLE_TIMEOUT_MIN || minutes > IDLE_TIMEOUT_MAX) {
    throw new HoundError("INVALID_ARGUMENT", `--idle-timeout must be a number of minutes from ${IDLE_TIMEOUT_MIN} to ${IDLE_TIMEOUT_MAX}.`, {
      field: "idle-timeout",
      received: minutes,
    });
  }
}

export function sessionNotFound(name: string, why = "No browser session with that name is running."): HoundError {
  return new HoundError("SESSION_NOT_FOUND", `${why} (session "${name}")`, {
    field: "session-name",
    received: name,
    suggestedFix: `hound browser open --session-name ${name} --json`,
  });
}
