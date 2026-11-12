import { unitInputs } from "../edgecases.js";
import { recordUnit, preflightImport } from "../record.js";
import { unitFile } from "./unit.js";
import { integrationFile, HTTP_HELPER } from "./integration.js";
import { contractFiles, probeApp, SCHEMA_HELPER } from "./contract.js";
import { e2eFiles, PLAYWRIGHT_CONFIG } from "./e2e.js";
import { slug } from "./util.js";

const svcName = (model, dir) => model.services.find((s) => (s.dir === "." ? "" : s.dir) === (dir || ""))?.name || model.name;

export async function generateTests(model, opts = {}) {
  const layers = new Set(opts.layers?.length ? opts.layers : ["unit", "integration", "contract", "pact", "e2e"]);
  const fl = opts.flavor === "vitest" ? "vitest" : "node";
  const baseUrl = (opts.baseUrl || "").trim();
  const files = [], skipped = [], notes = [];
  const log = opts.onProgress || (() => {});

  // ---------------------------------------------------------------- unit
  if (layers.has("unit")) {
    log("Recording real behaviour of functions in a sandbox…");
    const candidates = model.units.filter((u) => u.pure && u.exported && (u.complexity > 1 || u.params.length > 0));
    for (const u of model.units) {
      if (candidates.includes(u) || (u.complexity <= 1 && u.loc <= 6)) continue;
      skipped.push({ layer: "unit", what: `${u.name}() · ${u.file}:${u.line}`, reason: u.pure && !u.exported ? "private function: test it through the exported function that calls it" : u.skipReason || "no parameters or logic to exercise" });
    }
    // keep only functions whose module a plain Node process can import (no JSX/TypeScript, no required env vars, no hanging side effects)
    const pre = new Map();
    const importable = [];
    for (const u of candidates) {
      if (!/\.(js|mjs|cjs)$/.test(u.file)) { skipped.push({ layer: "unit", what: `${u.name}() · ${u.file}:${u.line}`, reason: "JSX/TypeScript file: needs a compiler or bundler to import" }); continue; }
      if (!pre.has(u.file)) pre.set(u.file, await preflightImport(model.dir, u.file));
      const p = pre.get(u.file);
      if (!p.ok) { skipped.push({ layer: "unit", what: `${u.name}() · ${u.file}:${u.line}`, reason: `module can't be imported on its own: ${/env var|process\.env/i.test(p.error) ? "it needs environment variables (" + p.error.replace(/^Error:\s*/, "") + ")" : p.error}` }); continue; }
      importable.push(u);
    }
    const ranked = importable.sort((a, b) => b.complexity - a.complexity).slice(0, opts.maxUnits || 80);
    const byFile = new Map();
    const queue = [...ranked];
    const worker = async () => {
      while (queue.length) {
        const u = queue.shift();
        const cases = unitInputs(u);
        const rec = await recordUnit(u, cases);
        if (rec.error) { skipped.push({ layer: "unit", what: `${u.name}() · ${u.file}`, reason: `sandbox: ${rec.error}` }); continue; }
        const stable = rec.results.filter((r) => r.stable && r.result.kind !== "timeout");
        const dropped = rec.results.length - stable.length;
        if (dropped) notes.push(`${u.name}(): ${dropped} input${dropped === 1 ? "" : "s"} gave different results on repeated runs (time/randomness) and were left out`);
        if (!stable.length) { skipped.push({ layer: "unit", what: `${u.name}() · ${u.file}`, reason: "no repeatable results" }); continue; }
        (byFile.get(u.file) || byFile.set(u.file, []).get(u.file)).push({ unit: u, results: stable.slice(0, 40) });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    for (const [file, items] of byFile) {
      items.sort((a, b) => a.unit.line - b.unit.line);
      const { content, count } = unitFile(file, items, fl);
      if (count) files.push({ path: `unit/${slug(file)}.test.mjs`, layer: "unit", content, tests: count, source: file });
    }
  }

  // ---------------------------------------------------------------- integration (+ auth probe)
  let expectAuth = false;
  let reachable = false;
  if (baseUrl) {
    try { const r = await fetch(baseUrl, { redirect: "manual", signal: AbortSignal.timeout(4000) }); reachable = r.status > 0; } catch { reachable = false; }
    // Is sign-in actually ENFORCED? Learn it from behaviour: if ordinary read endpoints answer 401/403 without credentials, it is.
    // ("who am I" endpoints such as /me always answer 401 when nobody is signed in, so they say nothing about enforcement.)
    const readable = model.routes.filter((r) => r.method === "GET" && !/:\w+/.test(r.path) && !/\/(me|whoami|session|profile|healthz?|readyz|metrics)$/i.test(r.path)).slice(0, 6);
    let denied = 0, probed = 0;
    for (const r of readable) { try { const x = await fetch(baseUrl.replace(/\/$/, "") + r.path, { redirect: "manual", signal: AbortSignal.timeout(4000) }); probed++; if (x.status === 401 || x.status === 403) denied++; } catch {} }
    expectAuth = reachable && probed > 0 && denied > 0 && denied >= probed / 2;
  }
  if (layers.has("integration")) {
    log("Writing API tests…");
    const byService = new Map();
    for (const r of model.routes) (byService.get(r.service || "") || byService.set(r.service || "", []).get(r.service || "")).push(r);
    for (const [dir, routes] of byService) {
      const name = svcName(model, dir);
      const res = integrationFile(name, routes, fl);
      if (res) files.push({ path: `integration/${slug(name)}.test.mjs`, layer: "integration", content: res.content, tests: res.count, service: name });
    }
  }

  // ---------------------------------------------------------------- contract + pact (needs a running app)
  let probes = null;
  if (layers.has("contract") || layers.has("pact")) {
    if (!baseUrl || !reachable) {
      const why = !baseUrl ? "Enter the URL of the running app so response shapes can be learned" : `Could not reach ${baseUrl}. Start the app and try again`;
      skipped.push({ layer: "contract", what: "all endpoints", reason: why });
      if (layers.has("pact")) skipped.push({ layer: "pact", what: "all service pairs", reason: why });
    } else {
      log("Probing the running app (read-only GET requests)…");
      probes = await probeApp(model, baseUrl, opts.token);
      const c = contractFiles(model, probes, fl);
      for (const f of c.files) if ((f.layer === "contract" && layers.has("contract")) || (f.layer === "pact" && layers.has("pact"))) files.push(f);
      for (const n of c.notes) skipped.push({ layer: "contract", what: n.split(":")[0], reason: n.split(":").slice(1).join(":").trim() });
      if (layers.has("pact") && !model.services.filter((s) => s.routes).length) notes.push("Pact: no provider routes were found");
    }
  }

  // ---------------------------------------------------------------- e2e
  if (layers.has("e2e")) {
    const e = e2eFiles(model);
    if (!e.files.length) skipped.push({ layer: "e2e", what: "pages", reason: "No UI pages were found" });
    for (const f of e.files) files.push(f);
    if (e.files.length) files.push({ path: "e2e/playwright.config.mjs", layer: "e2e", content: PLAYWRIGHT_CONFIG.replace("__BASE_URL__", baseUrl || "http://localhost:3000"), tests: 0, support: true });
    for (const p of model.pages.filter((x) => x.dynamic)) skipped.push({ layer: "e2e", what: `page ${p.path}`, reason: "dynamic route: needs a real record ID, add by hand" });
  }

  // ---------------------------------------------------------------- shared helpers + README
  const needsHttp = files.some((f) => ["integration", "contract", "pact"].includes(f.layer));
  if (needsHttp) files.push({ path: "helpers/http.mjs", layer: "support", support: true, tests: 0, content: HTTP_HELPER.replace("__BASE_URL__", baseUrl || "http://localhost:3000").replace("__EXPECT_AUTH__", String(expectAuth)) });
  if (files.some((f) => f.layer === "contract" || f.layer === "pact")) files.push({ path: "helpers/schema.mjs", layer: "support", support: true, tests: 0, content: SCHEMA_HELPER });
  const cmd = fl === "vitest"
    ? { unit: "npx vitest run tests-generated/unit", api: "BASE_URL=http://localhost:3000 npx vitest run tests-generated/integration tests-generated/contract" }
    : { unit: 'node --test "tests-generated/unit/*.test.mjs"', api: 'BASE_URL=http://localhost:3000 node --test "tests-generated/integration/*.test.mjs" "tests-generated/contract/*.test.mjs"' };
  files.push({ path: "README.md", layer: "support", support: true, tests: 0, content: `# Generated tests

Created by **TestLab** for \`${model.name}\`. Put this folder at \`<project>/tests-generated/\` (the unit tests import your source with relative paths).

| Folder | What it is | Run |
|---|---|---|
| \`unit/\` | Characterization tests: each function was run with edge inputs in a sandbox and its real result is pinned | \`${cmd.unit}\` |
| \`integration/\` | Real HTTP requests per endpoint: lifecycles, bad IDs, validation, security, auth | \`${cmd.api}\` |
| \`contract/\` | Response-shape tests + Pact files (\`pacts/*.json\`) and a verifier that replays them | same as above |
| \`e2e/\` | Playwright browser tests (needs \`npm i -D @playwright/test\`) | \`BASE_URL=http://localhost:3000 npx playwright test --config tests-generated/e2e/playwright.config.mjs\` |

## Please read
- **Integration and contract tests send real requests.** POST/PUT/PATCH/DELETE change data in the app. Run them against a development database.
- **Characterization tests pin current behaviour, not correct behaviour.** Read each expected value and fix the code (not the test) when the pinned behaviour is a bug.
- Environment variables: \`BASE_URL\`, \`BASE_URL_<SERVICE>\` (per service), \`TEST_TOKEN\` (bearer token for protected routes), \`EXPECT_AUTH=1\`.
- Generated with the **${fl === "vitest" ? "Vitest" : "node:test"}** runner. (With \`node --test\`, keep the quotes around the patterns; they need Node 21+. On Node 20 run \`node --test tests-generated/\`.)
` });

  const byLayer = {};
  for (const f of files) if (!f.support && !f.data) byLayer[f.layer] = (byLayer[f.layer] || 0) + (f.tests || 0);
  return { files, skipped, notes, summary: { files: files.filter((f) => !f.support && !f.data).length, tests: Object.values(byLayer).reduce((a, b) => a + b, 0), byLayer, reachable, expectAuth }, probes: probes ? [...probes.values()].map((p) => ({ path: p.route.path, service: p.route.service, status: p.status, skipped: p.skipped, error: p.error })) : null };
}
