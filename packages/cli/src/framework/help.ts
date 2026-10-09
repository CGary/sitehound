import type { Command, FlagSpec } from "./types.ts";
import { DOMAIN_DESCRIPTIONS, type Registry } from "./registry.ts";
import { placeholder } from "./usage.ts";

const UNIVERSAL_LINE = "Universal flags: --json --plain --quiet --debug --no-input --timeout <seconds> --schema --help --version";

export function rootHelp(registry: Registry, version: string): string {
  const domains = registry.domains();
  const width = Math.max(...domains.map((d) => d.length));
  return [
    `hound ${version} — drive a browser from the CLI: sessions, pages, tasks, scripts`,
    "",
    "Usage: hound <domain> <verb> [--flag value ...] --json",
    "",
    "Domains:",
    ...domains.map((d) => `  ${d.padEnd(width)}  ${DOMAIN_DESCRIPTIONS[d] ?? ""}`),
    "",
    UNIVERSAL_LINE,
    "Deprecated: mcp (Playwright MCP server); login run exec check tasks profiles forget (use the domain verb forms).",
    "More: hound <domain> --help   hound <domain> <verb> --help   hound <domain> <verb> --schema",
  ].join("\n");
}

export function domainHelp(registry: Registry, domain: string): string {
  const cmds = registry.verbs(domain);
  const width = Math.max(...cmds.map((c) => c.name.length));
  return [
    `hound ${domain} — ${DOMAIN_DESCRIPTIONS[domain] ?? ""}`,
    "",
    ...cmds.map((c) => `  ${c.name.replace(".", " ").padEnd(width)}  ${c.description}`),
    "",
    `More: hound ${domain} <verb> --help`,
  ].join("\n");
}

function flagLine(name: string, spec: FlagSpec): string {
  const left = `--${name}${spec.type === "boolean" ? "" : ` ${placeholder(name, spec)}`}`;
  const notes = [
    spec.required ? "required" : undefined,
    spec.repeatable ? "repeatable" : undefined,
    spec.default !== undefined ? `default ${spec.default}` : undefined,
    spec.min !== undefined || spec.max !== undefined ? `${spec.min ?? ""}..${spec.max ?? ""}` : undefined,
    spec.pattern !== undefined ? `pattern ${spec.pattern}${spec.patternFlags?.includes("i") ? " (case-insensitive)" : ""}` : undefined,
  ].filter(Boolean);
  return `  ${left.padEnd(34)} ${spec.description}${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

export function commandHelp(cmd: Command): string {
  const lines = [`hound ${cmd.name.replace(".", " ")} — ${cmd.description}`, `Kind: ${cmd.kind}`, "", "Flags:"];
  const entries = Object.entries(cmd.flags);
  if (!entries.length) lines.push("  (none)");
  for (const [n, s] of entries) lines.push(flagLine(n, s));
  for (const g of [...(cmd.requires ?? []), ...(cmd.confirm ?? []).map((c) => c.oneOf)]) lines.push(`  exactly one of: ${g.map((n) => `--${n}`).join(" | ")}`);
  for (const g of cmd.requiresAny ?? []) lines.push(`  at least one of: ${g.map((n) => `--${n}`).join(" | ")}`);
  for (const r of cmd.requiresWhen ?? []) {
    const when = Object.entries(r.when).map(([k, v]) => `--${k} ${Array.isArray(v) ? v.join("|") : v}`).join(" and ");
    if (r.require?.length) lines.push(`  with ${when}: requires ${r.require.map((n) => `--${n}`).join(", ")}`);
    if (r.forbid?.length) lines.push(`  with ${when}: not allowed ${r.forbid.map((n) => `--${n}`).join(", ")}`);
    for (const [n, vs] of Object.entries(r.restrict ?? {})) lines.push(`  with ${when}: --${n} one of ${vs.join("|")}`);
  }
  if (cmd.timeoutSeconds) lines.push(`  default --timeout ${cmd.timeoutSeconds}s`);
  lines.push("", UNIVERSAL_LINE, "", "Examples:", ...cmd.examples.map((e) => `  ${e}`));
  return lines.join("\n");
}
