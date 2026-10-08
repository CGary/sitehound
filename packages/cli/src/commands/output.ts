import { lstat } from "node:fs/promises";
import { HoundError } from "@sitehound/core/errors";
import type { FlagSpec } from "../framework/types.ts";
import { usageLine } from "../framework/usage.ts";
import type { Command } from "../framework/types.ts";

/** `--output` + `--if-exists` for any command that writes a caller-chosen file. */
export const OUTPUT_FLAGS: Record<string, FlagSpec> = {
  output: { type: "path", description: "Write the full output to this file (relative paths resolve against the current directory; refuses directories and symlinks)" },
  "if-exists": { type: "enum", values: ["error", "overwrite"], default: "error", description: "What to do when --output already exists: error (CONFLICT) or overwrite" },
};

/**
 * Validates a caller `--output` path before anything is written: not a directory, not a symlink, and not an
 * existing file unless `--if-exists overwrite`. `path` is already absolute (resolved against the caller's cwd).
 */
export async function checkOutputPath(cmd: Command, given: Record<string, unknown>, path: string, ifExists: "error" | "overwrite"): Promise<void> {
  let st;
  try {
    st = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new HoundError("PERMISSION_DENIED", `Cannot inspect --output: ${path}`, { field: "output", received: path });
  }
  if (st.isSymbolicLink()) {
    throw new HoundError("INVALID_ARGUMENT", `--output is a symlink; refusing to write through it: ${path}`, { field: "output", received: path, retryable: true });
  }
  if (st.isDirectory()) {
    throw new HoundError("INVALID_ARGUMENT", `--output is a directory; give a file path inside it: ${path}`, { field: "output", received: path, retryable: true });
  }
  if (ifExists === "error") {
    throw new HoundError("CONFLICT", `--output already exists: ${path}. Pass --if-exists overwrite to replace it, or choose another path.`, {
      field: "output",
      received: path,
      retryable: false,
      suggestedFix: usageLine(cmd, given, { "if-exists": "overwrite" }),
    });
  }
}
