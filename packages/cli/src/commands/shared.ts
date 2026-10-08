import { statSync } from "node:fs";
import { HoundError } from "@sitehound/core/errors";
import type { CommandContext, FlagSpec, Input, NextAction } from "../framework/types.ts";
import { shellQuote } from "../framework/usage.ts";

export { shellQuote };

/** `hound <words...> --json` with each word shell-quoted when needed. */
export const houndCmd = (...words: string[]): string => `hound ${words.map(shellQuote).join(" ")} --json`;

/** Parses an absolute URL for a --url flag or throws INVALID_ARGUMENT. */
export function parseUrlFlag(field: string, value: string, protocols: readonly string[] = ["http:", "https:"]): URL {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    // handled below
  }
  if (!url || !protocols.includes(url.protocol)) {
    throw new HoundError("INVALID_ARGUMENT", `--${field} must be an absolute ${protocols.map((p) => p.replace(":", "")).join("/")} URL, got "${value.slice(0, 200)}".`, {
      field,
      received: value.slice(0, 200),
      retryable: true,
    });
  }
  return url;
}

/** The flags the caller passed explicitly, with their typed values (for building corrected commands). */
export const givenInput = (input: Input, ctx: CommandContext): Record<string, unknown> =>
  Object.fromEntries([...ctx.given].filter((n) => input[n] !== undefined).map((n) => [n, input[n]]));

/** Files larger than this are never suggested with a bare `cat`. */
export const CAT_LIMIT_BYTES = 20_000;

/** A next action that reads `file`: `cat` when small, `head -c 20000` (plus a size note) when large. */
export function readFileAction(file: string, reason: string, size?: number): NextAction {
  let bytes = size;
  if (bytes === undefined) {
    try {
      bytes = statSync(file).size;
    } catch {
      bytes = 0;
    }
  }
  if (bytes > CAT_LIMIT_BYTES) {
    return { command: `head -c ${CAT_LIMIT_BYTES} ${shellQuote(file)}`, reason: `${reason} The file is ${Math.round(bytes / 1000)} KB: this shows the first 20 KB; use a deeper or narrower query for the rest.` };
  }
  return { command: `cat ${shellQuote(file)}`, reason };
}

/** Same rule as readFileAction, as a bare command (for suggested fixes). */
export const readFileCommand = (file: string): string => readFileAction(file, "").command;

/** Flag spec for a name that must be a safe identifier (sessions, profiles, tasks). */
export const NAME_RULE: Pick<FlagSpec, "pattern" | "patternFlags" | "patternHint" | "maxLength"> = {
  pattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
  patternFlags: "i",
  patternHint: "1-64 characters: letters, digits, '.', '_' or '-', starting with a letter or digit",
  maxLength: 64,
};
