import { expect, test } from "bun:test";
import { gatewayUrl, isAuthError, SlackApiError } from "./gateway.js";

test("gatewayUrl targets the web-client socket for the team, token url-encoded", () => {
  const url = new URL(gatewayUrl("xoxc-1/2+3", "T0ABC"));
  expect(url.origin).toBe("wss://wss-primary.slack.com");
  expect(url.searchParams.get("token")).toBe("xoxc-1/2+3");
  expect(url.searchParams.get("gateway_server")).toBe("0ABC-1");
  expect(url.searchParams.get("flannel")).toBe("3");
});

test("isAuthError stops on a dead session but retries everything else", () => {
  expect(isAuthError(new SlackApiError("invalid_auth"))).toBe(true);
  expect(isAuthError(new SlackApiError("token_revoked"))).toBe(true);
  expect(isAuthError(new SlackApiError("ratelimited"))).toBe(false);
  expect(isAuthError(new Error("invalid_auth"))).toBe(false);
});
