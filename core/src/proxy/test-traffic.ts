import { setTimeout as sleep } from "node:timers/promises";

/**
 * `tokentriage test-traffic` — the non-technical path to a live demo: sends a
 * handful of tiny real requests THROUGH the local capture proxy so findings
 * appear on the watch dashboard. Uses the user's own key; defaults to Haiku
 * so the whole run costs well under one cent. The shared system prompt is
 * deliberate: 12 uncached repeats is exactly what the cache-miss analyzer
 * needs to fire.
 */
export interface TestTrafficOptions {
  proxyUrl: string;
  apiKey: string;
  requests: number;
  model: string;
  log?: (line: string) => void;
}

export async function sendTestTraffic(options: TestTrafficOptions): Promise<{ ok: number; failed: number }> {
  const log = options.log ?? (() => {});
  let ok = 0;
  let failed = 0;

  for (let i = 1; i <= options.requests; i++) {
    try {
      const res = await fetch(`${options.proxyUrl.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
          "x-tokentriage-service": "test-traffic",
        },
        body: JSON.stringify({
          model: options.model,
          max_tokens: 100,
          system: "You are a haiku bot. Always reply with exactly one short haiku.",
          messages: [{ role: "user", content: `haiku number ${i} about the seasons` }],
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { content?: { text?: string }[] };
        const text = data.content?.[0]?.text?.replace(/\s+/g, " ").slice(0, 60) ?? "(no text)";
        log(`  [${i}/${options.requests}] ok — "${text}"`);
        ok++;
      } else {
        const errText = (await res.text()).slice(0, 200);
        log(`  [${i}/${options.requests}] provider returned ${res.status}: ${errText}`);
        failed++;
        if (res.status === 401) break; // bad key — no point repeating
      }
    } catch (err) {
      log(`  [${i}/${options.requests}] failed: ${(err as Error).message}`);
      failed++;
      break; // proxy unreachable — stop immediately
    }
    await sleep(150); // gentle pacing
  }
  return { ok, failed };
}
