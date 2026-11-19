import { classify, type InboundMessage, type SlackFrame, toInbound } from "./core.js";

export type { InboundMessage } from "./core.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const AUTH_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
]);

export type Transport = "auto" | "rtm" | "gateway";

export type ListenOptions = {
  token: string;
  cookie: string;
  onMessage: (message: InboundMessage) => void;
  onStatus?: (status: string, detail?: unknown) => void;
  userAgent?: string;
  transport?: Transport;
};

export type Gateway = { stop: () => void };

export class SlackApiError extends Error {
  constructor(readonly code: string) {
    super(`slack rejected: ${code}`);
  }
}

export function isAuthError(error: unknown): boolean {
  return error instanceof SlackApiError && AUTH_ERRORS.has(error.code);
}

async function slackCall(
  method: string,
  token: string,
  cookie: string,
  ua: string,
  body = "",
): Promise<Record<string, unknown>> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Cookie: `d=${cookie}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": ua,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (json.ok !== true) throw new SlackApiError(String(json.error ?? `http_${response.status}`));
  return json;
}

export async function rtmConnect(token: string, cookie: string, ua = DEFAULT_UA): Promise<string> {
  const body = await slackCall("rtm.connect", token, cookie, ua, "batch_presence_aware=1");
  if (typeof body.url !== "string") throw new SlackApiError("missing_url");
  return body.url;
}

export function gatewayUrl(token: string, teamId: string): string {
  const params = new URLSearchParams({
    token,
    flannel: "3",
    lazy_channels: "1",
    batch_presence_aware: "1",
    gateway_server: `${teamId.replace(/^T/, "")}-1`,
  });
  return `wss://wss-primary.slack.com/?${params}`;
}

export async function webGatewayUrl(token: string, cookie: string, ua = DEFAULT_UA): Promise<string> {
  const body = await slackCall("auth.test", token, cookie, ua);
  if (typeof body.team_id !== "string") throw new SlackApiError("missing_team_id");
  return gatewayUrl(token, body.team_id);
}

export function listen(options: ListenOptions): Gateway {
  const ua = options.userAgent ?? DEFAULT_UA;
  const status = options.onStatus ?? (() => {});
  const headers = { Cookie: `d=${options.cookie}`, Origin: "https://app.slack.com", "User-Agent": ua };
  let socket: WebSocket | undefined;
  let stopped = false;
  let ping: ReturnType<typeof setInterval> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let nextUrl: string | undefined;
  let backoff = 1000;
  const transport = options.transport ?? "auto";

  const clearTimers = () => {
    if (ping) clearInterval(ping);
    if (idle) clearTimeout(idle);
  };
  const resetIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => socket?.close(), 60_000);
  };
  const retry = () => {
    if (stopped) return;
    status("reconnecting", backoff);
    pending = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };

  async function resolveUrl(): Promise<{ url: string; via: string }> {
    if (nextUrl) return { url: nextUrl, via: "reconnect_url" };
    if (transport === "gateway")
      return { url: await webGatewayUrl(options.token, options.cookie, ua), via: "gateway" };
    try {
      return { url: await rtmConnect(options.token, options.cookie, ua), via: "rtm" };
    } catch (error) {
      if (transport === "rtm" || isAuthError(error)) throw error;
      status("rtm_unavailable", error instanceof Error ? error.message : String(error));
      return { url: await webGatewayUrl(options.token, options.cookie, ua), via: "gateway" };
    }
  }

  async function connect() {
    if (stopped) return;
    let url: string;
    let via: string;
    try {
      ({ url, via } = await resolveUrl());
      nextUrl = undefined;
    } catch (error) {
      if (isAuthError(error)) {
        stopped = true;
        status("auth_failed", (error as SlackApiError).code);
        return;
      }
      status("connect_failed", error instanceof Error ? error.message : String(error));
      retry();
      return;
    }
    if (stopped) return;
    const ws = new WebSocket(url, { headers } as unknown as string[]);
    socket = ws;
    ws.onopen = () => {
      backoff = 1000;
      status("connected", via);
      resetIdle();
      ping = setInterval(() => {
        try {
          ws.send(JSON.stringify({ type: "ping", id: Date.now() }));
        } catch {}
      }, 15_000);
    };
    ws.onmessage = (event) => {
      resetIdle();
      let frame: SlackFrame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const kind = classify(frame);
      if (kind === "message") {
        options.onMessage(toInbound(frame));
        return;
      }
      if (kind !== "control") return;
      if (frame.type === "reconnect_url" && typeof frame.url === "string") nextUrl = frame.url;
      else if (frame.type === "hello") status("hello");
      else if (frame.type === "error") status("error", frame.error);
      else if (frame.type === "goodbye") ws.close();
    };
    ws.onclose = () => {
      clearTimers();
      if (socket === ws) socket = undefined;
      retry();
    };
    ws.onerror = () => {};
  }

  connect();
  return {
    stop() {
      stopped = true;
      clearTimers();
      if (pending) clearTimeout(pending);
      socket?.close();
    },
  };
}
