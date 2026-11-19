import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

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

// ponytail: macOS only; Linux (Secret Service / "peanuts", 1 iter) and Windows (DPAPI + AES-GCM) decrypt differently — add when needed.
function slackDir(): string {
  if (process.platform !== "darwin")
    throw new Error(
      "auto-fetch is macOS-only for now; set SLACK_XOXC and SLACK_XOXD yourself (see README)",
    );
  return join(homedir(), "Library", "Application Support", "Slack");
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

function readCookie(dir: string): string {
  const copy = join(tmpdir(), `earshot-cookies-${process.pid}-${Date.now()}`);
  let row: { encrypted_value: Uint8Array } | null;
  try {
    copyFileSync(join(dir, "Cookies"), copy);
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
  const encrypted = Buffer.from(row.encrypted_value);
  const body = encrypted.subarray(encrypted.subarray(0, 3).toString() === "v10" ? 3 : 0);
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
