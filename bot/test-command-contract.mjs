import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { commands } from "./command-schema.mjs";
import { parseCommandRoute } from "./command-routing.mjs";
import { commandSchemaDifferences } from "./command-schema-contract.mjs";

const rootNames = commands.map(command => command.name);
assert.equal(new Set(rootNames).size, rootNames.length, "top-level command names must be unique");
assert.deepEqual(rootNames, ["link", "link-code", "status", "unlink", "ping", "help", "bot", "dashboard", "automation", "company"],
  "registered root commands must match the intended architecture, with /help retained");

const validName = /^[a-z0-9_-]{1,32}$/;
const parameterTypes = new Set([3, 4, 5, 6, 7, 8, 9, 10, 11]);
const choiceTypes = new Set([3, 4, 10]);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function validateHeader(value, path) {
  assert.match(value.name, validName, path + " name");
  assert.ok(typeof value.description === "string" && value.description.length > 0 && value.description.length <= 100,
    path + " description length");
}
function validateLeafOption(child, path) {
  assert.ok(parameterTypes.has(child.type), path + "/" + child.name + " must use a supported parameter type");
  validateHeader(child, path + " argument");
  assert.ok(!hasOwn(child, "options"), "Discord supports only command -> group -> subcommand nesting");
  if (hasOwn(child, "required")) assert.equal(typeof child.required, "boolean", path + "/" + child.name + " required must be boolean");

  if (hasOwn(child, "choices")) {
    assert.ok(choiceTypes.has(child.type), path + "/" + child.name + " choices only support string, integer, and number options");
    assert.ok(Array.isArray(child.choices) && child.choices.length <= 25, path + "/" + child.name + " choice limit is 25");
    for (const choice of child.choices) {
      assert.ok(choice && typeof choice.name === "string" && choice.name.length >= 1 && choice.name.length <= 100,
        path + "/" + child.name + " choice names must be 1-100 characters");
      if (child.type === 3) {
        assert.ok(typeof choice.value === "string" && choice.value.length <= 100,
          path + "/" + child.name + " string choice values must be at most 100 characters");
      } else if (child.type === 4) {
        assert.ok(Number.isSafeInteger(choice.value), path + "/" + child.name + " integer choice values must be safe integers");
      } else {
        assert.ok(typeof choice.value === "number" && Number.isFinite(choice.value) && Math.abs(choice.value) <= 2 ** 53,
          path + "/" + child.name + " number choice values must be finite and within Discord's supported range");
      }
    }
  }
  if (hasOwn(child, "autocomplete")) {
    assert.equal(typeof child.autocomplete, "boolean", path + "/" + child.name + " autocomplete must be boolean");
  }
  if (child.autocomplete === true) {
    assert.ok(choiceTypes.has(child.type), path + "/" + child.name + " autocomplete only supports string, integer, and number options");
    assert.ok(!hasOwn(child, "choices"), path + "/" + child.name + " autocomplete cannot be combined with choices");
  }

  for (const field of ["min_length", "max_length"]) {
    if (!hasOwn(child, field)) continue;
    assert.equal(child.type, 3, path + "/" + child.name + " " + field + " only applies to string options");
    const value = child[field];
    const min = field === "min_length" ? 0 : 1;
    assert.ok(Number.isInteger(value) && value >= min && value <= 6000,
      path + "/" + child.name + " " + field + " must be in the allowed range");
  }
  if (hasOwn(child, "min_length") && hasOwn(child, "max_length")) {
    assert.ok(child.min_length <= child.max_length, path + "/" + child.name + " min_length must not exceed max_length");
  }

  for (const field of ["min_value", "max_value"]) {
    if (!hasOwn(child, field)) continue;
    assert.ok(child.type === 4 || child.type === 10, path + "/" + child.name + " " + field + " only applies to numeric options");
    const value = child[field];
    if (child.type === 4) {
      assert.ok(Number.isSafeInteger(value), path + "/" + child.name + " integer " + field + " must be a safe integer");
    } else {
      assert.ok(typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 2 ** 53,
        path + "/" + child.name + " number " + field + " must be finite and within Discord's supported range");
    }
  }
  if (hasOwn(child, "min_value") && hasOwn(child, "max_value")) {
    assert.ok(child.min_value <= child.max_value, path + "/" + child.name + " min_value must not exceed max_value");
  }
}
function validateLeafOptions(options, path) {
  assert.ok(Array.isArray(options) && options.length <= 25, path + " option count must not exceed 25");
  assert.equal(new Set(options.map(option => option.name)).size, options.length, path + " duplicate argument names");
  let optionalSeen = false;
  for (const option of options) {
    if (option.required === true) {
      assert.ok(!optionalSeen, path + ": required options must precede optional options");
    } else {
      optionalSeen = true;
    }
    validateLeafOption(option, path);
  }
}
function validateParentOption(option, path) {
  validateHeader(option, path);
  for (const field of ["required", "choices", "autocomplete", "min_value", "max_value", "min_length", "max_length", "channel_types", "file_types"]) {
    assert.ok(!hasOwn(option, field), path + " cannot define parameter field " + field);
  }
}
function validateCommand(command) {
  validateHeader(command, "Discord command");
  if (hasOwn(command, "options")) {
    assert.ok(Array.isArray(command.options), command.name + " options must be an array");
    assert.ok(command.options.length <= 25, command.name + " option count must not exceed 25");
  }
  const options = command.options || [];
  assert.equal(new Set(options.map(option => option.name)).size, options.length, command.name + " duplicate option/subcommand");
  const hasNestedRoutes = options.some(option => option && (option.type === 1 || option.type === 2));
  if (!hasNestedRoutes) {
    validateLeafOptions(options, command.name);
    return;
  }
  assert.ok(options.every(option => option && (option.type === 1 || option.type === 2)),
    command.name + " must not mix subcommands/groups with parameter options");

  for (const option of options) {
    const optionPath = command.name + "/" + option.name;
    assert.ok(option.type === 1 || option.type === 2, optionPath + " must be a subcommand or group");
    validateParentOption(option, optionPath);
    if (option.type === 1) {
      const childOptions = hasOwn(option, "options") ? option.options : [];
      assert.ok(Array.isArray(childOptions) && childOptions.length <= 25, optionPath + " option count must not exceed 25");
      validateLeafOptions(childOptions, optionPath);
      continue;
    }

    const groupChildren = option.options;
    assert.ok(Array.isArray(groupChildren) && groupChildren.length > 0 && groupChildren.length <= 25,
      optionPath + " must have 1-25 subcommands");
    assert.equal(new Set(groupChildren.map(child => child.name)).size, groupChildren.length, optionPath + " duplicate nested subcommand");
    for (const child of groupChildren) {
      const childPath = optionPath + "/" + child.name;
      assert.equal(child.type, 1, childPath + " a group can contain only subcommands");
      validateParentOption(child, childPath);
      const leafOptions = hasOwn(child, "options") ? child.options : [];
      assert.ok(Array.isArray(leafOptions) && leafOptions.length <= 25, childPath + " option count must not exceed 25");
      validateLeafOptions(leafOptions, childPath);
    }
  }
}
for (const command of commands) validateCommand(command);

// Validator boundary fixtures protect against Discord rejecting a future schema change.
const testOption = (name, required, extras = {}) => ({
  type: 3, name, description: "A test option", required, ...extras
});
const testCommand = options => ({ name: "schema-test", description: "Validate an option schema", options });
assert.doesNotThrow(() => validateCommand(testCommand([
  testOption("required", true), testOption("optional", false)
])), "required parameters before optional parameters should pass");
assert.throws(() => validateCommand(testCommand([
  testOption("optional", false), testOption("required", true)
])), /required options must precede optional options/, "required parameters after optional parameters must fail");
assert.throws(() => validateCommand(testCommand([
  { type: 1, name: "run", description: "Run the command" }, testOption("query", false)
])), /must not mix subcommands\/groups with parameter options/, "subcommands cannot be mixed with leaf parameters");
assert.throws(() => validateCommand(testCommand([
  testOption("selector", false, { choices: [{ name: "First", value: "first" }], autocomplete: true })
])), /autocomplete cannot be combined with choices/, "autocomplete and static choices are mutually exclusive");
assert.throws(() => validateCommand(testCommand([
  testOption("selector", false, { choices: Array.from({ length: 26 }, (_, index) => ({ name: "Choice " + index, value: "choice-" + index })) })
])), /choice limit is 25/, "Discord's 25-choice cap must be enforced");
assert.throws(() => validateCommand(testCommand([
  { type: 4, name: "page", description: "Page index", required: false, min_value: 10, max_value: 1 }
])), /min_value must not exceed max_value/, "numeric minimum cannot exceed maximum");
assert.throws(() => validateCommand(testCommand([
  { type: 3, name: "query", description: "Query", required: false, min_value: 1 }
])), /min_value only applies to numeric options/, "numeric bounds cannot be attached to strings");
assert.throws(() => validateCommand(testCommand([
  { type: 1, name: "outer", description: "Outer", options: [{ type: 2, name: "inner", description: "Invalid extra nesting", options: [
    { type: 1, name: "run", description: "Run" }
  ] }] }
])), /must not mix subcommands\/groups with parameter options|supported parameter type/,
  "Discord's command -> group -> subcommand nesting depth must be enforced");

const equivalentDefaults = { name: "defaults", description: "Default normalization", options: [
  { type: 3, name: "query", description: "Query", required: false }
] };
const omittedDefaults = { name: "defaults", description: "Default normalization", type: 1, options: [
  { type: 3, name: "query", description: "Query" }
] };
assert.deepEqual(commandSchemaDifferences(equivalentDefaults, omittedDefaults), [],
  "schema comparison must normalize omitted Discord defaults");

const canonicalCompany = commands.find(command => command.name === "company");
assert.deepEqual(commandSchemaDifferences(canonicalCompany, structuredClone(canonicalCompany)), [],
  "a live schema identical to the canonical definition must match");
const driftedCompany = structuredClone(canonicalCompany);
driftedCompany.description += " (drift)";
driftedCompany.options.find(option => option.name === "rankings").description = "Different rankings description";
driftedCompany.options.find(option => option.name === "rankings").options
  .find(option => option.name === "companies").options[0].required = false;
driftedCompany.options.find(option => option.name === "trends").options
  .find(option => option.name === "metric").choices[0].value = "changed-value";
driftedCompany.options.find(option => option.name === "alerts").options
  .find(option => option.name === "acknowledge").options[0].autocomplete = false;
const schemaDifferences = commandSchemaDifferences(canonicalCompany, driftedCompany);
assert.ok(schemaDifferences.includes("/company.description"), "live schema comparison must catch root description drift");
assert.ok(schemaDifferences.some(path => path.endsWith(".description")), "live schema comparison must catch option description drift");
assert.ok(schemaDifferences.some(path => path.endsWith(".required")), "live schema comparison must catch required-flag drift");
assert.ok(schemaDifferences.some(path => path.endsWith(".choices[0].value")), "live schema comparison must catch choice-value drift");
assert.ok(schemaDifferences.some(path => path.endsWith(".autocomplete")), "live schema comparison must catch autocomplete drift");
assert.ok(schemaDifferences.some(path => path.endsWith(".min_value")), "live schema comparison must catch numeric-bound drift");
const driftedAutomation = structuredClone(commands.find(command => command.name === "automation"));
driftedAutomation.options.find(option => option.name === "webhook").options
  .find(option => option.name === "retry").options[0].max_length = 79;
assert.ok(commandSchemaDifferences(commands.find(command => command.name === "automation"), driftedAutomation)
  .some(path => path.endsWith(".max_length")), "live schema comparison must catch string-bound drift");


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
const rankingCommandByName = new Map((rankingGroup?.options || []).map(option => [option.name, option]));
assert.match(rankingCommandByName.get("company")?.description || "", /rank, stars, and income/i,
  "/company rankings company should show a focused company ranking summary");
assert.match(rankingCommandByName.get("compare")?.description || "", /nearby same-type ranks and star-income benchmarks/i,
  "/company rankings compare should focus on nearby competitors and benchmarks");
assert.match(rankingCommandByName.get("global")?.description || "", /top 10 companies/i,
  "/company rankings global should show a type leaderboard rather than duplicate the company summary");
const alertGroup = companyOptions.find(option => option.name === "alerts" && option.type === 2);
const alertCommands = (alertGroup?.options || []).map(option => option.name);
assert.deepEqual(alertCommands, ["recent", "enable", "disable", "status", "acknowledge"],
  "company alerts should only expose alert-event and private Discord delivery actions");
for (const name of ["recent", "enable", "disable", "status", "acknowledge"]) {
  assert.ok(alertCommands.includes(name), "missing /company alerts " + name);
}
for (const duplicate of ["configure", "settings", "rules"]) {
  assert.equal(alertCommands.includes(duplicate), false, "/company alerts must not duplicate /automation " + duplicate);
}
const acknowledgeCommand = (alertGroup?.options || []).find(option => option.name === "acknowledge");
const alertPicker = (acknowledgeCommand?.options || []).find(option => option.name === "alert");
assert.equal((acknowledgeCommand?.options || []).some(option => option.name === "event_id"), false, "technical event IDs must not be exposed as the user-facing option");
assert.equal(alertPicker?.autocomplete, true, "alert acknowledgement must use Discord autocomplete instead of requiring a pasted event ID");

const automationCommand = commandsByName.get("automation");
assert.ok(automationCommand, "missing top-level /automation command");
const automationGroups = new Map((automationCommand.options || []).map(option => [option.name, option]));
assert.deepEqual([...automationGroups.keys()], ["notifications", "webhook"], "/automation should expose only notification status and webhook operations");
assert.equal(automationGroups.has("rules"), false, "alert-rule management must remain dashboard-only");
const automationNotifications = new Map((automationGroups.get("notifications")?.options || []).map(option => [option.name, option]));
assert.deepEqual([...automationNotifications.keys()], ["status"], "/automation notifications must retain status only; editing preferences belongs in the dashboard");
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
assert.match(worker, /Edit alert rules and notification preferences in the dashboard/, "Discord must direct rule and notification preference edits to the dashboard");
assert.match(registration, /response\.status === 429/, "Discord command registration must retry explicit rate limits");
assert.match(registration, /data\.retry_after/, "rate-limit retry must honor Discord retry_after");
assert.match(registration, /maxRateLimitRetries/, "rate-limit retry attempts must be bounded");
assert.match(registration, /DEPRECATED_ROOT_ALIASES/, "registration must identify retired root aliases");
assert.match(registration, /"alerts", "rankings"/, "registration must retire former standalone company alert and ranking roots");
assert.match(registration, /LEGACY_FLAT_ROOT_ALIASES/, "registration must remove obsolete flattened nested-command roots");
assert.match(registration, /function isLegacyFlatRootName/, "registration must catch legacy hyphenated or underscored root aliases");
assert.match(registration, /commandSchemaDifferences\(command, registeredCommand\)/, "registration must compare the complete canonical schema with the live Discord schema");
assert.match(registration, /schema differs:/, "registration failures must identify live schema drift");
assert.match(registration, /command-schema-contract\.mjs/, "registration must use the shared schema normalization contract");
assert.match(registration, /registeredAfterSync = await request\(base, "GET"\)/, "registration must read back the live command tree");
assert.match(registration, /Verified nested command trees for all/, "registration must report successful structural verification");
assert.match(registration, /automation-webhook-delete/, "registration must clean up flattened automation webhook aliases");
assert.match(registration, /company-rankings-global/, "registration must clean up flattened company ranking aliases");
assert.match(registration, /await request\(base \+ "\/" \+ stale\.id, "DELETE"\)/, "registration must remove retired root aliases from Discord");
assert.match(worker, /const privateReply = content => \(\{ type: 4, data: \{ content, flags: 64, allowed_mentions: \{ parse: \[\] \} \} \}\)/, "account-specific slash replies must be ephemeral and suppress mentions");
assert.match(worker, /ctx\.waitUntil\(completeDeferredInteraction\(interaction, env\)\)/, "slow command work must run after immediate acknowledgement");
assert.match(worker, /return json\(\{ type: 5, data: \{ flags: 64 \} \}\)/, "slow account-specific commands must defer privately");
assert.match(worker, /messages\/\@original/, "deferred responses must edit the original interaction reply");
assert.match(worker, /AbortSignal\.timeout\(1200\)/, "autocomplete dashboard calls must leave margin within the three-second response deadline");
assert.match(worker, /if \(i\.type === 4\)/, "alert acknowledgement must support Discord autocomplete interactions");
assert.match(worker, /timeoutReply = new Promise\(resolve => \{\s*timeoutHandle = setTimeout\(\(\) => resolve\(\{ type: 8, data: \{ choices: \[\] \} \}\), 1800\)/, "slow autocomplete must fall back before the three-second deadline");
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
assert.match(worker, /\/dashboard health/, "help must document /dashboard health");
assert.match(worker, /\/dashboard summary/, "help must document /dashboard summary");
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


assert.equal(worker.includes('if (name === "automation" && ["notifications", "webhook"].includes(commandOptions(i).group))'), true, "automation must route only notification status and webhook operations");
assert.equal(worker.includes("/api/me/alert-rules"), false, "Discord must not expose alert-rule CRUD; the dashboard owns rule management");
assert.match(worker, /\/api\/me\/automation-preferences/, "notification settings must use the existing preferences API");
assert.match(worker, /\/api\/me\/automation-webhook\/deliveries\?limit=10/, "webhook delivery history must use the existing API");
assert.match(worker, /\/api\/me\/automation-webhook\/retry\//, "webhook retry must use the owner-scoped retry API");
assert.equal(worker.includes('route.group === "rules"'), false, "Discord must not expose alert-rule autocomplete");
assert.match(worker, /route\.group === "webhook" && route\.subcommand === "retry"/, "webhook retry must support failed-delivery autocomplete");
const webhookStatusStart = worker.indexOf('if (subcommand === "status") {', worker.indexOf('if (groupName === "webhook") {'));
const webhookDeliveriesStart = worker.indexOf('if (subcommand === "deliveries")', webhookStatusStart);
assert.ok(webhookStatusStart >= 0 && webhookDeliveriesStart > webhookStatusStart, "webhook status output block must exist");
const webhookStatusBlock = worker.slice(webhookStatusStart, webhookDeliveriesStart);
assert.match(webhookStatusBlock, /External webhook status/ , "webhook status title must exist");
assert.match(webhookStatusBlock, /lines\.join/, "webhook status must format its fields as separate lines");
assert.doesNotMatch(webhookStatusBlock, /This is separate from private Discord DMs|Use \/automation webhook delete/, "webhook status must omit unnecessary explanatory text");
assert.match(worker, /name === "automation"/, "help and command handler must recognize automation");

assert.match(worker, /name === "company" && commandOptions\(i\)\.group === "alerts"/, "alerts must route through /company alerts group");
const companyAlertsStart = worker.indexOf('if (name === "company" && commandOptions(i).group === "alerts")');
const automationHandlerStart = worker.indexOf('if (name === "automation"', companyAlertsStart);
assert.ok(companyAlertsStart >= 0 && automationHandlerStart > companyAlertsStart, "company alert and automation handlers must exist");
const companyAlertsBlock = worker.slice(companyAlertsStart, automationHandlerStart);
assert.doesNotMatch(companyAlertsBlock, /subcommand === "rules"|subcommand === "configure"|subcommand === "settings"/,
  "company alerts must not expose duplicated rule or notification-preference actions");
assert.doesNotMatch(companyAlertsBlock, /\/api\/me\/alert-rules|\/api\/me\/automation-preferences/,
"dashboard-managed rule and notification settings must not be handled by /company alerts");
assert.match(companyAlertsBlock, /Most recent private delivery:/, "company alert status must retain private DM delivery health");
const automationNotificationsStart = worker.indexOf('if (groupName === "notifications")');
const automationWebhookStart = worker.indexOf('if (groupName === "webhook")', automationNotificationsStart);
assert.ok(automationNotificationsStart >= 0 && automationWebhookStart > automationNotificationsStart, "automation notification handler must exist");
const automationNotificationsBlock = worker.slice(automationNotificationsStart, automationWebhookStart);
assert.equal(automationNotificationsBlock.includes("/api/me/discord-link"), false,
  "automation notification status must not fetch private Discord DM link status");
assert.equal(automationNotificationsBlock.includes("Private Discord DMs:"), false,
  "automation notification status must not duplicate private Discord DM enablement status");
assert.equal(automationNotificationsBlock.includes('optionValue(i, "minimum_severity")'), false, "Discord must not expose notification preference edits");
assert.equal(automationNotificationsBlock.includes('method: "POST"'), false, "Discord notification status must remain read-only");
assert.match(automationNotificationsBlock, /Your automation notification preferences/,
  "automation status must focus on notification preferences and webhook configuration");

assert.match(worker, /name === "company" && commandOptions\(i\)\.group === "rankings"/, "rankings must route through /company rankings group");
const overviewStart = worker.indexOf('if (name === "company" && commandOptions(i).subcommand === "overview")');
const employeesStart = worker.indexOf('if (name === "company" && commandOptions(i).subcommand === "employees")', overviewStart);
assert.ok(overviewStart >= 0 && employeesStart > overviewStart, "overview handler boundaries must exist");
assert.doesNotMatch(worker.slice(overviewStart, employeesStart), /Cost breakdown: advertising/, "company overview must omit the cost breakdown line");
assert.doesNotMatch(worker.slice(overviewStart, employeesStart), /Employee wage coverage|\(estimated\)/, "company overview must omit wage coverage and estimated descriptors");
assert.doesNotMatch(worker, /\/api\/company\/refresh/, "read commands must not trigger company refreshes");
assert.doesNotMatch(worker, /company_snapshots|GLOBAL_RANKINGS_QUEUE/, "read commands must not write snapshot or ranking-run state");
const adsBlockStart = worker.indexOf('if (subcommand === "ads") {');
const stockBlockStart = worker.indexOf('if (subcommand === "stock") {', adsBlockStart);
assert.ok(adsBlockStart >= 0 && stockBlockStart > adsBlockStart, "advertising budget output block must exist");
const adsBlock = worker.slice(adsBlockStart, stockBlockStart);
assert.match(adsBlock, /Budget:/, "advertising budget output must use a concise label");
assert.doesNotMatch(adsBlock, /Snapshot:|If this is unavailable|does not substitute zero/, "advertising budget output must omit unnecessary descriptors");
const wageBlockStart = worker.indexOf('if (subcommand === "wages") {');
const wageBlockEnd = worker.indexOf('const detailRes = await dashboardFetch', wageBlockStart);
assert.ok(wageBlockStart >= 0 && wageBlockEnd > wageBlockStart, "employee wage output block must exist");
const wageBlock = worker.slice(wageBlockStart, wageBlockEnd);
assert.match(wageBlock, /Total reported wages:/, "wage output must distinguish reported wages");
assert.match(wageBlock, /Employees with wage data:/, "wage output must show employee coverage");
assert.doesNotMatch(wageBlock, /Missing wage values remain unknown|Data is from the saved dashboard record|Roster entries returned:/, "wage output must omit unnecessary descriptors");

const chunkHelperStart = worker.indexOf("function chunkedPrivateReply(");
const severityHelperStart = worker.indexOf("function severityRank(", chunkHelperStart);
assert.ok(chunkHelperStart >= 0 && severityHelperStart > chunkHelperStart, "private reply chunk helper boundaries must exist");
const chunkHelper = worker.slice(chunkHelperStart, severityHelperStart);
assert.match(chunkHelper, /const continuationTitle = String\(title\)\.split\("\\n", 1\)\[0\] \+ " \(continued\)"/,
  "continued replies must keep only the original heading, not repeat the full multi-line header");
assert.match(chunkHelper, /current = continuationTitle \+ "\\n"/, "continued replies must use the concise continuation heading");
assert.doesNotMatch(chunkHelper, /current = title \+ " \(continued\)\\n"/, "continued replies must not duplicate all ranking metadata");

const rankingsRouteStart = worker.indexOf('if (name === "company" && commandOptions(i).group === "rankings")');
const alertsRouteStart = worker.indexOf('if (name === "company" && commandOptions(i).group === "alerts")', rankingsRouteStart);
assert.ok(rankingsRouteStart >= 0 && alertsRouteStart > rankingsRouteStart, "company rankings handler boundaries must exist");
const rankingsHandler = worker.slice(rankingsRouteStart, alertsRouteStart);
assert.match(rankingsHandler, /if \(subcommand === "company"\) \{[\s\S]*?return chunkedPrivateReply\("\*\*Company ranking\*\*"/,
  "/company rankings company must return the focused company ranking summary");
assert.match(rankingsHandler, /if \(subcommand === "global"\) \{[\s\S]*?Top 10 companies in this type, ranked by weekly income:/,
  "/company rankings global must return a top-10 type leaderboard");
assert.match(rankingsHandler, /\*\*Company ranking comparison\*\*/,
  "/company rankings compare must return nearby competitors and star-income benchmarks");
assert.match(rankingsHandler, /if \(isOwn\) return null;[\s\S]*?\}\)\.filter\(Boolean\)/,
  "comparison rows must not repeat the linked company already summarized in the header");
assert.match(rankingsHandler, /\*\*Nearby companies\*\*/,
  "comparison output must use a concise peer-list heading");
assert.match(rankingsHandler, /Observed snapshot values, not official Torn thresholds\./,
  "comparison output must retain the star-threshold caveat concisely");
assert.doesNotMatch(rankingsHandler, /Nearby ranks: 6 above and 4 below|within your company type|latest company profile; other companies use the global snapshot|no extra historical snapshot was created|currently seen at/,
  "comparison output must omit verbose explanations and redundant descriptors");
assert.doesNotMatch(rankingsHandler, /\+ \" \(\" \+ safeText\(company\.companyType/,
  "nearby comparison rows must not repeat the company type on every line");
assert.match(rankingsHandler, /Next star \(" \+ nextLevel \+ "★\):/,
  "star-income benchmark should use a concise next-star label");
console.log("PASS Discord command contract: " + commands.length + " top-level commands; distinct company rankings, concise comparison output, private replies, one-time linking, and owner-scoped reads.");
