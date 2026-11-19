import { resolveSession } from "../src/extract.ts";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(`usage: bun scripts/e2e.ts [--transport auto|rtm|gateway ...]

Runs the CLI against your real Slack session, posts a nonce to your own DM,
and checks it arrives on stdout and on an authenticated local webhook.
Also checks a bogus session exits with code 2. Prints no workspace data.`);
  process.exit(0);
}
const transports = args.flatMap((arg, i) => (args[i - 1] === "--transport" ? [arg] : []));
for (const t of transports)
  if (!["auto", "rtm", "gateway"].includes(t)) throw new Error(`bad transport ${t}`);
if (!transports.length) transports.push("rtm", "gateway");

const { token, cookie } = resolveSession();
async function slack(method: string, body: Record<string, string>) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Cookie: `d=${cookie}` },
    body: new URLSearchParams(body),
  });
  const json = (await response.json()) as Record<string, unknown>;
  if (json.ok !== true) throw new Error(`${method}: ${json.error}`);
  return json;
}

const me = String((await slack("auth.test", {})).user_id);
const hooked: { auth: string | null; text: string }[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { text: string };
    hooked.push({ auth: request.headers.get("authorization"), text: body.text });
    return new Response("ok");
  },
});

async function waitFor(check: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(100);
  }
  return false;
}

let failed = false;
for (const transport of transports) {
  const child = Bun.spawn(["bun", "src/cli.ts"], {
    env: {
      ...process.env,
      SLACK_XOXC: token,
      SLACK_XOXD: cookie,
      EARSHOT_TRANSPORT: transport,
      WEBHOOK_URL: `http://localhost:${server.port}/hook`,
      WEBHOOK_HEADERS: JSON.stringify({ Authorization: "Bearer e2e" }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  let err = "";
  (async () => {
    for await (const chunk of child.stdout) out += new TextDecoder().decode(chunk);
  })();
  (async () => {
    for await (const chunk of child.stderr) err += new TextDecoder().decode(chunk);
  })();
  const connected = await waitFor(() => /\[earshot\] hello/.test(err), 20_000);
  const via = err.match(/connected "(\w+)"/)?.[1] ?? "none";
  const nonce = `earshot-e2e-${transport}-${crypto.randomUUID().slice(0, 8)}`;
  const sentAt = Date.now();
  const posted = connected ? await slack("chat.postMessage", { channel: me, text: nonce }) : undefined;
  const onStdout = connected && (await waitFor(() => out.includes(nonce), 15_000));
  const latency = Date.now() - sentAt;
  const onHook = await waitFor(
    () => hooked.some((h) => h.text === nonce && h.auth === "Bearer e2e"),
    5_000,
  );
  child.kill();
  if (posted)
    await slack("chat.delete", { channel: String(posted.channel), ts: String(posted.ts) }).catch(
      () => {},
    );
  const ok = connected && onStdout && onHook && via === transport;
  failed ||= !ok;
  console.log(
    `${ok ? "PASS" : "FAIL"} transport=${transport} connected_via=${via} stdout=${onStdout} webhook=${onHook} latency_ms=${latency}`,
  );
  if (!ok) console.log(err.replaceAll(token, "<xoxc>"));
}

const bogus = Bun.spawn(["bun", "src/cli.ts"], {
  env: { ...process.env, SLACK_XOXC: "xoxc-0-0-0-0", SLACK_XOXD: "xoxd-0" },
  stdout: "ignore",
  stderr: "pipe",
});
const code = await Promise.race([bogus.exited, Bun.sleep(20_000).then(() => "timeout")]);
if (code === "timeout") bogus.kill();
const authOk = code === 2;
failed ||= !authOk;
console.log(`${authOk ? "PASS" : "FAIL"} bogus session exit_code=${code}`);

server.stop(true);
process.exit(failed ? 1 : 0);
