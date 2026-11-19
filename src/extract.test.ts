import { expect, test } from "bun:test";
import { cleanCookie, pickXoxc } from "./extract.js";

test("pickXoxc returns the longest full token from noisy leveldb blobs", () => {
  expect(
    pickXoxc([
      "\u0000\u0001xoxc-123-abc\u0000garbage",
      "prefixxoxc-123-abc-def-0a1b2c3dmore\u0000",
    ]),
  ).toBe("xoxc-123-abc-def-0a1b2c3dmore");
  expect(pickXoxc(["no token here"])).toBeUndefined();
});

test("cleanCookie strips PKCS7 padding and a leading domain-hash prefix", () => {
  const value = "xoxd-abc123";
  const padded = Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([2, 2])]);
  expect(cleanCookie(padded)).toBe(value);
  const withPrefix = Buffer.concat([
    Buffer.alloc(32, 0x07),
    Buffer.from(value, "utf8"),
    Buffer.from([4, 4, 4, 4]),
  ]);
  expect(cleanCookie(withPrefix)).toBe(value);
});
