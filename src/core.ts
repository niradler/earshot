export const CONTROL_TYPES = new Set(["hello", "pong", "reconnect_url", "goodbye", "error"]);
export const NOISE_TYPES = new Set([
  "presence_change",
  "manual_presence_change",
  "user_typing",
  "user_status_changed",
  "dnd_updated",
  "dnd_updated_user",
]);
const EDIT_SUBTYPES = new Set(["message_changed", "message_deleted", "message_replied"]);

export type SlackFrame = Record<string, unknown>;

export type InboundMessage = {
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  channel_type?: string;
  subtype?: string;
};

export function classify(frame: SlackFrame): "message" | "control" | "ignore" {
  const type = typeof frame.type === "string" ? frame.type : "";
  if (!type) return "ignore";
  if (frame.reply_to !== undefined) return "ignore";
  if (CONTROL_TYPES.has(type)) return "control";
  if (NOISE_TYPES.has(type)) return "ignore";
  if (type !== "message") return "ignore";
  const subtype = typeof frame.subtype === "string" ? frame.subtype : undefined;
  if (subtype && EDIT_SUBTYPES.has(subtype)) return "ignore";
  if (typeof frame.text !== "string") return "ignore";
  return "message";
}

export function toInbound(frame: SlackFrame): InboundMessage {
  return {
    channel: String(frame.channel ?? ""),
    user: String(frame.user ?? ""),
    text: String(frame.text ?? ""),
    ts: String(frame.ts ?? ""),
    ...(typeof frame.thread_ts === "string" ? { thread_ts: frame.thread_ts } : {}),
    ...(typeof frame.channel_type === "string" ? { channel_type: frame.channel_type } : {}),
    ...(typeof frame.subtype === "string" ? { subtype: frame.subtype } : {}),
  };
}
