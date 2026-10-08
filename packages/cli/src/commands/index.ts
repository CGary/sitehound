import type { Command } from "../framework/types.ts";
import { browserCommands } from "./browser.ts";
import { diagCommands } from "./diag.ts";
import { elementCommands } from "./element.ts";
import { pageCommands } from "./page.ts";
import { profileCommands } from "./profile.ts";
import { scriptCommands } from "./script.ts";
import { taskCommands } from "./task.ts";

/** The command catalog. To add commands: create commands/<domain>.ts exporting an array and spread it here. */
export const COMMANDS: readonly Command[] = [...browserCommands, ...pageCommands, ...elementCommands, ...diagCommands, ...profileCommands, ...taskCommands, ...scriptCommands];
