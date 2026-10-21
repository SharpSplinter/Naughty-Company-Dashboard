// Private, read-only Discord dashboard panel component contract.
const VIEWS = Object.freeze(["home", "company", "rankings", "automation", "alerts", "trends"]);
const ACTIONS = Object.freeze([...VIEWS, ...VIEWS.map(view => "refresh-" + view)]);
const USER_ID = /^[A-Za-z0-9_-]{1,32}$/;

export function isDashboardPanelView(value) {
  return VIEWS.includes(value);
}

export function parseDashboardPanelCustomId(value) {
  if (typeof value !== "string") return null;
  const match = /^ncdash:v1:([A-Za-z0-9_-]{1,32}):(home|company|rankings|automation|alerts|trends|refresh-(home|company|rankings|automation|alerts|trends))$/.exec(value);
  if (!match) return null;

  const action = match[2];
  const refresh = action.startsWith("refresh-");
  return {
    version: 1,
    ownerId: match[1],
    view: refresh ? match[3] : action,
    refresh
  };
}

export function dashboardPanelCustomId(userId, action) {
  if (typeof userId !== "string" || !USER_ID.test(userId)) {
    throw new TypeError("Dashboard panel owner must be a bounded Discord user identifier.");
  }
  if (!ACTIONS.includes(action)) {
    throw new TypeError("Dashboard panel action is not allowlisted.");
  }
  const customId = "ncdash:v1:" + userId + ":" + action;
  if (customId.length > 100) throw new RangeError("Dashboard panel component ID exceeds Discord's limit.");
  return customId;
}

export function buildDashboardPanelComponents(userId, activeView) {
  if (!isDashboardPanelView(activeView)) throw new TypeError("Dashboard panel view is not allowlisted.");
  const views = [
    ["home", "Home"],
    ["company", "Company"],
    ["rankings", "Rankings"],
    ["automation", "Automation"],
    ["alerts", "Alerts"],
    ["trends", "Trends"]
  ];
  const buttons = views.map(([view, label]) => ({
    type: 2,
    style: view === activeView ? 1 : 2,
    label,
    custom_id: dashboardPanelCustomId(userId, view)
  }));
  const refreshButton = {
    type: 2,
    style: 2,
    label: "Refresh",
    custom_id: dashboardPanelCustomId(userId, "refresh-" + activeView)
  };
  // Keep each Discord action row within its five-button limit and group the less
  // frequently used monitoring views together on a second row.
  return [
    { type: 1, components: buttons.slice(0, 3) },
    { type: 1, components: [...buttons.slice(3), refreshButton] }
  ];
}
