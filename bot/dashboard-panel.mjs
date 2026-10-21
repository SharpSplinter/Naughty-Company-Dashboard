// Private, read-only Discord dashboard panel component contract.
const VIEWS = Object.freeze(["home", "company", "rankings", "automation"]);
const ACTIONS = Object.freeze([...VIEWS, ...VIEWS.map(view => "refresh-" + view)]);
const USER_ID = /^[A-Za-z0-9_-]{1,32}$/;

export function isDashboardPanelView(value) {
  return VIEWS.includes(value);
}

export function parseDashboardPanelCustomId(value) {
  if (typeof value !== "string") return null;
  const match = /^ncdash:v1:([A-Za-z0-9_-]{1,32}):(home|company|rankings|automation|refresh-(home|company|rankings|automation))$/.exec(value);
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
    ["automation", "Automation"]
  ];
  const buttons = views.map(([view, label]) => ({
    type: 2,
    style: view === activeView ? 1 : 2,
    label,
    custom_id: dashboardPanelCustomId(userId, view)
  }));
  buttons.push({
    type: 2,
    style: 2,
    label: "Refresh",
    custom_id: dashboardPanelCustomId(userId, "refresh-" + activeView)
  });
  return [{ type: 1, components: buttons }];
}
