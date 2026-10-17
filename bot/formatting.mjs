export function money(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Not available";
  const rounded = Math.round(value);
  const formatted = Math.abs(rounded).toLocaleString("en-US");
  return (rounded < 0 ? "-$" : "$") + formatted;
}

export function numberLabel(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? (value > 0 ? "+" : "") + value.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : "Not reported";
}

export function countChangeLabel(value, singular, plural = singular + "s") {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Not available";
  return numberLabel(value) + " " + (Math.abs(value) === 1 ? singular : plural);
}
