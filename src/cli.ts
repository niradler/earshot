#!/usr/bin/env bun
import { resolveSession } from "./extract.ts";
import { listen } from "./gateway.ts";

let token: string;
let cookie: string;
try {
  const fromEnv = Boolean(process.env.SLACK_XOXC && process.env.SLACK_XOXD);
  ({ token, cookie } = resolveSession());
  if (!fromEnv) console.error("[earshot] loaded your session from the Slack desktop app");
} catch (error) {
  console.error(
    `[earshot] no SLACK_XOXC/SLACK_XOXD and could not read the Slack desktop app: ${
      error instanceof Error ? error.message : error
    }`,
  );
  process.exit(1);
}
const webhook = process.env.WEBHOOK_URL;

const gateway = listen({
  token,
  cookie,
  onStatus: (status, detail) =>
    console.error(`[earshot] ${status}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`),
  onMessage: (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
    if (webhook)
      fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      }).catch((error) => console.error(`[earshot] webhook failed: ${error}`));
  },
});

const shutdown = () => {
  gateway.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
