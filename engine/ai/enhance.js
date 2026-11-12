// AI review: the model PROPOSES (purpose, suspected bugs, extra inputs, endpoint rules); TestLab DISPOSES by executing everything.
import { unitInputs } from "../edgecases.js";
import { recordUnit } from "../record.js";
import { toJsLiteral } from "../serialize.js";
import { slug, bodyLiteral } from "../generate/util.js";
import { safeExpr } from "./safe.js";
import { redact } from "./redact.js";
import { aiClient, askStructured, explainError, costOf, DEFAULT_MODEL, MODELS } from "./client.js";
import { SYSTEM, UnitReview, RouteReview, unitPrompt, routePrompt } from "./prompts.js";
import { unitAiFile, integrationAiFile, findingsReport } from "./files.js";

const short = (s, n = 70) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const describeResult = (r) => (!r ? "n/a" : r.kind === "return" ? `returns ${short(toJsLiteral(r.value), 90)}` : r.kind === "throw" ? `throws ${r.name}: ${short(String(r.message), 70)}` : r.kind);
const sameOutcome = (expected, actual) => (expected.kind === "throw" ? actual.kind === "throw" && (!expected.name || expected.name === "Error" || expected.name === actual.name) : actual.kind === "return" && JSON.stringify(expected.value) === JSON.stringify(actual.value));

export async function aiEnhance(model, base, opts = {}) {
  const modelId = MODELS[opts.model] ? opts.model : DEFAULT_MODEL;
  const effort = ["low", "medium", "high"].includes(opts.effort) ? opts.effort : "medium";
  const log = opts.onProgress || (() => {});
  const client = aiClient({ apiKey: opts.apiKey });
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const addUsage = (u) => { if (u) for (const k of Object.keys(usage)) usage[k] += u[k] || 0; };
  const out = { files: [], findings: [], skipped: [], notes: [], refuted: 0, redactions: 0, units: 0, routes: 0, model: modelId, error: null };
  const ask = async (user, schema) => { const r = redact(user); out.redactions += r.hits; const a = await askStructured({ client, model: modelId, system: SYSTEM, user: r.text, schema, effort }); addUsage(a.usage); return a; };

  try {
    // ------------------------------------------------------------ functions
    const tested = new Set(base.testedUnits || []);
    const targets = model.units.filter((u) => tested.has(u.id)).sort((a, b) => b.complexity - a.complexity).slice(0, opts.maxUnits ?? 10);
    const byFile = new Map();
    const queue = [...targets];
    let done = 0;
    const worker = async () => {
      while (queue.length) {
        const u = queue.shift();
        log(`Reviewing ${u.name}() … (${++done}/${targets.length})`);
        const rec = await recordUnit(u, unitInputs(u).slice(0, 60));
        const behaviours = (rec.results || []).filter((r) => r.stable && r.result).slice(0, 24).map((r) => `${r.label} → ${describeResult(r.result)}`);
        let a;
        try { a = await ask(unitPrompt(u, behaviours, 10), UnitReview); } catch (e) { throw e; }
        if (a.skip) { out.skipped.push({ layer: "ai", what: `${u.name}() · ${u.file}`, reason: a.skip }); continue; }
        const review = a.data;
        const extras = review.extra_cases.filter((c) => { const v = safeExpr(c.args_expr); if (!v.ok) out.skipped.push({ layer: "ai", what: `${u.name}(): extra case "${short(c.label, 40)}"`, reason: `unsafe or invalid input expression: ${v.reason}` }); return v.ok; }).slice(0, 10);
        const claims = review.findings.filter((c) => { const v = safeExpr(c.args_expr); const w = c.expect.kind === "throws" ? { ok: true } : safeExpr(c.expect.value_expr); if (!v.ok || !w.ok) out.skipped.push({ layer: "ai", what: `${u.name}(): claim "${short(c.title, 40)}"`, reason: `unsafe or invalid expression: ${v.reason || w.reason}` }); return v.ok && w.ok; }).slice(0, 6);
        if (!extras.length && !claims.length) { out.units++; continue; }
        const cases = [...extras.map((e) => ({ label: e.label, argsExpr: e.args_expr })), ...claims.map((c) => ({ label: c.title, argsExpr: c.args_expr, expect: { kind: c.expect.kind, valueExpr: c.expect.value_expr, errorName: c.expect.error_name } }))];
        const run = await recordUnit(u, cases);
        if (run.error) { out.skipped.push({ layer: "ai", what: `${u.name}()`, reason: `sandbox: ${run.error}` }); continue; }
        const item = { unit: u, extras: [], findings: [] };
        run.results.forEach((r, i) => {
          if (r.error) { out.skipped.push({ layer: "ai", what: `${u.name}(): "${short(r.label, 40)}"`, reason: r.error }); return; }
          if (!r.stable) return;
          if (i < extras.length) { if (r.result.kind !== "timeout") item.extras.push({ label: extras[i].label, why: extras[i].why, argsExpr: extras[i].args_expr, result: r.result.kind === "return" ? { kind: "return", value: r.result.value } : r.result }); return; }
          const c = claims[i - extras.length];
          if (r.expectError || !r.expected) { out.skipped.push({ layer: "ai", what: `${u.name}(): claim "${short(c.title, 40)}"`, reason: `expectation could not be evaluated: ${r.expectError || "no value"}` }); return; }
          if (sameOutcome(r.expected, r.result)) { out.refuted++; return; } // the code already does what the AI said it should: not a bug
          const expectedText = c.expect.kind === "throws" ? `throws ${c.expect.error_name || "an error"}` : `returns ${short(c.expect.value_expr, 120)}`;
          const actualText = describeResult(r.result);
          out.findings.push({ kind: "unit", severity: c.severity, title: c.title, explanation: c.explanation, where: `${u.file}:${u.line}`, fn: u.name, args: c.args_expr, expectedText, actualText });
          item.findings.push({ ...c, actualText });
        });
        out.units++;
        if (item.extras.length || item.findings.length) (byFile.get(u.file) || byFile.set(u.file, []).get(u.file)).push(item);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    for (const [file, items] of byFile) {
      const f = unitAiFile(file, items.sort((a, b) => a.unit.line - b.unit.line), base.flavor);
      if (f.count) out.files.push({ path: `unit/${slug(file)}.ai.test.mjs`, layer: "ai", content: f.content, tests: f.count, source: file });
    }

    // ------------------------------------------------------------ endpoints
    if ((opts.maxRoutes ?? 8) > 0) {
      const skipPath = /^\/(metrics|healthz|readyz|_next)|\/health$/;
      const picks = model.routes.filter((r) => r.code && !skipPath.test(r.path) && ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(r.method) && (r.validates || r.bodyFields.length || r.statuses.length > 1))
        .sort((a, b) => (b.validates ? 3 : 0) + b.bodyFields.length + b.statuses.length - ((a.validates ? 3 : 0) + a.bodyFields.length + a.statuses.length)).slice(0, opts.maxRoutes ?? 8);
      const byService = new Map();
      const reviews = new Map();
      let n = 0;
      for (const r of picks) {
        log(`Reviewing ${r.method} ${r.path} … (${++n}/${picks.length})`);
        const a = await ask(routePrompt(r, r.helpers || [], 10), RouteReview);
        if (a.skip) { out.skipped.push({ layer: "ai", what: `${r.method} ${r.path}`, reason: a.skip }); continue; }
        const cases = a.data.cases.filter((c) => {
          const bodyOk = !c.body_json || (() => { try { JSON.parse(c.body_json); return true; } catch { return false; } })();
          const ok = c.path === r.path && c.method === r.method && /^[\w=&%.\-+,]*$/.test(c.query) && bodyOk && c.expect_status >= 100 && c.expect_status < 600;
          if (!ok) out.skipped.push({ layer: "ai", what: `${r.method} ${r.path}: "${short(c.title, 40)}"`, reason: "the case did not match the route or had an invalid body/query" });
          return ok;
        });
        reviews.set(`${r.service}|${r.method} ${r.path}`, a.data);
        if (!cases.length) continue;
        out.routes++;
        const coll = r.path.replace(/\/:\w+\*?$/, "");
        const post = model.routes.find((x) => x.method === "POST" && x.path === coll && x.service === r.service);
        const del = model.routes.find((x) => x.method === "DELETE" && x.path === coll + "/:id" && x.service === r.service);
        // a record is created through the collection's own POST endpoint, using ITS valid body (not this endpoint's)
        const postReview = post && reviews.get(`${post.service}|POST ${post.path}`);
        const createBody = (postReview && postReview.valid_body_json) || (post && post.bodyFields.length ? bodyLiteral(post.bodyFields) : "{}");
        const item = { route: r, review: { ...a.data, cases }, createPath: post ? post.path : null, createBody, deletePath: del ? del.path : null };
        (byService.get(r.service || "") || byService.set(r.service || "", []).get(r.service || "")).push(item);
      }
      for (const [svc, items] of byService) {
        const name = model.services.find((s) => (s.dir === "." ? "" : s.dir) === svc)?.name || model.name;
        const f = integrationAiFile(name, items, base.flavor);
        if (f.count) out.files.push({ path: `integration/${slug(name)}.ai.test.mjs`, layer: "ai", content: f.content, tests: f.count, service: name });
      }
    }
  } catch (e) { out.error = explainError(e); }

  out.usage = usage;
  out.cost = costOf(modelId, usage);
  if (out.findings.length || out.files.length) out.files.push({ path: "AI-FINDINGS.md", layer: "support", support: true, tests: 0, content: findingsReport(model, out) });
  if (out.redactions) out.notes.push(`${out.redactions} possible secret${out.redactions === 1 ? "" : "s"} in the source snippets were redacted before sending.`);
  return out;
}

// rough pre-flight estimate so the UI can show a price before anything is sent
export function estimateAi(model, base, { model: modelId = DEFAULT_MODEL, maxUnits = 10, maxRoutes = 8 } = {}) {
  const n = Math.min(maxUnits, (base.testedUnits || []).length) + Math.min(maxRoutes, model.routes.filter((r) => r.code).length);
  const usage = { input_tokens: n * 2600, output_tokens: n * 2200 };
  return { calls: n, cost: costOf(modelId in MODELS ? modelId : DEFAULT_MODEL, usage), note: "rough estimate; the real figure is shown after the run" };
}
