import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { commands } from "./command-schema.mjs";

const rootNames = commands.map(command => command.name);
assert.equal(new Set(rootNames).size, rootNames.length, "top-level command names must be unique");

const validName = /^[a-z0-9_-]{1,32}$/;
function validateLeafOption(child, path) {
  assert.match(child.name, validName, path + " argument name");
  assert.ok(child.description.length > 0 && child.description.length <= 100, path + "/" + child.name + " argument description length");
  assert.ok(!Object.prototype.hasOwnProperty.call(child, "options"), "Discord supports only command -> group -> subcommand nesting");
  assert.ok(!Object.prototype.hasOwnProperty.call(child, "choices") || child.choices.length <= 25, "choice limit");
}
function validateCommand(command) {
  assert.match(command.name, validName, "Discord command names must use valid lowercase names");
  assert.ok(command.description.length > 0 && command.description.length <= 100, command.name + " description length");
  assert.ok(!Object.prototype.hasOwnProperty.call(command, "options") || command.options.length <= 25, command.name + " option count");
  const options = command.options || [];
  assert.equal(new Set(options.map(option => option.name)).size, options.length, command.name + " duplicate option/subcommand");
  for (const option of options) {
    assert.match(option.name, validName, command.name + " option name");
    assert.ok(option.description.length > 0 && option.description.length <= 100, command.name + "/" + option.name + " option description length");
    if (option.type === 1) {
      assert.ok(!Object.prototype.hasOwnProperty.call(option, "required"), "subcommands cannot have required flags");
      assert.ok(!Object.prototype.hasOwnProperty.call(option, "choices"), "subcommands cannot have choices");
      assert.ok(!Object.prototype.hasOwnProperty.call(option, "options") || option.options.length <= 25, command.name + "/" + option.name + " option count");
      const childOptions = option.options || [];
      assert.equal(new Set(childOptions.map(child => child.name)).size, childOptions.length, command.name + "/" + option.name + " duplicate arguments");
      for (const child of childOptions) validateLeafOption(child, command.name + "/" + option.name);
    } else if (option.type === 2) {
      assert.ok(!Object.prototype.hasOwnProperty.call(option, "required"), "groups cannot have required flags");
      assert.ok(!Object.prototype.hasOwnProperty.call(option, "choices"), "groups cannot have choices");
      assert.ok(Array.isArray(option.options) && option.options.length > 0 && option.options.length <= 25, command.name + "/" + option.name + " must have subcommands");
      const childNames = option.options.map(child => child.name);
      assert.equal(new Set(childNames).size, childNames.length, command.name + "/" + option.name + " duplicate nested subcommand");
      for (const child of option.options) {
        assert.equal(child.type, 1, "a subcommand group can contain only subcommands");
        assert.ok(child.description.length > 0 && child.description.length <= 100, command.name + "/" + option.name + "/" + child.name + " description length");
        assert.ok(!Object.prototype.hasOwnProperty.call(child, "required"), "nested subcommands cannot have required flags");
        assert.ok(!Object.prototype.hasOwnProperty.call(child, "choices"), "nested subcommands cannot have choices");
        assert.ok(!Object.prototype.hasOwnProperty.call(child, "options") || child.options.length <= 25, command.name + "/" + option.name + "/" + child.name + " option count");
        const leafOptions = child.options || [];
        assert.equal(new Set(leafOptions.map(leaf => leaf.name)).size, leafOptions.length, command.name + "/" + option.name + "/" + child.name + " duplicate arguments");
        for (const leaf of leafOptions) validateLeafOption(leaf, command.name + "/" + option.name + "/" + child.name);
      }
    } else {
      assert.ok(!Object.prototype.hasOwnProperty.call(option, "options"), "top-level parameters cannot contain nested options");
    }
  }
}
for (const command of commands) validateCommand(command);

const commandsByName = new Map(commands.map(command => [command.name, command]));
const companyOptions = commandsByName.get("company")?.options || [];
const companyCommands = companyOptions.map(option => option.name);
for (const name of ["list", "overview", "income", "profit", "stars", "ads", "stock", "employees", "wages", "alerts", "trends", "rankings"]) {
  assert.ok(companyCommands.includes(name), "missing /company " + name);
}
for (const name of ["overview", "employees", "trends", "alerts", "rankings"]) {
  assert.equal(commandsByName.has(name), false, "company command must not remain a root command: /" + name);
}
const employeesSubcommand = companyOptions.find(option => option.name === "employees");
const detailOption = (employeesSubcommand?.options || []).find(option => option.name === "detail");
assert.deepEqual((detailOption?.choices || []).map(choice => choice.value), ["brief", "full"], "/company employees must expose brief/full detail levels");

const rankingGroup = companyOptions.find(option => option.name === "rankings" && option.type === 2);
const rankingCommands = (rankingGroup?.options || []).map(option => option.name);
for (const name of ["companies", "company", "compare", "global", "faction"]) {
  assert.ok(rankingCommands.includes(name), "missing /company rankings " + name);
}
const alertGroup = companyOptions.find(option => option.name === "alerts" && option.type === 2);
const alertCommands = (alertGroup?.options || []).map(option => option.name);
for (const name of ["enable", "disable", "configure", "status", "settings", "recent", "acknowledge", "rules"]) {
  assert.ok(alertCommands.includes(name), "missing /company alerts " + name);
}
const acknowledgeCommand = (alertGroup?.options || []).find(option => option.name === "acknowledge");
const alertPicker = (acknowledgeCommand?.options || []).find(option => option.name === "alert");
assert.equal((acknowledgeCommand?.options || []).some(option => option.name === "event_id"), false, "technical event IDs must not be exposed as the user-facing option");
assert.equal(alertPicker?.autocomplete, true, "alert acknowledgement must use Discord autocomplete instead of requiring a pasted event ID");
const dashboardCommand = commandsByName.get("dashboard");
assert.ok(dashboardCommand, "missing top-level /dashboard command");
assert.deepEqual((dashboardCommand.options || []).map(option => option.name), ["health", "summary"], "/dashboard should expose health and summary subcommands");
for (const name of ["link", "link-code", "status", "unlink", "help", "ping", "bot"]) {
  assert.ok(commandsByName.has(name), "missing top-level /" + name);
}

const worker = readFileSync(new URL("./production-worker.js", import.meta.url), "utf8");
const registration = readFileSync(new URL("./register-commands.mjs", import.meta.url), "utf8");
const financials = readFileSync(new URL("./financials.mjs", import.meta.url), "utf8");
assert.match(registration, /response\.status === 429/, "Discord command registration must retry explicit rate limits");
assert.match(registration, /data\.retry_after/, "rate-limit retry must honor Discord retry_after");
assert.match(registration, /maxRateLimitRetries/, "rate-limit retry attempts must be bounded");
assert.match(registration, /DEPRECATED_ROOT_ALIASES/, "registration must identify retired root aliases");
assert.match(registration, /"alerts", "rankings"/, "registration must retire former standalone company alert and ranking roots");
assert.match(registration, /await request\(base \+ "\/" \+ stale\.id, "DELETE"\)/, "registration must remove retired root aliases from Discord");
assert.match(worker, /const privateReply = content => \(\{ type: 4, data: \{ content, flags: 64 \} \}\)/, "account-specific slash replies must be ephemeral");
assert.match(worker, /if \(i\.type === 4\)/, "alert acknowledgement must support Discord autocomplete interactions");
assert.match(worker, /interaction\?\.type === 4\) return json\(\{ type: 8, data: \{ choices: \[\] \} \}\)/, "failed autocomplete requests must return a valid empty choices response");
assert.match(worker, /type: 8, data: \{ choices \}/, "autocomplete must return a selector to Discord");
assert.match(worker, /String\(event\.status \|\| ""\)\.toLowerCase\(\) === "unread"/, "the alert selector must exclude acknowledged events");
assert.match(worker, /Use \/company alerts acknowledge and select an active alert from the autocomplete suggestions/, "recent alerts must explain selection-based acknowledgement");
assert.doesNotMatch(worker, /\| Event ID:/, "recent alert output must not expose long event IDs");
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
assert.doesNotMatch(worker, /name === "(?:overview|employees|trends|alerts|rankings)"/, "retired aliases must not have standalone handler routes");
assert.match(worker, /route\.type === 2/, "command parser must support nested subcommand groups");
assert.match(worker, /name === "dashboard" && \["health", "summary"\]\.includes\(commandOptions\(i\)\.subcommand\)/, "dashboard commands must route to their shared handler");
assert.match(worker, /\/api\/me\/health/, "dashboard health must use the owner-scoped health endpoint");
assert.match(worker, /\/api\/me\/alerts\?limit=10/, "dashboard summary must include recent alert status");
assert.match(worker, /name === "company" && commandOptions\(i\)\.group === "alerts"/, "alerts must route through /company alerts group");
assert.match(worker, /name === "company" && commandOptions\(i\)\.group === "rankings"/, "rankings must route through /company rankings group");
const overviewStart = worker.indexOf('if (name === "company" && commandOptions(i).subcommand === "overview")');
const employeesStart = worker.indexOf('if (name === "company" && commandOptions(i).subcommand === "employees")', overviewStart);
assert.ok(overviewStart >= 0 && employeesStart > overviewStart, "overview handler boundaries must exist");
assert.doesNotMatch(worker.slice(overviewStart, employeesStart), /Cost breakdown: advertising/, "company overview must omit the cost breakdown line");
assert.doesNotMatch(worker.slice(overviewStart, employeesStart), /Employee wage coverage|\(estimated\)/, "company overview must omit wage coverage and estimated descriptors");
assert.doesNotMatch(worker, /\/api\/company\/refresh/, "read commands must not trigger company refreshes");
assert.doesNotMatch(worker, /company_snapshots|GLOBAL_RANKINGS_QUEUE/, "read commands must not write snapshot or ranking-run state");
console.log("PASS Discord command contract: " + commands.length + " top-level commands; private replies, one-time linking, owner-scoped reads, and no refresh/snapshot actions.");
