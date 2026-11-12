import { z } from "zod";

export const SYSTEM = `You are a senior software engineer who writes sharp tests and finds real bugs. You review ONE target at a time (a function or an HTTP endpoint) from a JavaScript project.

How your output is used:
- Everything you claim is CHECKED BY EXECUTION. Inputs you propose are run in a sandbox; the real result is compared with what you say a correct implementation should do. A claim the code already satisfies is discarded. Wrong claims cost the reader time, so report only what you can demonstrate with a concrete input and a concrete expected output.
- It is fine, and often right, to report no findings. Do not invent problems. Behaviour that is a reasonable design choice is not a bug.
- Prefer a few correct, high-value items over many speculative ones.

Writing test inputs (args_expr, value_expr):
- Each is ONE JavaScript expression, evaluated in an empty sandbox. args_expr must evaluate to an ARRAY of the function's arguments, e.g. [5, "x"] or [new Uint32Array(520).fill(2), 95].
- Allowed: literals, arrays, objects, template strings, arithmetic/logic, new Map/Set/Date/Uint32Array/Float64Array/..., Array.from, Array(n).fill(x), "x".repeat(n), Math.*, JSON.*, simple arrow functions with expression bodies.
- Forbidden: statements, function bodies with braces, require/import/process/fetch/eval, any identifier not built into JavaScript. Keep each expression under 600 characters.
- Build REALISTIC structured inputs (nested objects, arrays of records, typed arrays of counts) that exercise the code's branches. Generic values are already covered; your value is domain knowledge.

Findings: severity "bug" = wrong behaviour you are confident about; "suspicious" = likely unintended. expect.kind "returns" with value_expr (the value a correct implementation returns), or "throws" with error_name. Use "" for fields that do not apply.`;

export const UnitReview = z.object({
  purpose: z.string(),
  findings: z.array(z.object({
    severity: z.enum(["bug", "suspicious"]), title: z.string(), explanation: z.string(), args_expr: z.string(),
    expect: z.object({ kind: z.enum(["returns", "throws"]), value_expr: z.string(), error_name: z.string() }),
  })),
  extra_cases: z.array(z.object({ label: z.string(), args_expr: z.string(), why: z.string() })),
});

export const RouteReview = z.object({
  summary: z.string(),
  valid_body_json: z.string(),
  cases: z.array(z.object({
    title: z.string(), method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), path: z.string(), query: z.string(), body_json: z.string(),
    expect_status: z.number().int(), needs_record: z.boolean(), rationale: z.string(),
  })),
});

const lines = (arr) => arr.filter(Boolean).join("\n");

export function unitPrompt(unit, behaviours, maxExtra) {
  return lines([
    "UNIT REVIEW", `File: ${unit.file}:${unit.line}`, `Function: ${unit.name}(${unit.params.map((p) => p.name).join(", ")})${unit.async ? "  [async]" : ""}`, "",
    "Source (with the helpers and constants it depends on):", "```js", unit.extractSource, "```", "",
    unit.constants?.numbers?.length ? `Numbers written in the function: ${unit.constants.numbers.join(", ")}` : "",
    "Observed behaviour. These inputs were already run against the real code (do not repeat them):",
    ...behaviours.map((b, i) => `  ${i + 1}. ${b}`), "",
    "Tasks:",
    "1. purpose: what is this function for? (one or two sentences)",
    `2. findings: real bugs or suspicious behaviour, each with a concrete args_expr and what a CORRECT implementation would return or throw. Empty list if the behaviour looks right.`,
    `3. extra_cases: up to ${maxExtra} additional inputs that exercise branches the observed inputs missed (use realistic structured data), with a short reason. Do not include expected values: they will be recorded from the real code.`,
  ]);
}

export function routePrompt(r, helpers, maxCases) {
  return lines([
    "ENDPOINT REVIEW", `Route: ${r.method} ${r.path}   (${r.file}:${r.line})`,
    `Status codes seen in the code: ${r.statuses.join(", ") || "unknown"}${r.auth ? "   · protected by auth" : ""}${r.bodyFields.length ? `   · body fields: ${r.bodyFields.join(", ")}` : ""}${r.queryFields.length ? `   · query: ${r.queryFields.join(", ")}` : ""}`, "",
    "Handler:", "```js", r.code || "(handler source not available)", "```",
    ...helpers.flatMap((h) => ["", `Helper it calls: ${h.name}() from ${h.file}`, "```js", h.code, "```"]), "",
    "Tasks:",
    "1. summary: what does this endpoint do and what rules does it enforce?",
    "2. valid_body_json: a JSON object (as text) that this endpoint accepts as valid, or \"\" if it takes no body.",
    `3. cases: up to ${maxCases} HTTP test cases that check the RULES (exact boundaries such as the longest accepted value and one character more, required vs optional fields, type checks, not-found, state changes). Use the route path with :params left in place; give body_json as JSON text ("" if none), query as "a=1&b=2" ("" if none), the exact expect_status the code's rules imply, needs_record=true if the case needs an existing record (the runner creates one and fills :id), and a one-line rationale. Do not assume data that may not exist. Skip cases that are only guesses.`,
  ]);
}
