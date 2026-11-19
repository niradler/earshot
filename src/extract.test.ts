import { expect, test } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  cleanCookie,
  decryptCookieValue,
  dpapiProtect,
  dpapiUnprotect,
  pickXoxc,
  protectedKeyFromLocalState,
} from "./extract.js";

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

test("protectedKeyFromLocalState unwraps the base64 DPAPI key blob", () => {
  const raw = randomBytes(48);
  const state = JSON.stringify({
    os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI"), raw]).toString("base64") },
  });
  expect(Buffer.from(protectedKeyFromLocalState(state))).toEqual(raw);
  expect(() => protectedKeyFromLocalState("not json")).toThrow("JSON");
  expect(() => protectedKeyFromLocalState("{}")).toThrow("encrypted_key");
  expect(() =>
    protectedKeyFromLocalState(
      JSON.stringify({ os_crypt: { encrypted_key: Buffer.from("OTHER").toString("base64") } }),
    ),
  ).toThrow("DPAPI");
});

test("decryptCookieValue decrypts Chromium v10/v11 AES-GCM cookies and rejects tampering", () => {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cookie = "xoxd-fixture-cookie-value";
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(cookie, "utf8"), cipher.final(), cipher.getAuthTag()]);
  for (const prefix of ["v10", "v11"]) {
    const encrypted = Buffer.concat([Buffer.from(prefix), nonce, body]);
    expect(decryptCookieValue(encrypted, key)).toBe(cookie);
  }
  const encrypted = Buffer.concat([Buffer.from("v10"), nonce, body]);
  expect(() => decryptCookieValue(encrypted, randomBytes(32))).toThrow();
  expect(() => decryptCookieValue(Buffer.concat([Buffer.from("v20"), nonce, body]), key)).toThrow(
    "version",
  );
  const plain = createCipheriv("aes-256-gcm", key, nonce);
  const notCookie = Buffer.concat([
    plain.update("something-else", "utf8"),
    plain.final(),
    plain.getAuthTag(),
  ]);
  expect(() =>
    decryptCookieValue(Buffer.concat([Buffer.from("v10"), nonce, notCookie]), key),
  ).toThrow("valid");
});

test.skipIf(process.platform !== "win32")(
  "DPAPI round-trips the Slack key on Windows",
  () => {
    const key = randomBytes(32);
    const protectedBytes = dpapiProtect(key);
    expect(Buffer.from(protectedBytes)).not.toEqual(key);
    expect(Buffer.from(dpapiUnprotect(protectedBytes))).toEqual(key);
  },
);
