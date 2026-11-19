export type DeliverOptions = {
  headers?: Record<string, string>;
  attempts?: number;
  delayMs?: number;
  timeoutMs?: number;
};

export async function deliver(url: string, payload: unknown, options: DeliverOptions = {}) {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 1000;
  let failure = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...options.headers },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      if (response.ok) return;
      failure = `http_${response.status}`;
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) await Bun.sleep(delayMs * 2 ** (attempt - 1));
  }
  throw new Error(`webhook failed: ${failure}`);
}

export function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((value) => typeof value === "string")
  )
    throw new Error("WEBHOOK_HEADERS must be a JSON object of string values");
  return parsed as Record<string, string>;
}
