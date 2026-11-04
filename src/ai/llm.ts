import Anthropic from "@anthropic-ai/sdk";

/**
 * LLM client used by every AI step (mandate parsing, product reasoning, photo reading,
 * merchant agent, verdict explanations).
 *
 * Providers (pick with AI_PROVIDER, or leave unset to auto-detect):
 *   anthropic  - Claude via the official Anthropic SDK (ANTHROPIC_API_KEY). Default model claude-opus-5-5.
 *   gemini / groq / openrouter - free-tier alternatives via their OpenAI-compatible APIs (AI_API_KEY).
 * AI_MODEL overrides the model for any provider.
 *
 * Every call returns `null` on any failure (no key, rate limit, refusal, bad JSON). Callers ALWAYS
 * have a deterministic fallback, so the demo never breaks because of the AI provider.
 */

const COMPAT: Record<string, { baseUrl: string; defaultModel: string }> = {
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-2.5-flash" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", defaultModel: "meta-llama/llama-4-scout-17b-16e-instruct" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", defaultModel: "google/gemini-2.5-flash" },
};
const CLAUDE_DEFAULT_MODEL = "claude-opus-5-5";

export interface LlmStatus {
  provider: string;
  model: string;
  enabled: boolean;
  calls: number;
  lastError?: string;
}

const status: LlmStatus = { provider: "none", model: "", enabled: false, calls: 0 };

function config(): { provider: string; model: string; key: string } | null {
  const explicit = (process.env.AI_PROVIDER ?? "").trim().toLowerCase();
  const provider = explicit || (process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.AI_API_KEY ? "gemini" : "none");
  const key = provider === "anthropic" ? process.env.ANTHROPIC_API_KEY ?? "" : process.env.AI_API_KEY ?? "";
  const model = process.env.AI_MODEL || (provider === "anthropic" ? CLAUDE_DEFAULT_MODEL : COMPAT[provider]?.defaultModel ?? "");
  status.provider = provider;
  status.model = model;
  status.enabled = Boolean(key && (provider === "anthropic" || COMPAT[provider]));
  return status.enabled ? { provider, model, key } : null;
}

export function llmStatus(): LlmStatus {
  config();
  return { ...status };
}

/* ------------------------------------------ Claude ------------------------------------------ */

let anthropic: Anthropic | undefined;

type ImageMedia = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

async function callClaude(model: string, system: string, user: string, imageDataUrl?: string): Promise<string | null> {
  anthropic ??= new Anthropic(); // reads ANTHROPIC_API_KEY
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (imageDataUrl) {
    const m = imageDataUrl.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/);
    if (!m) {
      status.lastError = "Unsupported image format (use PNG, JPEG, GIF or WebP).";
      return null;
    }
    content.push({ type: "image", source: { type: "base64", media_type: m[1] as ImageMedia, data: m[2] } });
  }
  content.push({ type: "text", text: user });

  try {
    const res = await anthropic.beta.messages.create({
      model,
      max_tokens: 16000,
      // Short, simple tasks: low effort keeps latency and cost down.
      output_config: { effort: "low" },
      // If a safety classifier declines, retry on a fallback model chosen by the API.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      messages: [{ role: "user", content }],
    });
    status.calls++;
    if (res.stop_reason === "refusal") {
      status.lastError = `Refused (${res.stop_details?.category ?? "unknown"})`;
      return null;
    }
    status.lastError = undefined;
    return res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim() || null;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) status.lastError = "Invalid ANTHROPIC_API_KEY";
    else if (e instanceof Anthropic.RateLimitError) status.lastError = "Rate limited by Anthropic";
    else if (e instanceof Anthropic.APIError) status.lastError = `Anthropic API ${e.status}: ${e.message}`;
    else status.lastError = String(e);
    return null;
  }
}

/* ------------------------------ OpenAI-compatible free tiers ------------------------------ */

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

async function callCompat(provider: string, model: string, key: string, system: string, user: string, imageDataUrl: string | undefined, json: boolean): Promise<string | null> {
  const p = COMPAT[provider];
  const content: string | Part[] = imageDataUrl ? [{ type: "text", text: user }, { type: "image_url", image_url: { url: imageDataUrl } }] : user;
  try {
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content }],
        ...(json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json()) as any;
    status.calls++;
    if (!res.ok) {
      status.lastError = `${res.status}: ${JSON.stringify(body).slice(0, 300)}`;
      return null;
    }
    status.lastError = undefined;
    return body.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    status.lastError = String(e);
    return null;
  }
}

/* ------------------------------------------ Public API ------------------------------------------ */

async function ask(system: string, user: string, imageDataUrl: string | undefined, json: boolean): Promise<string | null> {
  const c = config();
  if (!c) return null;
  return c.provider === "anthropic"
    ? callClaude(c.model, system, user, imageDataUrl)
    : callCompat(c.provider, c.model, c.key, system, user, imageDataUrl, json);
}

/** Ask for a JSON object. Returns null if the provider is off, fails, or returns invalid JSON. */
export async function askJson<T>(system: string, user: string, imageDataUrl?: string): Promise<T | null> {
  const out = await ask(`${system}\nRespond with a single JSON object only, no prose and no code fences.`, user, imageDataUrl, true);
  if (!out) return null;
  const raw = out.match(/\{[\s\S]*\}/)?.[0] ?? out;
  try {
    return JSON.parse(raw) as T;
  } catch {
    status.lastError = "Invalid JSON from model";
    return null;
  }
}

/** Ask for short plain text. Returns null on failure. */
export async function askText(system: string, user: string): Promise<string | null> {
  const out = await ask(`${system}\nWrite plain text only: no markdown, no asterisks, no backticks, no headings.`, user, undefined, false);
  return out?.replace(/\*\*|`/g, "") ?? null;
}
