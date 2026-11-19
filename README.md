# earshot

Real-time Slack message events over **your own session** — no app, no bot, no admin approval, no polling.

Slack's official real-time options all need an installed app (Socket Mode / Events API). earshot instead reuses the exact websocket your Slack web client already holds open, authenticated with your browser session (`xoxc` token + `d` cookie). You get a push the instant a message arrives, as yourself.

```
your Slack web session (xoxc + d cookie)
        │  rtm.connect  (falls back to the web-client gateway if Slack refuses it)
        ▼
   wss socket  ──── push ────▶  { channel, user, text, ts, … }
        (the same socket the browser uses)     the moment a message arrives
```

## Why

- **No app to install, no admin to ask.** Works on locked-down workspaces where you can't add a bot.
- **No polling.** A real websocket; events arrive in real time with no rate-limit churn.
- **Tiny.** One dependency-free Bun file. Emits NDJSON you can pipe anywhere, or POST to a webhook.

## Install

Requires [Bun](https://bun.sh).

```bash
bun add @niradler55/earshot   # as a library
bunx @niradler55/earshot      # run the CLI directly
```

Or from source:

```bash
git clone https://github.com/niradler/earshot
cd earshot
bun install
```

## Run

```bash
bun start
```

On **macOS**, if `SLACK_XOXC` / `SLACK_XOXD` aren't set, earshot pulls them automatically from the installed **Slack desktop app** — the `xoxc` token from its Local Storage and the `d` cookie from its Cookies DB (decrypted with the "Slack Safe Storage" Keychain key; macOS may ask you to allow Keychain access once). No browser, no copy-paste.

Print the session for your shell or another tool:

```bash
bun run token        # from source -> export SLACK_XOXC='…'  export SLACK_XOXD='…'
bunx @niradler55/earshot token   # from the published package (macOS)
eval "$(bun run token)"
```

## Get your session manually

Not on macOS, or want to set it yourself? Both values live in your logged-in Slack **web** client (`app.slack.com`):

- **`SLACK_XOXC`** — DevTools → Console → `TS.boot_data.api_token` (starts `xoxc-`).
- **`SLACK_XOXD`** — DevTools → Application → Cookies → the `d` cookie value (starts `xoxd-`). This is your session; treat it like a password.

```bash
cp .env.example .env   # then edit, or export the two vars
```

Each new message prints as one JSON line on stdout; status goes to stderr:

```json
{"channel":"D01ABC","user":"U08…","text":"ping","ts":"1732000000.000100","channel_type":"im"}
```

Pipe it, or set `WEBHOOK_URL` in `.env` to POST every message as JSON to your own service (an agent trigger, a bot, a logger).

| Variable | Default | |
|---|---|---|
| `SLACK_XOXC` / `SLACK_XOXD` | read from the desktop app (macOS) | your session |
| `WEBHOOK_URL` | unset | POST each message as JSON; 10s timeout, 3 attempts with backoff on 5xx/429/network errors |
| `WEBHOOK_HEADERS` | unset | JSON object of extra headers, e.g. `{"Authorization":"Bearer …"}` |
| `EARSHOT_TRANSPORT` | `auto` | `auto`, `rtm` or `gateway` (see Transports) |

Exit codes: `1` bad config or no session, `2` Slack rejected the session (logged out, revoked). Run it under a supervisor (launchd, systemd, pm2) so a restart re-reads a fresh session from the desktop app.

## As a library

```ts
import { listen } from "@niradler55/earshot";
import { resolveSession } from "@niradler55/earshot/session";

const { token, cookie } = resolveSession();
const gateway = listen({
  token,
  cookie,
  onMessage: (m) => console.log("new message", m),
  onStatus: (status, detail) => {
    if (status === "auth_failed") console.error("session expired", detail);
  },
});
// gateway.stop() when done
```

Statuses: `connected` (detail: `rtm`, `gateway` or `reconnect_url`), `hello`, `rtm_unavailable`, `connect_failed`, `reconnecting`, `error`, and `auth_failed`, after which the listener stops for good.

## Transports

- **`rtm`** — `rtm.connect` with your session returns the socket URL. Slack's RTM deprecation covers apps; a browser session still gets a URL.
- **`gateway`** — the web client's own socket (`wss-primary.slack.com`), keyed by your team id from `auth.test`. Works where `rtm.connect` is blocked.
- **`auto`** (default) — `rtm`, and on any non-auth failure the gateway. Same frames on both.
```

## What you get

Only genuinely new, human messages are emitted. earshot drops your own send-acks (`reply_to`), edits and deletes (`message_changed` / `message_deleted`), and presence/typing noise. Control frames (`hello`, `reconnect_url`, `goodbye`, `error`) drive the connection and reconnect automatically.

## What's on the stream

The socket carries the **same event stream the Slack web client sees** — everything that happens in the channels and DMs you're a member of, in real time. earshot forwards new messages by default, but these event types are all on the wire (switch on `type` in `src/core.ts` to use more):

- **Messages** — `message`, including DMs (`channel_type: "im"`), group DMs (`mpim`), channels and threads (`thread_ts`); subtypes like `file_share`, `message_changed`, `message_deleted`. Mentions are detected by scanning `text` for your user id (there is no separate app-mention event on a user session).
- **Reactions** — `reaction_added`, `reaction_removed`.
- **Channel / membership** — `channel_created`, `channel_joined`, `member_joined_channel`, `member_left_channel`, `im_created`.
- **Pins / stars / files** — `pin_added`, `pin_removed`, `star_added`, `file_shared`, `file_created`.
- **Presence / activity** — `user_typing`, `presence_change`, `dnd_updated` (earshot treats these as noise).

You cannot subscribe to activity outside your own membership — this is your session, not an admin feed.

## Caveats — read these

- **Unofficial.** This rides Slack's internal client transport. It can break if Slack changes it, and it is outside Slack's API terms of use.
- **It is you.** Everything arrives under your identity and your access — treat the `d` cookie like a password.
- **Messages sent while the socket reconnects are not replayed.** earshot is push-only; it does not backfill a gap with `conversations.history`.
- **Not for production/compliance.** No audit trail, no admin visibility. Great for personal automation; a non-starter where you need either.

## License

MIT
