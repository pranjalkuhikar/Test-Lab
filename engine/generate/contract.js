// Contract tests need to know the REAL response shapes, so they are inferred by probing a running app with safe GET requests.
// Output: schema tests + Pact v3 contract files + a verifier that replays the pacts against the provider.
import { flavor, header, q, slug, envName } from "./util.js";

const TIMEOUT = 5000;
const SKIP = /^\/(metrics|_next)/;

// ---------------------------------------------------------------- probing (GET only: never changes data)
export async function probeApp(model, baseUrl, token) {
  const results = new Map();
  const get = async (path) => {
    try {
      const res = await fetch(baseUrl.replace(/\/$/, "") + path, { headers: token ? { authorization: `Bearer ${token}` } : {}, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT) });
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch {}
      return { status: res.status, contentType: res.headers.get("content-type") || "", json, size: text.length };
    } catch (e) { return { error: e.message }; }
  };
  const gets = model.routes.filter((r) => r.method === "GET" && !SKIP.test(r.path));
  for (const r of gets.filter((x) => !/:\w+/.test(x.path))) results.set(`${r.service}|${r.path}`, { route: r, ...(await get(r.path)) });
  for (const r of gets.filter((x) => /:\w+/.test(x.path))) {
    const parent = results.get(`${r.service}|${r.path.replace(/\/:\w+\*?$/, "")}`);
    const arr = Array.isArray(parent?.json) ? parent.json : Array.isArray(parent?.json?.data) ? parent.json.data : Array.isArray(parent?.json?.items) ? parent.json.items : null;
    const id = arr?.[0]?.id;
    if (id === undefined) { results.set(`${r.service}|${r.path}`, { route: r, skipped: "no sample id (the list is empty or needs auth)" }); continue; }
    results.set(`${r.service}|${r.path}`, { route: r, sampleId: id, ...(await get(r.path.replace(/:\w+\*?/, encodeURIComponent(id)))) });
  }
  return results;
}

// ---------------------------------------------------------------- schema inference
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
export function infer(v, depth = 0) {
  const t = typeOf(v);
  if (depth > 5) return { type: t === "integer" ? "number" : t };
  if (t === "array") return { type: "array", items: v.length ? v.slice(0, 5).map((x) => infer(x, depth + 1)).reduce(merge) : null };
  if (t === "object") return { type: "object", required: Object.keys(v), properties: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, infer(x, depth + 1)])) };
  return { type: t === "integer" ? "number" : t };
}
function merge(a, b) {
  if (!a) return b; if (!b) return a;
  if (a.type === "object" && b.type === "object") {
    const keys = new Set([...Object.keys(a.properties), ...Object.keys(b.properties)]);
    return { type: "object", required: a.required.filter((k) => b.required.includes(k)), properties: Object.fromEntries([...keys].map((k) => [k, merge(a.properties[k], b.properties[k])])) };
  }
  if (a.type === "array" && b.type === "array") return { type: "array", items: merge(a.items, b.items) };
  if (a.type === b.type) return a;
  return { type: [...new Set([].concat(a.type, b.type))] };
}

// ---------------------------------------------------------------- Pact v3 matching rules from a sample body
function pactRules(v, path = "$", out = {}, depth = 0) {
  if (depth > 4 || Object.keys(out).length > 40) return out;
  if (Array.isArray(v)) { out[path] = { combine: "AND", matchers: [{ match: "type", min: 0 }] }; if (v.length) pactRules(v[0], `${path}[*]`, out, depth + 1); }
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { const p = /^[\w$]+$/.test(k) ? `${path}.${k}` : `${path}['${k}']`; if (x && typeof x === "object") pactRules(x, p, out, depth + 1); else out[p] = { combine: "AND", matchers: [{ match: x === null ? "null" : "type" }] }; }
  return out;
}

export const SCHEMA_HELPER = `// Minimal JSON-schema-style validator for the contract tests (no dependencies).
export function validate(value, schema, path = "$") {
  const errors = [];
  const types = [].concat(schema.type);
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (!types.includes(actual)) { errors.push(\`\${path}: expected \${types.join(" | ")} but got \${actual}\`); return errors; }
  if (actual === "object" && schema.properties) {
    for (const key of schema.required || []) if (!(key in value)) errors.push(\`\${path}.\${key}: required field is missing\`);
    for (const [key, sub] of Object.entries(schema.properties)) if (key in value) errors.push(...validate(value[key], sub, \`\${path}.\${key}\`));
  }
  if (actual === "array" && schema.items) value.slice(0, 20).forEach((item, i) => errors.push(...validate(item, schema.items, \`\${path}[\${i}]\`)));
  return errors;
}
// Does \`actual\` have the same shape/types as \`expected\`? (used when replaying Pact files)
export function sameShape(expected, actual, path = "$") {
  const errors = [];
  const te = expected === null ? "null" : Array.isArray(expected) ? "array" : typeof expected;
  const ta = actual === null ? "null" : Array.isArray(actual) ? "array" : typeof actual;
  if (te !== ta) return [\`\${path}: expected \${te} but got \${ta}\`];
  if (te === "array" && expected.length && actual.length) actual.slice(0, 10).forEach((x, i) => errors.push(...sameShape(expected[0], x, \`\${path}[\${i}]\`)));
  if (te === "object") for (const k of Object.keys(expected)) { if (!(k in actual)) errors.push(\`\${path}.\${k}: missing\`); else errors.push(...sameShape(expected[k], actual[k], \`\${path}.\${k}\`)); }
  return errors;
}
`;

export function contractFiles(model, probes, fl, opts = {}) {
  const f = flavor(fl);
  const files = [], notes = [];
  const byService = new Map();
  for (const p of probes.values()) { if (p.skipped) { notes.push(`${p.route.method} ${p.route.path}: ${p.skipped}`); continue; } if (p.error) { notes.push(`${p.route.path}: could not reach (${p.error})`); continue; } if (p.status === 401 || p.status === 403) { notes.push(`${p.route.path}: needs a token (got ${p.status}). Provide one to include it`); continue; } if (p.status >= 400 && p.status !== 404 || !p.json) { if (p.status < 400) notes.push(`${p.route.path}: response is not JSON, skipped`); continue; } (byService.get(p.route.service) || byService.set(p.route.service, []).get(p.route.service)).push(p); }
  let count = 0;
  for (const [svc, ps] of byService) {
    const name = (model.services.find((s) => (s.dir === "." ? "" : s.dir) === (svc || ""))?.name) || model.name;
    const out = [header(`Contract tests: ${name}`, ["Response shapes were inferred from the running app when these tests were generated.", "If a shape change is intentional, regenerate or edit the schema below."]), f.imports,
      'import { api, baseFor } from "../helpers/http.mjs";', 'import { validate } from "../helpers/schema.mjs";', "", `const base = baseFor(${q(name)});`, ""];
    out.push(`describe(${q(`${name} response contracts`)}, () => {`);
    for (const p of ps) {
      const schema = infer(p.json);
      const urlExpr = p.sampleId !== undefined ? q(p.route.path.replace(/:\w+\*?/, encodeURIComponent(p.sampleId))) : q(p.route.path);
      out.push(f.it(`GET ${p.route.path} keeps its contract (${p.status}, ${schema.type})`, `const res = await api(base, "GET", ${urlExpr});\n${f.eq("res.status", String(p.status))}\n${f.ok('(res.headers.get("content-type") || "").includes("json")', '"should still be JSON"')}\nconst SCHEMA = ${JSON.stringify(schema, null, 2).replace(/\n/g, "\n")};\nconst errors = validate(res.json, SCHEMA);\n${f.ok("errors.length === 0", '"contract broken:\\n" + errors.join("\\n")')}`));
      count++;
    }
    out.push("});", "");
    files.push({ path: `contract/${slug(name)}.contract.test.mjs`, layer: "contract", content: out.join("\n"), tests: ps.length });
  }

  // ---- Pact v3 files: one per (consumer, provider)
  const pacts = [];
  for (const [svc, ps] of byService) {
    const provider = (model.services.find((s) => (s.dir === "." ? "" : s.dir) === (svc || ""))?.name) || model.name;
    const consumers = new Set(model.edges.filter((e) => e.kind !== "service→service" || typeof e.to === "string").map((e) => (e.kind === "ui→api" ? `${e.from === "." ? model.name : e.from}-ui` : e.from === "." ? null : e.from)).filter((c) => c && c !== provider));
    if (!consumers.size) consumers.add(`${model.name}-client`);
    for (const consumer of consumers) {
      const interactions = ps.filter((p) => p.status < 400).map((p) => ({
        description: `GET ${p.route.path}`, providerStates: [{ name: p.sampleId !== undefined ? `a record with id ${p.sampleId} exists` : "records exist" }],
        request: { method: "GET", path: p.sampleId !== undefined ? p.route.path.replace(/:\w+\*?/, encodeURIComponent(p.sampleId)) : p.route.path },
        response: { status: p.status, headers: { "Content-Type": "application/json" }, body: p.json, matchingRules: { body: pactRules(p.json), header: {} } },
      }));
      if (!interactions.length) continue;
      pacts.push({ file: `contract/pacts/${slug(consumer)}-${slug(provider)}.json`, consumer, provider, interactions });
    }
  }
  for (const p of pacts) files.push({ path: p.file, layer: "pact", content: JSON.stringify({ consumer: { name: p.consumer }, provider: { name: p.provider }, interactions: p.interactions, metadata: { pactSpecification: { version: "3.0.0" }, generatedBy: "TestLab" } }, null, 2), tests: p.interactions.length, data: true });
  if (pacts.length) {
    const body = [header("Pact verification: replays every pact file against its provider", ["Verifies status and response SHAPE (types), which is what Pact's type-matching rules mean.", "You can also hand the JSON files in contract/pacts to the Pact CLI / Pact Broker."]), f.imports,
      'import fs from "node:fs";', 'import { api, baseFor } from "../helpers/http.mjs";', 'import { sameShape } from "../helpers/schema.mjs";', "",
      'const dir = new URL("./pacts/", import.meta.url);', 'const pacts = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(fs.readFileSync(new URL(n, dir), "utf8")));', "",
      "for (const pact of pacts) {", "  describe(`${pact.consumer.name} → ${pact.provider.name}`, () => {", "    for (const i of pact.interactions) {",
      f.it("${i.description}", "const res = await api(baseFor(pact.provider.name), i.request.method, i.request.path);\n" + f.eq("res.status", "i.response.status") + "\nconst errors = sameShape(i.response.body, res.json);\n" + f.ok("errors.length === 0", '"provider no longer honours the contract:\\n" + errors.join("\\n")'))
        .replace(/^ {2}/gm, "      ").replace('it("${i.description}"', "it(`${i.description}`"), "    }", "  });", "}", ""];
    files.push({ path: "contract/verify-pacts.test.mjs", layer: "pact", content: body.join("\n"), tests: pacts.reduce((a, p) => a + p.interactions.length, 0) });
    count += pacts.reduce((a, p) => a + p.interactions.length, 0);
  }
  return { files, count, notes };
}
