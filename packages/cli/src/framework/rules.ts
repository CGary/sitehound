import { HoundError } from "@sitehound/core/errors";
import type { Command, Input } from "./types.ts";
import { usageLine } from "./usage.ts";

/** Throws INVALID_ARGUMENT when the text read for the command (`chars` characters) breaks one of its declared cost rules. */
export function checkCostRules(cmd: Command, input: Input, given: Record<string, unknown>, chars: number): void {
  for (const rule of cmd.costRules ?? []) {
    const per = Number(input[rule.perChar] ?? 0);
    if (rule.baseMs + chars * (per + rule.extraMs) <= rule.maxMs) continue;
    const fits = chars > 0 ? Math.floor((rule.maxMs - rule.baseMs) / chars) - rule.extraMs : -1;
    throw new HoundError(
      "INVALID_ARGUMENT",
      `Typing ${chars} characters at ${per} ms each takes over ${rule.maxMs / 1000} s (about ${rule.extraMs} ms extra per key). Lower --${rule.perChar} or shorten the value.`,
      {
        field: rule.perChar,
        received: per,
        retryable: true,
        ...(fits >= 0 && { suggestedFix: usageLine(cmd, given, { [rule.perChar]: fits }) }),
      },
    );
  }
}

/** Throws INVALID_ARGUMENT when text read from a file or stdin is longer than the flag's declared `maxChars`. */
export function checkMaxChars(cmd: Command, flag: string, chars: number): void {
  const max = cmd.flags[flag]?.maxChars;
  if (max !== undefined && chars > max) {
    throw new HoundError("INVALID_ARGUMENT", `The content of --${flag} is ${chars} characters; at most ${max} are allowed.`, { field: flag, retryable: false });
  }
}
