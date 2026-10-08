/**
 * Entry point of the detached browser-session daemon. Spawned by openBrowserSession as
 * `node daemon.ts <session-dir>`; configuration is read from `<session-dir>/config.json`.
 * Runs under plain Node type stripping (no tsx).
 */
import { failDaemon, runDaemon } from "./server.ts";

const dir = process.argv[2];
if (!dir) {
  process.stderr.write("usage: daemon.ts <session-dir>\n");
  process.exit(2);
}
runDaemon(dir).catch((err: unknown) => failDaemon(dir, err));
