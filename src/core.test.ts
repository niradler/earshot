import { expect, test } from "bun:test";
import { classify, toInbound } from "./core.ts";

test("classify keeps new human messages and drops acks, noise, edits and controls", () => {
  expect(classify({ type: "message", channel: "D1", user: "U1", text: "hi", ts: "1" })).toBe(
    "message",
  );
  expect(classify({ type: "message", text: "ack", reply_to: 7, ts: "1" })).toBe("ignore");
  expect(classify({ type: "message", subtype: "message_changed", text: "x", ts: "1" })).toBe(
    "ignore",
  );
  expect(classify({ type: "message", subtype: "message_deleted", ts: "1" })).toBe("ignore");
  expect(classify({ type: "message", ts: "1" })).toBe("ignore");
  expect(classify({ type: "user_typing", channel: "D1" })).toBe("ignore");
  expect(classify({ type: "hello" })).toBe("control");
  expect(classify({ type: "reconnect_url", url: "wss://x" })).toBe("control");
  expect(classify({})).toBe("ignore");
  expect(classify({ type: "message", subtype: "file_share", text: "see this", ts: "1" })).toBe(
    "message",
  );
});

test("toInbound copies only the fields that are present", () => {
  expect(
    toInbound({ type: "message", channel: "C1", user: "U1", text: "yo", ts: "2", thread_ts: "1" }),
  ).toEqual({ channel: "C1", user: "U1", text: "yo", ts: "2", thread_ts: "1" });
  expect(toInbound({ type: "message", channel: "D1", user: "U1", text: "hey", ts: "3" })).toEqual({
    channel: "D1",
    user: "U1",
    text: "hey",
    ts: "3",
  });
});
