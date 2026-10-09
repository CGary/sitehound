import type { Command, FlagSpec } from "./types.ts";
import { UNIVERSAL_FLAGS } from "./parse.ts";

function property(spec: FlagSpec): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: spec.type === "integer" ? "integer" : spec.type === "boolean" ? "boolean" : "string",
  };
  if (spec.type === "path") base.format = "path";
  if (spec.type === "enum") base.enum = spec.values;
  if (spec.default !== undefined) base.default = spec.default;
  if (spec.min !== undefined) base.minimum = spec.min;
  if (spec.max !== undefined) base.maximum = spec.max;
  if (spec.pattern !== undefined) base.pattern = spec.pattern;
  if (spec.patternFlags) base.pattern_flags = spec.patternFlags;
  if (spec.maxLength !== undefined) base.maxLength = spec.maxLength;
  if (spec.maxChars !== undefined) base.maxChars = spec.maxChars;
  if (spec.sensitive) base.sensitive = true;
  base.description = spec.description;
  return spec.repeatable ? { type: "array", items: base, description: spec.description } : base;
}

/** The `--schema` JSON contract of a command. */
export function commandSchema(cmd: Command): unknown {
  return {
    command: cmd.name,
    description: cmd.description,
    kind: cmd.kind,
    input: {
      required: Object.entries(cmd.flags).filter(([, s]) => s.required).map(([n]) => n),
      ...((cmd.requires?.length || cmd.confirm?.length) && { one_of: [...(cmd.requires ?? []), ...(cmd.confirm ?? []).map((c) => c.oneOf)] }),
      ...(cmd.requiresAny?.length && { any_of: cmd.requiresAny }),
      ...(cmd.confirm?.length && { confirmation_required: cmd.confirm.map((c) => ({ one_of: c.oneOf, message: c.message })) }),
      ...(cmd.requiresWhen?.length && { conditional: cmd.requiresWhen }),
      ...(cmd.costRules?.length && {
        cost_rules: cmd.costRules.map((r) => ({
          ...r,
          formula: `${r.baseMs} + chars of (${r.text.join(" | ")}) * (--${r.perChar} + ${r.extraMs}) <= ${r.maxMs} ms`,
        })),
      }),
      properties: Object.fromEntries(Object.entries(cmd.flags).map(([n, s]) => [n, property(s)])),
      universal: Object.keys(UNIVERSAL_FLAGS),
    },
    output: { type: "object", required: ["ok", "command", "summary", "data"] },
    ...(cmd.timeoutSeconds && { default_timeout_seconds: cmd.timeoutSeconds }),
    examples: cmd.examples,
  };
}
