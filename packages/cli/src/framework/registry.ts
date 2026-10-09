import { HoundError } from "@sitehound/core/errors";
import type { Command } from "./types.ts";
import { distance } from "./nearest.ts";
import { usageLine } from "./usage.ts";

export const DOMAIN_DESCRIPTIONS: Record<string, string> = {
  browser: "Open, close and inspect persistent browser sessions",
  page: "Navigate, read, search, wait, resize, emulate and screenshot the current page of a session",
  element: "Click, drag, read, fill, type, select, press keys, upload and download from page elements by ref",
  diag: "Console, dialog, network, request-body and trace diagnostics of a session",
  profile: "Saved logins: list, check, log in (human), delete",
  task: "Built-in capture tasks (snapshot, component): list and run",
  script: "Run a single-file test/extraction script",
};

export interface Registry {
  commands: readonly Command[];
  byName: ReadonlyMap<string, Command>;
  domains(): string[];
  verbs(domain: string): Command[];
  find(domain: string | undefined, verb: string | undefined): Command | undefined;
}

export function buildRegistry(commands: readonly Command[]): Registry {
  const byName = new Map<string, Command>();
  for (const c of commands) {
    if (!/^[a-z]+\.[a-z-]+$/.test(c.name)) throw new Error(`Bad command name "${c.name}" (want domain.verb)`);
    if (byName.has(c.name)) throw new Error(`Duplicate command "${c.name}"`);
    byName.set(c.name, c);
  }
  const split = (c: Command) => c.name.split(".") as [string, string];
  return {
    commands,
    byName,
    domains: () => [...new Set(commands.map((c) => split(c)[0]))],
    verbs: (domain) => commands.filter((c) => split(c)[0] === domain),
    find: (domain, verb) => (domain && verb ? byName.get(`${domain}.${verb}`) : undefined),
  };
}

/** UNKNOWN_COMMAND error naming the closest valid command as the suggested fix. */
export function unknownCommand(registry: Registry, domain: string, verb: string | undefined): HoundError {
  const typed = verb ? `${domain} ${verb}` : domain;
  let pool: Command[];
  let query: string;
  let allowed: string[];
  if (registry.domains().includes(domain)) {
    pool = registry.verbs(domain);
    query = `${domain} ${verb ?? ""}`;
    allowed = pool.map((c) => c.name.replace(".", " "));
  } else {
    pool = [...registry.commands];
    query = verb ? `${domain} ${verb}` : domain;
    allowed = registry.domains();
  }
  let best: { cmd: Command; d: number } | undefined;
  for (const cmd of pool) {
    const name = cmd.name.replace(".", " ");
    const d = verb || pool !== registry.commands ? distance(query, name) : distance(query, name.split(" ")[0]!);
    if (!best || d < best.d) best = { cmd, d };
  }
  const near = best && best.d <= Math.max(3, Math.ceil(query.length / 2)) ? best.cmd : undefined;
  return new HoundError("UNKNOWN_COMMAND", `Unknown command "${typed}".${near ? ` Did you mean "${near.name.replace(".", " ")}"?` : ""}`, {
    field: "command",
    received: typed,
    allowed,
    retryable: true,
    suggestedFix: near ? usageLine(near) : "hound --help",
  });
}
