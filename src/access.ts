import type { Bot, Binding } from "./config.js";

export function isUserAllowed(bot: Bot, user: string, binding?: Binding) {
  return (
    bot.allowAllUsers === true ||
    (bot.allowedUsers ?? binding?.allowedUsers ?? []).includes(user)
  );
}
