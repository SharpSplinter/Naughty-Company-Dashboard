// Parse Discord HTTP interaction payloads without requiring a discord.js gateway client.
// Discord option type 2 is a subcommand group; type 1 is a subcommand.
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const optionList = value => Array.isArray(value) ? value.filter(isRecord) : [];
const optionName = value => typeof value === "string" && value.length > 0 ? value : null;

/**
 * @param {unknown} interaction Raw Discord interaction JSON.
 * @returns {{ group: string | null, subcommand: string | null, options: Record<string, unknown>[] }}
 */
export function parseCommandRoute(interaction) {
  const root = isRecord(interaction) && isRecord(interaction.data) ? interaction.data : {};
  const topOptions = optionList(root.options);

  const groupOption = topOptions.find(option => option.type === 2);
  if (groupOption) {
    const groupChildren = optionList(groupOption.options);
    const child = groupChildren.find(option => option.type === 1);
    return {
      group: optionName(groupOption.name),
      subcommand: child ? optionName(child.name) : null,
      options: child ? optionList(child.options) : []
    };
  }

  const subcommandOption = topOptions.find(option => option.type === 1);
  if (subcommandOption) {
    return {
      group: null,
      subcommand: optionName(subcommandOption.name),
      options: optionList(subcommandOption.options)
    };
  }

  // A root command without subcommands may still have plain top-level arguments.
  return { group: null, subcommand: null, options: topOptions };
}
