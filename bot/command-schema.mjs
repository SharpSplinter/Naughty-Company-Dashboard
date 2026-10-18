// Canonical guild slash-command schema, assembled from one definition file per root command.
import { linkCommand } from "./commands/link.mjs";
import { linkcodeCommand } from "./commands/link-code.mjs";
import { statusCommand } from "./commands/status.mjs";
import { unlinkCommand } from "./commands/unlink.mjs";
import { pingCommand } from "./commands/ping.mjs";
import { helpCommand } from "./commands/help.mjs";
import { botCommand } from "./commands/bot.mjs";
import { dashboardCommand } from "./commands/dashboard.mjs";
import { automationCommand } from "./commands/automation.mjs";
import { companyCommand } from "./commands/company.mjs";

// This array is the exact set of guild root commands owned by Naughty Company Bot.
export const commands = [
  linkCommand,
  linkcodeCommand,
  statusCommand,
  unlinkCommand,
  pingCommand,
  helpCommand,
  botCommand,
  dashboardCommand,
  automationCommand,
  companyCommand
];
