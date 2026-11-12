// Edge cases: (1) concrete inputs to try on a function, (2) a readable catalogue of what can go wrong per endpoint.
import { encode } from "./serialize.js";

const LONG = "x".repeat(201);
const VALUES = {
  string: ["", " ", "a", "hello world", LONG, "   padded   ", "<script>alert(1)</script>", "'; DROP TABLE todos;--", "ñandú 🚀", "0", "null", "line1\nline2"],
  email: ["a@b.co", "A@B.CO", " a@b.co ", "not-an-email", "@", "a@b", "", "a@b.co" + "m".repeat(260)],
  number: [0, 1, -1, 1.5, NaN, Infinity, -Infinity, 2147483647, 2147483648, 9007199254740992, "5", "abc", "", null, undefined],
  id: [1, 0, -1, "1", "abc", "", "1.5", "2147483648", "9999999999999999999", "1; DROP", "00001", null, undefined],
  boolean: [true, false, 0, 1, "true", "false", null, undefined],
  array: [[], [1], [1, 2, 3], [null], [[]], "text", null, undefined],
  object: [{}, { a: 1 }, null, undefined, [], "text", 5],
  unknown: [undefined, null, 0, 1, -1, "", "a", true, false, {}, []],
};
const TYPICAL = { string: "hello", email: "a@b.co", number: 5, id: 1, boolean: true, array: [1, 2, 3], object: {}, unknown: "a", rest: undefined };
const sampleFor = (f) => (/title|name|text|label|desc/i.test(f) ? "sample" : /done|is_|has_|enabled|active|flag/i.test(f) ? true : /id$/i.test(f) ? 1 : /count|limit|offset|age|total|qty/i.test(f) ? 3 : /email/i.test(f) ? "a@b.co" : "value");

function objectVariants(unit, p) {
  const keys = p.keys?.length ? p.keys : unit.fields || [];
  if (!keys.length) return [];
  const full = Object.fromEntries(keys.map((k) => [k, sampleFor(k)]));
  const out = [{ v: full, note: "all fields present" }];
  for (const k of keys.slice(0, 6)) {
    const { [k]: _drop, ...rest } = full; out.push({ v: rest, note: `${k} missing` });
    out.push({ v: { ...full, [k]: null }, note: `${k} = null` });
    out.push({ v: { ...full, [k]: typeof full[k] === "string" ? 123 : "not-a-" + typeof full[k] }, note: `${k} wrong type` });
    if (typeof full[k] === "string") out.push({ v: { ...full, [k]: LONG }, note: `${k} too long` }, { v: { ...full, [k]: "   " }, note: `${k} blank` });
  }
  return out;
}

// Concrete argument lists to run: the typical call, then every parameter varied one at a time.
export function unitInputs(unit, cap = 90) {
  const ps = unit.params.filter((p) => p.kind !== "rest");
  const base = ps.map((p) => (p.kind === "object" && (p.keys?.length || unit.fields?.length) ? objectVariants(unit, p)[0].v : TYPICAL[p.kind] ?? "a"));
  const cases = [{ label: "typical input", args: base }];
  if (ps.length) cases.push({ label: "no arguments", args: [] });
  // boundary-value analysis: probe at, just below and just above every threshold/constant the function itself uses
  const K = unit.constants || { numbers: [], strings: [], lengths: [] };
  const boundaryFor = (p) => {
    const out = [];
    if (["number", "id", "unknown", "string"].includes(p.kind)) for (const c of K.numbers) { const eps = Number.isInteger(c) ? 1 : 0.001; for (const v of [c - eps, c, c + eps]) out.push({ v, note: `${p.name} = ${v} (boundary ${c})` }); if (Math.abs(c) < 1e9) out.push({ v: c * 2, note: `${p.name} = ${c * 2}` }); }
    if (["string", "unknown", "email"].includes(p.kind)) {
      for (const L of K.lengths) for (const len of [L - 1, L, L + 1]) if (len >= 0) out.push({ v: "x".repeat(len), note: `${p.name}: ${len} characters (limit ${L})` });
      for (const str of K.strings) out.push({ v: str, note: `${p.name} = ${JSON.stringify(str)} (value the code checks for)` });
    }
    return out;
  };
  ps.forEach((p, i) => {
    for (const { v, note } of boundaryFor(p)) { const args = base.slice(); args[i] = v; cases.push({ label: note, args }); }
  });
  ps.forEach((p, i) => {
    const variants = p.kind === "object" ? [...objectVariants(unit, p).slice(1).map((x) => ({ v: x.v, note: x.note })), ...VALUES.object.map((v) => ({ v }))] : (VALUES[p.kind] || VALUES.unknown).map((v) => ({ v }));
    for (const { v, note } of variants) {
      const args = base.slice(); args[i] = v;
      cases.push({ label: note ? `${p.name}: ${note}` : `${p.name} = ${preview(v)}`, args });
    }
  });
  const seen = new Set(), out = [];
  for (const c of cases) { const k = JSON.stringify(encode(c.args)); if (!seen.has(k)) { seen.add(k); out.push({ label: c.label, args: encode(c.args) }); } }
  return out.slice(0, cap);
}
export function preview(v) {
  if (v === undefined) return "undefined"; if (typeof v === "number") return String(v); if (typeof v === "string") return JSON.stringify(v.length > 24 ? v.slice(0, 21) + "…" : v);
  try { const s = JSON.stringify(v); return s.length > 28 ? s.slice(0, 25) + "…" : s; } catch { return String(v); }
}

// Human-readable edge cases for a function (shown in the UI and the report)
export function unitEdgeCases(unit) {
  const out = [];
  for (const c of (unit.conditions || []).slice(0, 8)) out.push({ category: "Branch", title: `Cover both outcomes of \`${c}\``, expect: "review" });
  for (const p of unit.params) {
    const k = p.kind;
    if (k === "string" || k === "email") out.push({ category: "Boundary", title: `${p.name}: empty, whitespace-only, 200+ characters, emoji/unicode, HTML/SQL metacharacters`, expect: "review" });
    if (k === "number") out.push({ category: "Boundary", title: `${p.name}: 0, negative, fractional, NaN, Infinity, above 2³¹, numeric string`, expect: "review" });
    if (k === "id") out.push({ category: "Boundary", title: `${p.name}: 0, negative, non-numeric, overflow, "1; DROP", leading zeros`, expect: "review" });
    if (k === "boolean") out.push({ category: "Type", title: `${p.name}: truthy/falsy non-booleans ("true", 0, 1, null)`, expect: "review" });
    if (k === "array") out.push({ category: "Boundary", title: `${p.name}: empty, one item, null entries, nested arrays, not an array`, expect: "review" });
    if (k === "object") out.push({ category: "Shape", title: `${p.name}: {}, null, missing / null / wrong-typed fields${p.keys?.length ? ` (${p.keys.slice(0, 4).join(", ")})` : ""}`, expect: "review" });
    if (k === "unknown") out.push({ category: "Type", title: `${p.name}: undefined, null and unexpected types`, expect: "review" });
  }
  if (unit.params.length) out.push({ category: "Type", title: "Called with no arguments", expect: "review" });
  if (unit.throws) out.push({ category: "Errors", title: "Inputs that make it throw: check the error type and message", expect: "review" });
  if (unit.async) out.push({ category: "Async", title: "Rejection path and (if it calls anything slow) timeout behaviour", expect: "review" });
  if (unit.nondeterministic) out.push({ category: "Determinism", title: "Uses time or randomness: inject a clock/seed so results are repeatable", expect: "review" });
  return out;
}

// Catalogue of what can go wrong for an endpoint. `auto` = the generator writes a test for it.
export function routeEdgeCases(r) {
  const out = [];
  const add = (category, title, expect, auto = false) => out.push({ category, title, expect, auto });
  const m = r.method, hasId = /:\w+/.test(r.path), has = (n) => r.statuses.includes(n);
  const fields = r.bodyFields || [];
  if (r.auth) { add("Auth", "No credentials → rejected", "401", true); add("Auth", "Malformed Authorization header → rejected", "401", true); add("Auth", "Tampered / expired token → rejected", "401"); add("Auth", "Valid token for a different app or role → 403 (no privilege escalation)", "403"); }
  if (m === "GET" && !hasId) {
    add("Shape", "Returns JSON with the documented shape (empty and non-empty result)", "200", true);
    for (const q of r.queryFields.length ? r.queryFields : []) add("Query", `\`${q}\`: empty value, special characters, repeated parameter, extremely long value`, "review");
    if (r.queryFields.some((q) => /limit|size|page/i.test(q))) { add("Pagination", "limit = 0, −1, 1000000 or non-numeric → clamped or 400, never a crash", "review", true); add("Pagination", "offset = −5, 999999999 → empty page, not an error", "review"); }
    if (r.queryFields.some((q) => /done|active|status|filter/i.test(q))) add("Filter", "Filter values that match nothing / invalid values", "review");
  }
  if (hasId) {
    add("Not found", "ID that does not exist → 404", has(404) ? "404" : "4xx", true);
    add("Boundary", "ID = 0, −1, \"abc\", \"1.5\", 2³¹, 20-digit number → 400 (not 500)", has(400) ? "400" : "4xx", true);
    add("Security", "SQL/NoSQL metacharacters in the ID (`1; DROP TABLE`) → rejected, not executed", "4xx", true);
    if (m === "GET" || m === "DELETE") add("Authorization", "Resource owned by another user → 403/404 (no IDOR)", "review");
  }
  if (["POST", "PUT", "PATCH"].includes(m)) {
    add("Validation", "Empty body `{}` → 400", has(400) ? "400" : "4xx", true);
    add("Validation", "Malformed JSON → 400 (not 500)", has(400) ? "400" : "4xx", true);
    add("Validation", "Wrong Content-Type (text/plain) → 4xx", "4xx");
    for (const f of fields.slice(0, 5)) { add("Validation", `\`${f}\`: missing, null, wrong type, blank, 200+ characters`, "4xx", true); }
    add("Security", "Unknown/privileged fields (`id`, `user_id`, `is_admin`) are ignored (mass assignment)", "review", true);
    add("Security", "HTML/script payload is stored safely and returned escaped", "review");
    add("Unicode", "Emoji / right-to-left / very long unicode text", "review");
    add("Limits", "Body larger than the size limit → 413", "review");
    if (m === "POST") { add("Idempotency", "Submitting the same request twice (double click / retry)", "review", true); add("Concurrency", "20 parallel creates: no lost or duplicated rows", "review"); }
    else add("Concurrency", "Two simultaneous updates: no lost update", "review");
    if (m !== "POST") add("State", "Partial update leaves the other fields untouched", "200", true);
  }
  if (m === "DELETE") { add("Idempotency", "Deleting twice → second call is 404 (or 204), never 500", "404", true); add("State", "After delete, GET of the same ID → 404", "404", true); }
  add("Protocol", "Unsupported method (e.g. PATCH on a read-only route) → 405, never 500", "405");
  add("Errors", "No stack trace or internal details in error responses", "review", true);
  add("Headers", "Content-Type is application/json on success and on error", "200", true);
  if (has(429) || r.path.includes("login")) add("Abuse", "Rate limit / lockout after repeated failures → 429", "429");
  return out;
}
