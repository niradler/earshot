# earshot

Real-time Slack message events over **your own session** — no app, no bot, no admin approval, no polling.

Slack's official real-time options all need an installed app (Socket Mode / Events API). earshot instead reuses the exact websocket your Slack web client already holds open, authenticated with your browser session (`xoxc` token + `d` cookie). You get a push the instant a message arrives, as yourself.

```
your Slack web session (xoxc + d cookie)
        │  POST api.slack.com/api/rtm.connect
        ▼
   wss gateway url  ──── push ────▶  { channel, user, text, ts, … }
        (the same socket the browser uses)     the moment a message arrives
```

## Why

- **No app to install, no admin to ask.** Works on locked-down workspaces where you can't add a bot.
- **No polling.** A real websocket; events arrive in real time with no rate-limit churn.
- **Tiny.** One dependency-free Bun file. Emits NDJSON you can pipe anywhere, or POST to a webhook.

## Install

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/niradler/earshot
cd earshot
bun install
```

## Get your session

Both values live in your logged-in Slack **web** client (`app.slack.com` in a browser):

- **`SLACK_XOXC`** — open DevTools → Console on your Slack tab and run `TS.boot_data.api_token`. It starts with `xoxc-`.
- **`SLACK_XOXD`** — DevTools → Application → Cookies → the `d` cookie value (starts with `xoxd-`). This is secret; it is your session.

Put them in `.env` (git-ignored):

```bash
cp .env.example .env
# edit .env with your two values
```

## Run

```bash
bun start
```

Each new message prints as one JSON line on stdout; status goes to stderr:

```json
{"channel":"D01ABC","user":"U08…","text":"ping","ts":"1732000000.000100","channel_type":"im"}
```

Pipe it, or set `WEBHOOK_URL` in `.env` to POST every message as JSON to your own service (an agent trigger, a bot, a logger).

## As a library

```ts
import { listen } from "earshot/src/gateway.ts";

const gateway = listen({
  token: process.env.SLACK_XOXC!,
  cookie: process.env.SLACK_XOXD!,
  onMessage: (m) => console.log("new message", m),
  onStatus: (s) => console.error(s),
});
// gateway.stop() when done
```

## What you get

Only genuinely new, human messages are emitted. earshot drops your own send-acks (`reply_to`), edits and deletes (`message_changed` / `message_deleted`), and presence/typing noise. Control frames (`hello`, `reconnect_url`, `goodbye`, `error`) drive the connection and reconnect automatically.

## Caveats — read these

- **Unofficial.** This rides Slack's internal client transport. It can break if Slack changes it, and it is outside Slack's API terms of use.
- **It is you.** Everything arrives under your identity and your access — treat the `d` cookie like a password.
- **Not for production/compliance.** No audit trail, no admin visibility. Great for personal automation; a non-starter where you need either.

## License

MIT
