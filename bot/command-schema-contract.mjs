// Normalize the author-controlled parts of a Discord slash-command schema.
// Discord adds server metadata and may omit fields whose defaults are false/empty;
// neither should make a healthy registration appear out of sync.
function hasValue(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key) &&
    object[key] !== undefined && object[key] !== null;
}

function copyNonEmpty(object, source, target = source) {
  if (!hasValue(object, source)) return;
  const value = object[source];
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return;
  object[target] = value;
}

function normalizeChoice(choice) {
  const result = { name: choice.name, value: choice.value };
  copyNonEmpty(result, "unused"); // Keep this shape isolated from Discord-owned fields.
  copyNonEmpty(choice, "name_localizations");
  if (hasValue(choice, "name_localizations") &&
      !(choice.name_localizations && typeof choice.name_localizations === "object" &&
        !Array.isArray(choice.name_localizations) && Object.keys(choice.name_localizations).length === 0)) {
    result.name_localizations = choice.name_localizations;
  }
  return result;
}

function normalizeOption(option) {
  const result = {
    type: option.type,
    name: option.name,
    description: option.description
  };
  for (const field of ["name_localizations", "description_localizations"]) {
    if (hasValue(option, field)) {
      const value = option[field];
      if (!(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)) {
        result[field] = value;
      }
    }
  }

  if (option.type === 1 || option.type === 2) {
    if (Array.isArray(option.options) && option.options.length) {
      result.options = option.options.map(normalizeOption);
    }
    return result;
  }

  // required=false and autocomplete=false are semantic defaults; normalize their
  // omission and explicit false to the same schema. A true value must still match.
  result.required = option.required === true;
  if (Array.isArray(option.choices) && option.choices.length) {
    result.choices = option.choices.map(normalizeChoice);
  }
  if (option.autocomplete === true) result.autocomplete = true;

  // Keep explicit limits: these are user-visible validation rules, not metadata.
  for (const field of ["min_value", "max_value", "min_length", "max_length", "channel_types", "file_types"]) {
    if (hasValue(option, field)) result[field] = option[field];
  }
  return result;
}

export function normalizeCommandSchema(command) {
  const result = {
    type: command.type ?? 1,
    name: command.name,
    description: command.description
  };
  for (const field of ["name_localizations", "description_localizations"]) {
    if (hasValue(command, field)) {
      const value = command[field];
      if (!(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)) {
        result[field] = value;
      }
    }
  }
  if (Array.isArray(command.options) && command.options.length) {
    result.options = command.options.map(normalizeOption);
  }
  return result;
}

function compareValues(expected, actual, path, differences) {
  const expectedArray = Array.isArray(expected);
  const actualArray = Array.isArray(actual);
  if (expectedArray || actualArray) {
    if (!expectedArray || !actualArray) {
      differences.push(path);
      return;
    }
    if (expected.length !== actual.length) differences.push(path + ".length");
    const length = Math.min(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      compareValues(expected[index], actual[index], path + "[" + index + "]", differences);
    }
    return;
  }

  const expectedObject = expected !== null && typeof expected === "object";
  const actualObject = actual !== null && typeof actual === "object";
  if (expectedObject || actualObject) {
    if (!expectedObject || !actualObject) {
      differences.push(path);
      return;
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
      const childPath = path + "." + key;
      const expectedHas = Object.prototype.hasOwnProperty.call(expected, key);
      const actualHas = Object.prototype.hasOwnProperty.call(actual, key);
      if (expectedHas !== actualHas) differences.push(childPath);
      else compareValues(expected[key], actual[key], childPath, differences);
    }
    return;
  }

  if (!Object.is(expected, actual)) differences.push(path);
}

export function commandSchemaDifferences(expectedCommand, actualCommand) {
  if (!expectedCommand || !actualCommand) return ["/command"];
  const expected = normalizeCommandSchema(expectedCommand);
  const actual = normalizeCommandSchema(actualCommand);
  const differences = [];
  compareValues(expected, actual, "/" + expected.name, differences);
  return differences;
}
