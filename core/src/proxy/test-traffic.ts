import { setTimeout as sleep } from "node:timers/promises";

/**
 * `tokentriage test-traffic` — the non-technical path to a live demo: sends a
 * handful of real requests THROUGH the local capture proxy so findings appear
 * on the watch dashboard. Uses the user's own key; defaults to Haiku so the
 * whole run costs a few cents.
 *
 * The requests deliberately mimic a real app's wasteful shape: the same large
 * (~4K-token) uncached system prompt on every call. That matters because the
 * analyzers refuse to flag waste under one cent — tiny one-line prompts are
 * (correctly) reported as "nothing significant to fix". Realistic size +
 * >=10 repeats is what makes the cache-miss finding fire.
 */
export interface TestTrafficOptions {
  proxyUrl: string;
  apiKey: string;
  requests: number;
  model: string;
  log?: (line: string) => void;
}

// ~16K characters ≈ 4K tokens — the size of a real support bot's system
// prompt with product docs stuffed in. Identical on every call (uncached) =
// the textbook cache-miss pattern.
const FILLER =
  "You handle customer questions about orders, refunds, shipping, returns, inventory, " +
  "and billing. Always consult the product knowledge base before answering, cite the " +
  "relevant policy section, and keep a warm, professional tone. Escalate to a human " +
  "when the customer asks for one or mentions legal action. ";

function buildSystemPrompt(): string {
  let prompt =
    "You are a haiku bot for the Meridian Labs support team. Always reply with exactly one short haiku.\n\n" +
    "Background context (static team handbook, identical on every request):\n";
  while (prompt.length < 16_000) prompt += FILLER;
  return prompt;
}

const SYSTEM_PROMPT = buildSystemPrompt();

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
          system: SYSTEM_PROMPT,
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
