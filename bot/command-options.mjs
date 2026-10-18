// JSON option builders for Discord application-command API v10.
// type 1 = SUB_COMMAND; type 2 = SUB_COMMAND_GROUP.
export const sub = (name, description, options = []) => ({ type: 1, name, description, ...(options.length ? { options } : {}) });
export const group = (name, description, options = []) => ({ type: 2, name, description, options });
export const str = (name, description, required = false, extras = {}) => ({ type: 3, name, description, required, ...extras });
export const integer = (name, description, required = false, extras = {}) => ({ type: 4, name, description, required, ...extras });
export const companyId = () => str("company_id", "Connected company ID; defaults to your most recently saved company", false, { min_length: 1, max_length: 20 });
export const period = () => str("period", "Historical window", false, { choices: [
  { name: "7 days", value: "7" }, { name: "30 days", value: "30" },
  { name: "90 days", value: "90" }, { name: "365 days", value: "365" }, { name: "All history", value: "all" }
] });
export const detail = () => str("detail", "Roster detail level", false, { choices: [
  { name: "Brief", value: "brief" }, { name: "Full", value: "full" }
] });
