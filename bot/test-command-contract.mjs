import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { commands } from "./command-schema.mjs";

const rootNames = commands.map(command => command.name);
assert.equal(new Set(rootNames).size, rootNames.length, "top-level command names must be unique");

const validName = /^[a-z0-9_-]{1,32}$/;
function validateCommand(command) {
  assert.match(command.name, validName, "Discord command names must use valid lowercase names");
  assert.ok(command.description.length > 0 && command.description.length <= 100, command.name + " description length");
  assert.ok(!Object.prototype.hasOwnProperty.call(command, "options") || command.options.length <= 25, command.name + " option count");
  const options = command.options || [];
  assert.equal(new Set(options.map(option => option.name)).size, options.length, command.name + " duplicate option/subcommand");
  for (const option of options) {
    assert.match(option.name, validName, command.name + " option name");
    assert.ok(option.description.length > 0 && option.description.length <= 100, command.name + "/" + option.name + " description length");
    if (option.type === 1) {
      assert.ok(!Object.prototype.hasOwnProperty.call(option, "required"), "subcommands cannot have required flags");
      assert.ok(!Object.prototype.hasOwnProperty.call(option, "choices"), "subcommands cannot have choices");
      assert.ok(!Object.prototype.hasOwnProperty.call(option, "options") || option.options.length <= 25, command.name + "/" + option.name + " option count");
      const childOptions = option.options || [];
      assert.equal(new Set(childOptions.map(child => child.name)).size, childOptions.length, command.name + "/" + option.name + " duplicate arguments");
      for (const child of childOptions) {
        assert.match(child.name, validName, command.name + "/" + option.name + " argument name");
        assert.ok(child.description.length > 0 && child.description.length <= 100, command.name + "/" + option.name + "/" + child.name + " description length");
        assert.ok(!Object.prototype.hasOwnProperty.call(child, "options"), "Discord allows only one subcommand level");
        assert.ok(!Object.prototype.hasOwnProperty.call(child, "choices") || child.choices.length <= 25, "choice limit");
      }
    } else {
      assert.ok(!Object.prototype.hasOwnProperty.call(option, "options"), "top-level non-subcommand options cannot contain nested options");
    }
  }
}
for (const command of commands) validateCommand(command);

const commandsByName = new Map(commands.map(command => [command.name, command]));
const companyCommands = (commandsByName.get("company")?.options || []).map(option => option.name);
for (const name of ["list", "overview", "income", "profit", "stars", "ads", "stock", "employees", "wages", "alerts", "trends"]) {
  assert.ok(companyCommands.includes(name), "missing /company " + name);
}
const rankingCommands = (commandsByName.get("rankings")?.options || []).map(option => option.name);
for (const name of ["companies", "company", "compare", "faction"]) {
  assert.ok(rankingCommands.includes(name), "missing /rankings " + name);
}
const alertCommands = (commandsByName.get("alerts")?.options || []).map(option => option.name);
for (const name of ["enable", "disable", "configure", "status", "settings", "recent", "acknowledge", "rules"]) {
  assert.ok(alertCommands.includes(name), "missing /alerts " + name);
}
for (const name of ["link", "link-code", "status", "unlink", "help", "ping", "bot"]) {
  assert.ok(commandsByName.has(name), "missing top-level /" + name);
}

const worker = readFileSync(new URL("./production-worker.js", import.meta.url), "utf8");
const registration = readFileSync(new URL("./register-commands.mjs", import.meta.url), "utf8");
const financials = readFileSync(new URL("./financials.mjs", import.meta.url), "utf8");
assert.match(registration, /response\.status === 429/, "Discord command registration must retry explicit rate limits");
assert.match(registration, /data\.retry_after/, "rate-limit retry must honor Discord retry_after");
assert.match(registration, /maxRateLimitRetries/, "rate-limit retry attempts must be bounded");
assert.match(worker, /const privateReply = content => \(\{ type: 4, data: \{ content, flags: 64 \} \}\)/, "account-specific slash replies must be ephemeral");
assert.match(worker, /Direct API-key entry in Discord is disabled/, "legacy API-key modal submissions must be rejected");
assert.doesNotMatch(worker, /\/api\/auth\/sign-in/, "bot must not accept a Torn API key through Discord");
assert.match(worker, /\/api\/discord\/link\/redeem/, "one-time dashboard link-code redemption must use the existing API");
assert.match(worker, /expires after five minutes/, "link instructions must disclose code expiry");
assert.match(worker, /\/api\/me\/companies\/.*\/history\?days=/, "trends must use owner-scoped saved history");
assert.match(worker, /\/api\/rankings\?scope=global&typeId=/, "global rankings must read the existing shared cache");
assert.match(financials, /advertisement_budget/, "ad budget parsing must follow dashboard field aliases");
assert.match(financials, /advertising_budget_daily/, "ad budget parsing must recognize daily advertising budget");
assert.match(financials, /daily_ad_budget/, "ad budget parsing must recognize daily ad budget");
assert.match(worker, /stockOrderExpenses\(data\.stock\)/, "profit estimates must use saved stock order data");
assert.match(worker, /knownWageSummary\(wagesData\.summary\)/, "profit estimates must require known wage coverage");
assert.match(financials, /on_order/, "stock expense must use on_order quantity");
assert.match(financials, /unitCost/, "stock expense must use recorded unit cost");
assert.doesNotMatch(financials, /in_stock\s*\*\s*(?:unitCost|row\.cost)/, "on-hand quantity must not be charged as new purchases");
assert.match(worker, /countChangeLabel\(s\.ratingChange, "star", "stars"\)/, "star-rating trend must use a count formatter");
assert.match(worker, /countChangeLabel\(s\.employeeCountChange, "employee", "employees"\)/, "employee trend must use a count formatter");
assert.doesNotMatch(worker, /On-hand inventory is not charged as a new purchase\./, "profit response must omit the removed explanatory paragraph");
assert.match(financials, /summarizeMonthToDate/, "financial helpers must calculate month-to-date totals from saved snapshots");
const profitStart = worker.indexOf('if (subcommand === "profit")');
const starsStart = worker.indexOf('if (subcommand === "stars")', profitStart);
assert.ok(profitStart >= 0 && starsStart > profitStart, "profit handler boundaries must exist");
const profitBlock = worker.slice(profitStart, starsStart);
assert.doesNotMatch(profitBlock, /\(estimated(?: from saved costs)?\)/i, "daily and weekly profit must not display estimated descriptors");
assert.doesNotMatch(profitBlock, /employee wages known|wage coverage/i, "profit output must omit employee wage coverage descriptors");
assert.match(profitBlock, /Monthly income \(month to date\)/, "profit output must include month-to-date income");
assert.match(profitBlock, /Monthly profit \(month to date\)/, "profit output must include month-to-date profit");
assert.match(profitBlock, /summarizeMonthToDate\(history\)/, "month-to-date estimates must use owner-scoped saved daily history");
assert.match(worker, /subcommand === "profit" \? "all" : days/, "profit must fetch all available history to cover the current month");
const overviewStart = worker.indexOf('if (name === "overview" || (name === "company" && commandOptions(i).subcommand === "overview"))');
const employeesStart = worker.indexOf('if (name === "employees" || (name === "company" && commandOptions(i).subcommand === "employees"))', overviewStart);
assert.ok(overviewStart >= 0 && employeesStart > overviewStart, "overview handler boundaries must exist");
assert.doesNotMatch(worker.slice(overviewStart, employeesStart), /Cost breakdown: advertising/, "company overview must omit the cost breakdown line");
assert.doesNotMatch(worker.slice(overviewStart, employeesStart), /Employee wage coverage|\(estimated\)/, "company overview must omit wage coverage and estimated descriptors");
assert.doesNotMatch(worker, /\/api\/company\/refresh/, "read commands must not trigger company refreshes");
assert.doesNotMatch(worker, /company_snapshots|GLOBAL_RANKINGS_QUEUE/, "read commands must not write snapshot or ranking-run state");
console.log("PASS Discord command contract: " + commands.length + " top-level commands; private replies, one-time linking, owner-scoped reads, and no refresh/snapshot actions.");
