import type { Command, FlagSpec, WhenValue } from "./types.ts";

/** Quotes a value for a POSIX shell only when needed. `<placeholder>` values get double quotes (a bare `<` is a redirect). */
export function shellQuote(value: string): string {
  if (/^<[A-Za-z0-9_|-]+>$/.test(value)) return `"${value}"`;
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The raw placeholder text (`<ref>`, `<n>`, `<a|b>`), as shown in help. usageLine quotes it. */
export function placeholder(name: string, spec: FlagSpec): string {
  if (spec.type === "enum") return `<${(spec.values ?? []).join("|")}>`;
  if (spec.type === "integer") return "<n>";
  if (spec.type === "path") return "<path>";
  return `<${name}>`;
}

function render(name: string, spec: FlagSpec, value: unknown): string[] {
  if (spec.type === "boolean") return value === false ? [] : [`--${name}`];
  const values = Array.isArray(value) ? value : [value];
  // A value starting with "-" must be glued to its flag, or it would read as another flag.
  return values.flatMap((v) => {
    const text = String(v);
    return text.startsWith("-") && text !== "-" ? [`--${name}=${shellQuote(text)}`] : [`--${name}`, shellQuote(text)];
  });
}

const matches = (actual: unknown, want: WhenValue): boolean => (Array.isArray(want) ? want.includes(String(actual)) : actual === want);

/** True when a rule's `when` matches `values` (the typed input, defaults included). */
export const ruleApplies = (when: Record<string, WhenValue>, values: Record<string, unknown>): boolean =>
  Object.entries(when).every(([k, want]) => matches(values[k], want));

/**
 * A complete corrected command for `cmd`: the flags already given (except sensitive ones), then
 * quoted placeholders for the required flags (including conditionally required ones) and one member of each
 * exactly-one-of group still missing. `replace` entries are always rendered (the caller vouches for them).
 */
export function usageLine(cmd: Command, given: Record<string, unknown> = {}, replace: Record<string, unknown> = {}): string {
  const parts = ["hound", ...cmd.name.split(".")];
  const done = new Set<string>();
  const emit = (name: string, value: unknown) => {
    const spec = cmd.flags[name];
    if (!spec || value === undefined) return;
    parts.push(...render(name, spec, value));
    done.add(name);
  };
  for (const [name, value] of Object.entries(given)) {
    const spec = cmd.flags[name];
    if (!spec || name in replace) continue;
    if (spec.sensitive || name === "value") {
      // Never echo what the caller typed: leave a quoted placeholder to substitute.
      parts.push(`--${name}`, shellQuote(placeholder(name, spec)));
      done.add(name);
      continue;
    }
    emit(name, value);
  }
  for (const [name, value] of Object.entries(replace)) emit(name, value);
  const ph = (name: string) => shellQuote(placeholder(name, cmd.flags[name]!));
  for (const [name, spec] of Object.entries(cmd.flags)) {
    if (spec.required && !done.has(name) && spec.default === undefined) parts.push(`--${name}`, ph(name));
  }
  for (const group of [...(cmd.requires ?? []), ...(cmd.confirm ?? []).map((c) => c.oneOf)]) {
    if (group.some((n) => done.has(n) || given[n] !== undefined)) continue;
    const name = group[0]!;
    parts.push(...(cmd.flags[name]!.type === "boolean" ? [`--${name}`] : [`--${name}`, ph(name)]));
  }
  const effective: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(cmd.flags)) if (spec.default !== undefined) effective[name] = spec.default;
  Object.assign(effective, given, replace);
  for (const rule of cmd.requiresWhen ?? []) {
    if (!ruleApplies(rule.when, effective)) continue;
    for (const name of rule.require ?? []) {
      if (done.has(name) || given[name] !== undefined) continue;
      parts.push(`--${name}`, ph(name));
      done.add(name);
    }
  }
  parts.push("--json");
  return parts.join(" ");
}
