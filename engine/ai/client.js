// Thin wrapper over the official Anthropic SDK: structured (schema-validated) JSON answers, typed error handling.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

// $ per million tokens (input / output). Opus 5.5 is the default: test review is a reasoning-heavy task.
export const MODELS = {
  "claude-opus-5-5": { label: "Claude Opus 5.5 (best quality)", in: 4, out: 20 },
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5 (balanced)", in: 2, out: 10 },
  "claude-haiku-5-5": { label: "Claude Haiku 5.5 (cheapest)", in: 0.1, out: 0.5 },
};
export const DEFAULT_MODEL = "claude-opus-5-5";
export const costOf = (modelId, usage) => { const m = MODELS[modelId]; return m && usage ? ((usage.input_tokens || 0) * m.in + (usage.cache_read_input_tokens || 0) * m.in * 0.1 + (usage.cache_creation_input_tokens || 0) * m.in * 1.25 + (usage.output_tokens || 0) * m.out) / 1e6 : 0; };

// Credentials: the key typed into the UI wins; otherwise the SDK resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / a login profile.
export const hasServerCredentials = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
export function aiClient({ apiKey } = {}) {
  return new Anthropic({ ...(apiKey ? { apiKey } : {}), maxRetries: 2, timeout: 180_000 });
}

// Plain-language message for the typed SDK errors (never includes the key)
export function explainError(e) {
  if (e instanceof Anthropic.AuthenticationError) return "The API key was rejected. Check it (or ANTHROPIC_API_KEY on the server).";
  if (e instanceof Anthropic.PermissionDeniedError) return "This key is not allowed to use that model.";
  if (e instanceof Anthropic.RateLimitError) return "Rate limited by the API. Try again in a minute, or review fewer targets.";
  if (e instanceof Anthropic.NotFoundError) return "The model was not found for this account. Pick another model.";
  if (e instanceof Anthropic.BadRequestError) return "The API rejected the request: " + String(e.message).slice(0, 160);
  if (e instanceof Anthropic.APIConnectionError) return "Could not reach the API. Check your internet connection.";
  if (e instanceof Anthropic.APIError) return `API error ${e.status}: ${String(e.message).slice(0, 160)}`;
  return String(e?.message || e).slice(0, 200);
}

// One structured request. Returns { data, usage } or { skip: "reason", usage }.
export async function askStructured({ client, model, system, user, schema, effort = "medium", maxTokens = 16000 }) {
  const res = await client.messages.parse({
    model, max_tokens: maxTokens,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], // identical for every call → cached after the first
    messages: [{ role: "user", content: user }],
    output_config: { effort, format: zodOutputFormat(schema) },
  });
  const usage = res.usage;
  if (res.stop_reason === "refusal") return { skip: `the model declined${res.stop_details?.category ? ` (${res.stop_details.category})` : ""}`, usage };
  if (res.stop_reason === "max_tokens") return { skip: "the answer was cut off (too long)", usage };
  if (!res.parsed_output) return { skip: "the answer did not match the expected format", usage };
  return { data: res.parsed_output, usage };
}
