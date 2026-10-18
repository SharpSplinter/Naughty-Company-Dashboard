import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { commands } from "./command-schema.mjs";
import { parseCommandRoute } from "./command-routing.mjs";

const rootNames = commands.map(command => command.name);
assert.equal(new Set(rootNames).size, rootNames.length, "top-level command names must be unique");
assert.deepEqual(rootNames, ["link", "link-code", "status", "unlink", "ping", "help", "bot", "dashboard", "automation", "company"],
  "registered root commands must match the intended architecture, with /help retained");

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

const parsedRootRoute = parseCommandRoute({ data: { name: "ping" } });
assert.deepEqual(parsedRootRoute, { group: null, subcommand: null, options: [] }, "flat root commands must remain root routes");
const parsedCompanyList = parseCommandRoute({ data: { name: "company", options: [
  { type: 1, name: "list" }
] } });
assert.deepEqual(parsedCompanyList, { group: null, subcommand: "list", options: [] }, "/company list must parse as a direct subcommand");
const parsedCompanyGlobal = parseCommandRoute({ data: { name: "company", options: [
  { type: 2, name: "rankings", options: [
    { type: 1, name: "global", options: [] }
  ] }
] } });
assert.deepEqual(parsedCompanyGlobal, { group: "rankings", subcommand: "global", options: [] },
  "/company rankings global must parse group type 2 then subcommand type 1");
const parsedAutomationRetry = parseCommandRoute({ data: { name: "automation", options: [
  { type: 2, name: "webhook", options: [
    { type: 1, name: "retry", options: [{ type: 3, name: "delivery", value: "delivery-id" }] }
  ] }
] } });
assert.deepEqual(parsedAutomationRetry, { group: "webhook", subcommand: "retry", options: [{ type: 3, name: "delivery", value: "delivery-id" }] },
  "/automation webhook retry must preserve leaf arguments");


const commandsByName = new Map(commands.map(command => [command.name, command]));
const botOwnedRoots = new Set(rootNames);
assert.equal(botOwnedRoots.size, 10, "the schema must expose ten intended roots, including /help");
const directCompanySubcommands = ["list", "overview", "income", "profit", "stars", "ads", "stock", "employees", "wages", "trends"];
const companyRoot = commandsByName.get("company");
for (const name of directCompanySubcommands) {
  assert.equal((companyRoot?.options || []).find(option => option.name === name)?.type, 1, "/company " + name + " must be a direct subcommand (type 1)");
}
for (const name of ["alerts", "rankings"]) {
  assert.equal((companyRoot?.options || []).find(option => option.name === name)?.type, 2, "/company " + name + " must be a subcommand group (type 2)");
}
const companyOptions = commandsByName.get("company")?.options || [];
const companyCommands = companyOptions.map(option => option.name);
assert.deepEqual(companyCommands, ["list", "overview", "income", "profit", "stars", "ads", "stock", "employees", "wages", "trends", "alerts", "rankings"],
  "company subcommand and group order must match the requested tree");
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
assert.deepEqual(rankingCommands, ["companies", "company", "compare", "global", "faction"],
  "company rankings children must match the requested order");
for (const name of ["companies", "company", "compare", "global", "faction"]) {
  assert.ok(rankingCommands.includes(name), "missing /company rankings " + name);
}
const alertGroup = companyOptions.find(option => option.name === "alerts" && option.type === 2);
const alertCommands = (alertGroup?.options || []).map(option => option.name);
assert.deepEqual(alertCommands, ["recent", "enable", "disable", "configure", "status", "settings", "acknowledge", "rules"],
  "company alerts children must match the requested order");
for (const name of ["enable", "disable", "configure", "status", "settings", "recent", "acknowledge", "rules"]) {
  assert.ok(alertCommands.includes(name), "missing /company alerts " + name);
}
const acknowledgeCommand = (alertGroup?.options || []).find(option => option.name === "acknowledge");
const alertPicker = (acknowledgeCommand?.options || []).find(option => option.name === "alert");
assert.equal((acknowledgeCommand?.options || []).some(option => option.name === "event_id"), false, "technical event IDs must not be exposed as the user-facing option");
assert.equal(alertPicker?.autocomplete, true, "alert acknowledgement must use Discord autocomplete instead of requiring a pasted event ID");

const automationCommand = commandsByName.get("automation");
assert.ok(automationCommand, "missing top-level /automation command");
const automationGroups = new Map((automationCommand.options || []).map(option => [option.name, option]));
assert.deepEqual([...automationGroups.keys()], ["rules", "notifications", "webhook"], "/automation should expose rules, notifications, and webhook groups");
const automationRules = new Map((automationGroups.get("rules")?.options || []).map(option => [option.name, option]));
assert.deepEqual([...automationRules.keys()], ["list", "create", "enable", "disable", "delete"], "/automation rules actions must be available");
const createRuleOptions = automationRules.get("create")?.options || [];
assert.deepEqual((createRuleOptions.find(option => option.name === "rule_type")?.choices || []).map(choice => choice.value),
  ["income_drop", "stale_data", "refresh_failure", "income_increase", "rating_drop", "roster_change"], "rule creation must expose supported backend rule types");
assert.equal(createRuleOptions.find(option => option.name === "company")?.autocomplete, true, "rule creation company selection must use autocomplete");
for (const action of ["enable", "disable", "delete"]) {
  assert.equal(automationRules.get(action)?.options?.find(option => option.name === "rule")?.autocomplete, true, action + " must use a friendly rule selector");
}
const automationNotifications = new Map((automationGroups.get("notifications")?.options || []).map(option => [option.name, option]));
assert.deepEqual([...automationNotifications.keys()], ["status", "configure"], "/automation notifications must expose status and configure");
const notificationOptions = automationNotifications.get("configure")?.options || [];
assert.ok(notificationOptions.some(option => option.name === "quiet_hours_enabled" && option.type === 5), "notifications configure must support quiet-hours toggle");
assert.deepEqual((notificationOptions.find(option => option.name === "digest_mode")?.choices || []).map(choice => choice.value), ["instant", "daily", "both", "off"], "notifications configure must expose supported webhook digest modes");
const automationWebhook = new Map((automationGroups.get("webhook")?.options || []).map(option => [option.name, option]));
assert.deepEqual([...automationWebhook.keys()], ["status", "deliveries", "retry", "delete"], "/automation webhook must expose status, deliveries, retry, and delete in the requested order");
assert.equal(automationWebhook.get("retry")?.options?.find(option => option.name === "delivery")?.autocomplete, true, "webhook retry must use an autocomplete selector rather than an event ID");

const dashboardCommand = commandsByName.get("dashboard");
assert.ok(dashboardCommand, "missing top-level /dashboard command");
assert.deepEqual((dashboardCommand.options || []).map(option => option.name), ["health", "summary"], "/dashboard should expose health and summary subcommands");
for (const name of ["link", "link-code", "status", "unlink", "help", "ping", "bot"]) {
  assert.ok(commandsByName.has(name), "missing top-level /" + name);
}

const worker = readFileSync(new URL("./production-worker.js", import.meta.url), "utf8");
const registration = readFileSync(new URL("./register-commands.mjs", import.meta.url), "utf8");
const financials = readFileSync(new URL("./financials.mjs", import.meta.url), "utf8");
assert.match(worker, /method: "DELETE", headers, signal: AbortSignal.timeout\(8000\)/, "webhook delete must use the authenticated delete endpoint");
assert.match(worker, /JSON.stringify\(\{ digestMode: "off" \}\)/, "webhook delete must turn off external webhook digests");
assert.match(worker, /External webhook delivery is separate from private Discord DMs/, "notification status must distinguish external webhook delivery from private Discord DMs");
assert.match(registration, /response\.status === 429/, "Discord command registration must retry explicit rate limits");
assert.match(registration, /data\.retry_after/, "rate-limit retry must honor Discord retry_after");
assert.match(registration, /maxRateLimitRetries/, "rate-limit retry attempts must be bounded");
assert.match(registration, /DEPRECATED_ROOT_ALIASES/, "registration must identify retired root aliases");
assert.match(registration, /"alerts", "rankings"/, "registration must retire former standalone company alert and ranking roots");
assert.match(registration, /LEGACY_FLAT_ROOT_ALIASES/, "registration must remove obsolete flattened nested-command roots");
assert.match(registration, /function isLegacyFlatRootName/, "registration must catch legacy hyphenated or underscored root aliases");
assert.match(registration, /function optionTreeShape/, "registration must normalize Discord option trees for structural verification");
assert.match(registration, /registeredAfterSync = await request\(base, "GET"\)/, "registration must read back the live command tree");
assert.match(registration, /Verified nested command trees for all/, "registration must report successful structural verification");
assert.match(registration, /automation-webhook-delete/, "registration must clean up flattened automation webhook aliases");
assert.match(registration, /company-rankings-global/, "registration must clean up flattened company ranking aliases");
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
assert.match(worker, /parseCommandRoute\(interaction\)/, "Worker must use the explicit nested interaction parser");
assert.match(worker, /name === "dashboard" && \["health", "summary"\]\.includes\(commandOptions\(i\)\.subcommand\)/, "dashboard commands must route to their shared handler");
assert.match(worker, /\/dashboard health\|summary/, "help must document the dashboard command family");
assert.match(worker, /helpLines\.join\("\\n"\)/, "help must join sections with real newline characters");
assert.match(worker, /\/api\/me\/health/, "dashboard health must use the owner-scoped health endpoint");
assert.match(worker, /\/api\/me\/alerts\?limit=10/, "dashboard summary must include recent alert status");
const dashboardSummaryStart = worker.indexOf('const latestRun = alertData.latestRun && typeof alertData.latestRun === "object" ? alertData.latestRun : {};', worker.indexOf('if (name === "dashboard" && ["health", "summary"].includes(commandOptions(i).subcommand))'));
const dashboardSummaryEnd = worker.indexOf('return chunkedPrivateReply("**Dashboard executive summary**", lines);', dashboardSummaryStart);
assert.ok(dashboardSummaryStart >= 0 && dashboardSummaryEnd > dashboardSummaryStart, "dashboard summary output block must exist");
const dashboardSummaryBlock = worker.slice(dashboardSummaryStart, dashboardSummaryEnd);
assert.match(dashboardSummaryBlock, /Latest scheduled run \(all dashboard users\):/, "dashboard summary must label the latest scheduled run as global");
assert.match(dashboardSummaryBlock, /Run results \(all dashboard users\):/, "dashboard summary must label scheduled-run outcomes as global");
assert.match(dashboardSummaryBlock, /Unread dashboard alerts \(your account\):/, "dashboard summary must label unread alerts as account-scoped");
assert.match(dashboardSummaryBlock, /Snapshot coverage \(your account\):/, "dashboard summary must label snapshot coverage as account-scoped");
assert.match(dashboardSummaryBlock, /Needs attention \(your companies\):/, "dashboard summary must label stale companies as account-scoped");
assert.doesNotMatch(dashboardSummaryBlock, /Dashboard Worker:|Database:|Latest saved snapshot:|latency\(/, "dashboard summary must leave system diagnostics to /dashboard health");
assert.match(dashboardSummaryBlock, /timeZone: "UTC"/, "scheduled-run time must be compact and explicitly UTC");


assert.match(worker, /name === "automation" && \["rules", "notifications", "webhook"\]\.includes\(commandOptions\(i\)\.group\)/, "automation command group must route to its private handler");
assert.match(worker, /\/api\/me\/alert-rules/, "automation rules must use the existing owner-scoped API");
assert.match(worker, /\/api\/me\/automation-preferences/, "notification settings must use the existing preferences API");
assert.match(worker, /\/api\/me\/automation-webhook\/deliveries\?limit=10/, "webhook delivery history must use the existing API");
assert.match(worker, /\/api\/me\/automation-webhook\/retry\//, "webhook retry must use the owner-scoped retry API");
assert.match(worker, /route\.group === "rules" && \["enable", "disable", "delete"\]\.includes\(route\.subcommand\)/, "automation rule actions must support autocomplete selection");
assert.match(worker, /route\.group === "webhook" && route\.subcommand === "retry"/, "webhook retry must support failed-delivery autocomplete");
assert.match(worker, /The encrypted endpoint URL is never shown in Discord/, "webhook status must never disclose the encrypted endpoint URL");
assert.match(worker, /name === "automation"/, "help and command handler must recognize automation");

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
