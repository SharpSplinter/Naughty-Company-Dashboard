import { sub } from "../command-options.mjs";

export const botCommand = { name: "bot", description: "Bot operational status", options: [
    sub("status", "Check bot and dashboard API availability")
  ]};
