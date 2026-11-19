import { afterAll, expect, test } from "bun:test";
import { deliver, parseHeaders } from "./webhook.ts";

const statuses: number[] = [];
const seen: { auth: string | null; body: unknown }[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    seen.push({ auth: request.headers.get("authorization"), body: await request.json() });
    return new Response(null, { status: statuses.shift() ?? 200 });
  },
});
afterAll(() => server.stop(true));
const url = `http://localhost:${server.port}/hook`;

test("deliver retries 5xx then succeeds, sending headers and the JSON body", async () => {
  seen.length = 0;
  statuses.push(500, 503);
  await deliver(url, { text: "hi" }, { headers: { Authorization: "Bearer k" }, delayMs: 1 });
  expect(seen).toHaveLength(3);
  expect(seen[2]).toEqual({ auth: "Bearer k", body: { text: "hi" } });
});

test("deliver gives up after the last attempt and on a 4xx without retrying", async () => {
  seen.length = 0;
  statuses.push(500, 500, 500);
  await expect(deliver(url, {}, { delayMs: 1 })).rejects.toThrow("webhook failed: http_500");
  expect(seen).toHaveLength(3);
  seen.length = 0;
  statuses.push(401);
  await expect(deliver(url, {}, { delayMs: 1 })).rejects.toThrow("webhook failed: http_401");
  expect(seen).toHaveLength(1);
});

test("deliver fails on an unreachable endpoint", async () => {
  await expect(deliver("http://127.0.0.1:1/x", {}, { attempts: 2, delayMs: 1 })).rejects.toThrow(
    "webhook failed:",
  );
});

test("parseHeaders accepts a JSON object of strings and rejects anything else", () => {
  expect(parseHeaders(undefined)).toEqual({});
  expect(parseHeaders('{"Authorization":"Bearer x"}')).toEqual({ Authorization: "Bearer x" });
  expect(() => parseHeaders('["a"]')).toThrow();
  expect(() => parseHeaders('{"n":1}')).toThrow();
  expect(() => parseHeaders("nope")).toThrow();
});
