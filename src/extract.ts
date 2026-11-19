import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { dlopen, FFIType, ptr, read } from "bun:ffi";

export type Session = { token: string; cookie: string };

const XOXC = /xoxc-[0-9A-Za-z-]+/g;

export function pickXoxc(blobs: string[]): string | undefined {
  const found = new Set<string>();
  for (const blob of blobs) for (const match of blob.match(XOXC) ?? []) found.add(match);
  return [...found].sort((a, b) => b.length - a.length)[0];
}

export function cleanCookie(decrypted: Uint8Array): string {
  let end = decrypted.length;
  const pad = decrypted[end - 1] ?? 0;
  if (pad > 0 && pad <= 16) end -= pad;
  const text = Buffer.from(decrypted.subarray(0, end)).toString("utf8");
  const start = text.indexOf("xoxd-");
  return start >= 0 ? text.slice(start) : text;
}

function slackDir(): string {
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "Slack");
  if (process.platform === "win32")
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Slack");
  throw new Error(
    "auto-fetch supports macOS and Windows; set SLACK_XOXC and SLACK_XOXD yourself (see README)",
  );
}

function readToken(dir: string): string {
  const leveldb = join(dir, "Local Storage", "leveldb");
  const blobs: string[] = [];
  for (const file of readdirSync(leveldb)) {
    try {
      blobs.push(readFileSync(join(leveldb, file)).toString("latin1"));
    } catch {}
  }
  const token = pickXoxc(blobs);
  if (!token) throw new Error("no xoxc token in the Slack app — are you logged in?");
  return token;
}

function cookieFile(dir: string): string {
  for (const candidate of [join(dir, "Network", "Cookies"), join(dir, "Cookies")])
    if (existsSync(candidate)) return candidate;
  throw new Error("no Slack cookie database found — is the desktop app installed?");
}

function readCookieRow(dir: string): Uint8Array {
  const source = cookieFile(dir);
  const copy = join(tmpdir(), `earshot-cookies-${process.pid}-${Date.now()}`);
  let row: { encrypted_value: Uint8Array } | null;
  try {
    copyFileSync(source, copy);
    const db = new Database(copy, { readonly: true });
    try {
      row = db
        .query<{ encrypted_value: Uint8Array }, []>(
          "SELECT encrypted_value FROM cookies WHERE name='d' AND host_key LIKE '%slack.com' LIMIT 1",
        )
        .get();
    } finally {
      db.close();
    }
  } finally {
    rmSync(copy, { force: true });
  }
  if (!row) throw new Error("no 'd' cookie in the Slack app");
  return row.encrypted_value;
}

/** The DPAPI-protected AES key blob stored in Slack's `Local State` (Windows). */
export function protectedKeyFromLocalState(text: string): Uint8Array {
  let parsed: { os_crypt?: { encrypted_key?: string } };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Slack Local State is not valid JSON");
  }
  const encoded = parsed.os_crypt?.encrypted_key;
  if (!encoded) throw new Error("no os_crypt.encrypted_key in Slack Local State");
  const blob = Buffer.from(encoded, "base64");
  if (blob.subarray(0, 5).toString() !== "DPAPI")
    throw new Error("Slack Local State key is not DPAPI-protected");
  return blob.subarray(5);
}

/** Chromium v10/v11 cookie: 3-byte prefix, 12-byte nonce, ciphertext + 16-byte GCM tag. */
export function decryptCookieValue(encrypted: Uint8Array, key: Uint8Array): string {
  const data = Buffer.from(encrypted);
  const prefix = data.subarray(0, 3).toString();
  if (prefix !== "v10" && prefix !== "v11")
    throw new Error("unsupported Slack cookie encryption version");
  const nonce = data.subarray(3, 15);
  const body = data.subarray(15);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(body.subarray(body.length - 16));
  const cookie = cleanCookie(
    Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]),
  );
  if (!cookie.startsWith("xoxd-")) throw new Error("decrypted 'd' cookie did not look valid");
  return cookie;
}

type Crypt32 = {
  CryptUnprotectData: (
    input: Buffer,
    descr: null,
    entropy: null,
    reserved: null,
    prompt: null,
    flags: number,
    output: Buffer,
  ) => boolean;
  CryptProtectData: (
    input: Buffer,
    descr: null,
    entropy: null,
    reserved: null,
    prompt: null,
    flags: number,
    output: Buffer,
  ) => boolean;
  LocalFree: (address: bigint) => bigint;
};
let crypt32: Crypt32 | undefined;

function dpapi(): Crypt32 {
  if (process.platform !== "win32") throw new Error("DPAPI is Windows-only");
  if (!crypt32) {
    // DATA_BLOB on x64: u32 cbData, 4 bytes padding, ptr pbData.
    const args = [
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.u32,
      FFIType.ptr,
    ] as const;
    const lib = dlopen("crypt32.dll", {
      CryptUnprotectData: { args: [...args], returns: FFIType.bool },
      CryptProtectData: { args: [...args], returns: FFIType.bool },
    });
    const kernel32 = dlopen("kernel32.dll", {
      LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
    });
    const loaded: Crypt32 = {
      CryptUnprotectData: lib.symbols.CryptUnprotectData,
      CryptProtectData: lib.symbols.CryptProtectData,
      LocalFree: kernel32.symbols.LocalFree as (address: bigint) => bigint,
    };
    crypt32 = loaded;
    return loaded;
  }
  return crypt32;
}

function blobBuffer(bytes: Uint8Array): Buffer {
  const blob = Buffer.alloc(16);
  blob.writeUInt32LE(bytes.length, 0);
  blob.writeBigUInt64LE(BigInt(ptr(bytes)), 8);
  return blob;
}

function readBlob(blob: Buffer): Uint8Array {
  const length = blob.readUInt32LE(0);
  const address = blob.readBigUInt64LE(8);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = read.u8(address, i);
  dpapi().LocalFree(address);
  return out;
}

export function dpapiUnprotect(protectedBytes: Uint8Array): Uint8Array {
  const input = blobBuffer(protectedBytes);
  const output = Buffer.alloc(16);
  if (!dpapi().CryptUnprotectData(input, null, null, null, null, 0, output))
    throw new Error("Windows DPAPI refused the Slack key (different user account?)");
  return readBlob(output);
}

export function dpapiProtect(bytes: Uint8Array): Uint8Array {
  const input = blobBuffer(bytes);
  const output = Buffer.alloc(16);
  if (!dpapi().CryptProtectData(input, null, null, null, null, 0, output))
    throw new Error("Windows DPAPI protection failed");
  return readBlob(output);
}

function readCookie(dir: string): string {
  const encrypted = readCookieRow(dir);
  if (process.platform === "win32") {
    const key = dpapiUnprotect(
      protectedKeyFromLocalState(readFileSync(join(dir, "Local State"), "utf8")),
    );
    return decryptCookieValue(encrypted, key);
  }
  const keychain = Bun.spawnSync([
    "security",
    "find-generic-password",
    "-w",
    "-s",
    "Slack Safe Storage",
  ]);
  if (keychain.exitCode !== 0)
    throw new Error("could not read the Slack Safe Storage key from Keychain (approve the prompt?)");
  const password = keychain.stdout.toString().trim();
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const data = Buffer.from(encrypted);
  const body = data.subarray(data.subarray(0, 3).toString() === "v10" ? 3 : 0);
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  decipher.setAutoPadding(false);
  const cookie = cleanCookie(Buffer.concat([decipher.update(body), decipher.final()]));
  if (!cookie.startsWith("xoxd-")) throw new Error("decrypted 'd' cookie did not look valid");
  return cookie;
}

export function extractFromDesktop(): Session {
  const dir = slackDir();
  return { token: readToken(dir), cookie: readCookie(dir) };
}

export function resolveSession(): Session {
  const token = process.env.SLACK_XOXC;
  const cookie = process.env.SLACK_XOXD;
  if (token && cookie) return { token, cookie };
  const fromApp = extractFromDesktop();
  return { token: token || fromApp.token, cookie: cookie || fromApp.cookie };
}

export function printSession(): void {
  const { token, cookie } = extractFromDesktop();
  process.stdout.write(`export SLACK_XOXC='${token}'\nexport SLACK_XOXD='${cookie}'\n`);
}

if (import.meta.main) printSession();
