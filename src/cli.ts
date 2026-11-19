#!/usr/bin/env bun
import { resolveSession } from "./extract.js";
import { listen, type Transport } from "./gateway.js";
import { deliver, parseHeaders } from "./webhook.js";

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
let headers: Record<string, string>;
try {
  headers = parseHeaders(process.env.WEBHOOK_HEADERS);
} catch (error) {
  console.error(`[earshot] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
const transport = (process.env.EARSHOT_TRANSPORT ?? "auto") as Transport;
if (!["auto", "rtm", "gateway"].includes(transport)) {
  console.error("[earshot] EARSHOT_TRANSPORT must be auto, rtm or gateway");
  process.exit(1);
}

const gateway = listen({
  token,
  cookie,
  transport,
  onStatus: (status, detail) => {
    console.error(`[earshot] ${status}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
    if (status === "auth_failed") {
      console.error("[earshot] session rejected; log in to Slack again, then restart");
      process.exit(2);
    }
  },
  onMessage: (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
    if (webhook)
      deliver(webhook, message, { headers }).catch((error) =>
        console.error(`[earshot] ${error instanceof Error ? error.message : error}`),
      );
  },
});

const shutdown = () => {
  gateway.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
