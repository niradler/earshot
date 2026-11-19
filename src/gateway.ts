import { classify, type InboundMessage, type SlackFrame, toInbound } from "./core.ts";

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export type ListenOptions = {
  token: string;
  cookie: string;
  onMessage: (message: InboundMessage) => void;
  onStatus?: (status: string, detail?: unknown) => void;
  userAgent?: string;
};

export type Gateway = { stop: () => void };

export async function rtmConnect(
  token: string,
  cookie: string,
  ua = DEFAULT_UA,
): Promise<string> {
  const response = await fetch("https://api.slack.com/api/rtm.connect", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Cookie: `d=${cookie}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": ua,
    },
    body: "batch_presence_aware=1",
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.ok !== true || typeof body.url !== "string")
    throw new Error(`rtm.connect rejected: ${body.error ?? `http_${response.status}`}`);
  return body.url;
}

export function listen(options: ListenOptions): Gateway {
  const ua = options.userAgent ?? DEFAULT_UA;
  const status = options.onStatus ?? (() => {});
  const headers = { Cookie: `d=${options.cookie}`, Origin: "https://app.slack.com", "User-Agent": ua };
  let socket: WebSocket | undefined;
  let stopped = false;
  let ping: ReturnType<typeof setInterval> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let nextUrl: string | undefined;
  let backoff = 1000;

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
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };

  async function connect() {
    if (stopped) return;
    let url: string;
    try {
      url = nextUrl ?? (await rtmConnect(options.token, options.cookie, ua));
      nextUrl = undefined;
    } catch (error) {
      status("connect_failed", error instanceof Error ? error.message : String(error));
      retry();
      return;
    }
    const ws = new WebSocket(url, { headers } as unknown as string[]);
    socket = ws;
    ws.onopen = () => {
      backoff = 1000;
      status("connected");
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
      socket?.close();
    },
  };
}
