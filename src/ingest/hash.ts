import { createHash } from "node:crypto";

/**
 * PRIVACY: prompt/response bodies are hashed IN MEMORY and immediately
 * discarded. Only the hash (and token counts) survive into the canonical
 * record. Bodies are never written to disk, cache, or report.
 */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** Extract + hash the system prompt and full prompt from a chat request body. */
export function hashRequestBody(body: unknown): {
  system_prompt_hash: string | null;
  full_prompt_hash: string | null;
  max_tokens_set: boolean | null;
} {
  if (!body || typeof body !== "object") {
    return { system_prompt_hash: null, full_prompt_hash: null, max_tokens_set: null };
  }
  const b = body as Record<string, unknown>;

  let systemText: string | null = null;
  if (typeof b.system === "string") {
    systemText = b.system;
  } else if (Array.isArray(b.system)) {
    systemText = b.system
      .map((blk) => (typeof blk === "object" && blk && "text" in blk ? String((blk as { text: unknown }).text) : ""))
      .join("\n");
  } else if (Array.isArray(b.messages)) {
    const sys = (b.messages as Record<string, unknown>[]).find((m) => m.role === "system");
    if (sys && typeof sys.content === "string") systemText = sys.content;
  }

  const fullText = JSON.stringify(b.messages ?? b.prompt ?? b);
  const maxTokensSet =
    "max_tokens" in b || "max_completion_tokens" in b || "max_output_tokens" in b ? true : false;

  return {
    system_prompt_hash: systemText ? sha256(systemText) : null,
    full_prompt_hash: fullText ? sha256(fullText) : null,
    max_tokens_set: maxTokensSet,
  };
}
