#!/usr/bin/env bun
import { listen } from "./gateway.ts";

const token = process.env.SLACK_XOXC;
const cookie = process.env.SLACK_XOXD;
if (!token || !cookie) {
  console.error(
    "earshot: set SLACK_XOXC (xoxc-… token) and SLACK_XOXD (the d cookie value). See the README.",
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
