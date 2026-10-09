/**
 * Safe writes to a caller-chosen `--output` path (page snapshot, page screenshot, element download, diag request).
 *
 * The content is first written to a private (0600) temp file in the destination directory, then published:
 * `rename` replaces whatever is at the destination (a symlink there is replaced, never followed), `link` fails with
 * EEXIST instead of overwriting. So `--if-exists error` can never overwrite a file or symlink that appeared after the
 * client's check, and `--if-exists overwrite` can never write through a link. Across file systems the staged file is
 * copied into the destination directory first, with the same guarantees.
 */
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, link, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HoundError } from "../errors.ts";

const tempIn = (output: string): string => join(dirname(output), `.hound-partial-${process.pid}-${randomBytes(6).toString("hex")}`);

export const outputExists = (output: string): HoundError =>
  new HoundError("CONFLICT", `--output already exists: ${output}. Pass --if-exists overwrite to replace it, or choose another path.`, { field: "output", received: output, retryable: false });

/** The HoundError for a failed write to a caller-chosen --output (or the original error when it is something else). */
export function outputError(err: unknown, file: string): unknown {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EISDIR") return new HoundError("INVALID_ARGUMENT", `--output must be a file path, but it is a directory: ${file}`, { field: "output", received: file });
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new HoundError("FILE_NOT_FOUND", `The directory for --output does not exist: ${dirname(file)}`, { field: "output", received: file });
  }
  if (code === "EACCES" || code === "EPERM") return new HoundError("PERMISSION_DENIED", `Cannot write --output: ${file}`, { field: "output", received: file });
  return err;
}

/** Errors of link()/rename() that mean "not possible here" (no hard links on vfat/exFAT/SMB/FUSE, or another file system), not "denied". */
const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EXDEV", "EMLINK", "ENOSYS"]);

/**
 * Publishes `from` as `output`: rename replaces, link refuses to overwrite. Where hard links do not exist the exclusive case
 * copies instead with COPYFILE_EXCL (an O_EXCL create: it also fails on an existing file or symlink, never follows one), and
 * removes the half-written copy if that fails.
 */
/** `linker` is link(); tests pass one that fails like a file system without hard links. */
export async function publish(from: string, output: string, overwrite: boolean, linker: (from: string, to: string) => Promise<void> = link): Promise<void> {
  if (overwrite) return rename(from, output);
  try {
    await linker(from, output);
  } catch (err) {
    if (!LINK_UNSUPPORTED.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
    try {
      await copyFile(from, output, fsConstants.COPYFILE_EXCL);
      await chmod(output, 0o600);
    } catch (copyErr) {
      // Only a file this call created may be removed: EEXIST means somebody else's file is there.
      if ((copyErr as NodeJS.ErrnoException).code !== "EEXIST") await rm(output, { force: true }).catch(() => {});
      throw copyErr;
    }
  }
}

const STALE_PARTIAL_MS = 60 * 60 * 1000;
const SWEEP_MAX_ENTRIES = 5000;

/** Removes our own leftover temp files (a crash between write and publish) older than an hour from the destination directory. Best effort. */
async function sweepStale(dir: string): Promise<void> {
  try {
    const me = process.getuid?.();
    for (const name of (await readdir(dir)).slice(0, SWEEP_MAX_ENTRIES)) {
      if (!name.startsWith(".hound-partial-")) continue;
      const file = join(dir, name);
      const st = await stat(file).catch(() => undefined);
      if (st?.isFile() && (me === undefined || st.uid === me) && Date.now() - st.mtimeMs > STALE_PARTIAL_MS) await rm(file, { force: true });
    }
  } catch {
    // unreadable directory: the write itself will report the real problem
  }
}

const failure = (err: unknown, output: string): unknown => ((err as NodeJS.ErrnoException).code === "EEXIST" ? outputExists(output) : outputError(err, output));

/** Moves a staged private file to `output`; copies via a private temp file in the destination dir across file systems. An exclusive publish leaves the staged file (a hard link) for the caller to delete; an overwrite moves it. */
export async function placeFile(staged: string, output: string, overwrite: boolean): Promise<string> {
  await sweepStale(dirname(output));
  let temp: string | undefined;
  try {
    try {
      await publish(staged, output, overwrite);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP" && code !== "EMLINK") throw err;
      temp = tempIn(output);
      await copyFile(staged, temp, fsConstants.COPYFILE_EXCL);
      await chmod(temp, 0o600);
      await publish(temp, output, overwrite);
    }
  } catch (err) {
    throw failure(err, output);
  } finally {
    if (temp) await rm(temp, { force: true }).catch(() => {});
  }
  return output;
}

/** Writes `data` to `output` through a private temp file in the same directory (see the module comment). */
export async function writeOutputSafe(output: string, data: string | Buffer, overwrite: boolean): Promise<void> {
  await sweepStale(dirname(output));
  const temp = tempIn(output);
  try {
    await writeFile(temp, data, { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await publish(temp, output, overwrite);
  } catch (err) {
    throw failure(err, output);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}
