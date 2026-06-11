import type { AnalysisResult } from "../core/engine.js";

/**
 * Optional --narrate: the ONLY network call in TokenTriage, off by default.
 * Sends AGGREGATED FINDINGS ONLY (never raw logs, never prompt content) to
 * the user's own key (TOKENTRIAGE_LLM_KEY) to generate a 3-paragraph
 * executive summary.
 */
export async function generateNarrative(result: AnalysisResult): Promise<string> {
  const apiKey = process.env.TOKENTRIAGE_LLM_KEY;
  if (!apiKey) {
    throw new Error(
      "--narrate requires TOKENTRIAGE_LLM_KEY to be set (your own Anthropic or OpenAI API key)."
    );
  }

  const aggregated = {
    period_days: result.daysInDataset,
    requests: result.requestCount,
    total_spend_usd: Math.round(result.totalSpend * 100) / 100,
    addressable_waste_usd: Math.round(result.addressableWaste * 100) / 100,
    findings: result.findings.map((f) => ({
      name: f.analyzer_name,
      wasted_usd: Math.round(f.wasted_usd * 100) / 100,
      pct_of_total_spend: Math.round(f.pct_of_total * 1000) / 10,
      projected_monthly_savings_usd: Math.round(f.projected_monthly_savings_usd),
      confidence: f.confidence,
      upper_bound: f.upper_bound ?? false,
      fix_summary: f.fix.summary,
    })),
  };

  const prompt = `You are writing the executive summary for an LLM API cost audit. Using ONLY the aggregated findings below, write exactly 3 short paragraphs of plain prose (no headers, no bullets) for a non-technical budget owner: (1) total spend and how much is avoidable, (2) the biggest one or two drivers and their concrete monthly savings, (3) what to do first. Use approximate dollar figures. Be direct, no hedging beyond what confidence labels require.\n\n${JSON.stringify(aggregated, null, 2)}`;

  if (apiKey.startsWith("sk-ant-")) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { content: { type: string; text?: string }[] };
    return data.content.map((b) => b.text ?? "").join("");
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0]?.message.content ?? "";
}
