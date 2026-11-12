// Turns a scan into a recommended test mix (percentages), the reasoning behind each number, and a risk-ranked to-do list.
// The percentages are a transparent heuristic: each layer scores the evidence the scan found for it; scores are normalised to 100.
import { routeEdgeCases } from "./edgecases.js";

const LAYERS = [
  { id: "unit", label: "Unit", color: "#5eead4", what: "Single functions in isolation: fast, pinpoint failures" },
  { id: "integration", label: "Integration (API)", color: "#60a5fa", what: "Real HTTP calls through routes, validation, auth and the database" },
  { id: "contract", label: "Contract (schema)", color: "#fbbf24", what: "Response shapes stay stable for the people who depend on them" },
  { id: "pact", label: "Pact (consumer-driven)", color: "#f472b6", what: "Service-to-service agreements, verified on both sides" },
  { id: "e2e", label: "End-to-end (UI)", color: "#a78bfa", what: "A real browser clicking through the critical flows" },
];

const isWrite = (r) => ["POST", "PUT", "PATCH", "DELETE"].includes(r.method);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export function recommend(model) {
  const { units, routes, pages, edges } = model;
  const multi = model.services.length > 1;
  const crossEdges = edges.filter((e) => e.kind !== "ui→api");
  const uiEdges = edges.filter((e) => e.kind === "ui→api");
  const nontrivial = units.filter((u) => u.complexity > 1 || u.loc > 6);

  // ---- evidence per layer
  const ev = {
    unit: nontrivial.reduce((a, u) => a + clamp(u.complexity, 1, 12) * (u.pure ? 1 : 0.5) * (u.exported ? 1.2 : 1), 0),
    integration: routes.reduce((a, r) => a + 3 + (r.validates ? 2 : 0) + r.bodyFields.length + r.statuses.length * 0.5 + (r.auth ? 2 : 0) + (isWrite(r) ? 1.5 : 0), 0),
    contract: routes.length * 0.7 + (model.openapi ? 6 : 0) + uiEdges.length * 1.5,
    pact: crossEdges.length * 5 + (multi ? model.services.length * 2.5 : 0),
    e2e: pages.length * 4 + pages.filter((p) => p.hasForm).length * 4 + pages.filter((p) => p.interactive).length * 2 + (pages.some((p) => /login|signin|register/i.test(p.path)) ? 6 : 0),
  };
  const present = {
    unit: nontrivial.length > 0, integration: routes.length > 0, contract: routes.length > 0, pact: multi && crossEdges.length > 0, e2e: pages.length > 0,
  };

  // ---- reasons (plain language, grounded in what was found)
  const reasons = {
    unit: present.unit ? [`${nontrivial.length} functions with real logic (${units.filter((u) => u.pure).length} can be tested in isolation right now)`, units.some((u) => u.complexity >= 6) ? `${units.filter((u) => u.complexity >= 6).length} are complex (6+ branches): bugs hide here` : "most functions are small and simple", `${units.filter((u) => !u.pure && u.exported).length} exported functions touch the database, network or environment and need mocks or integration tests instead`] : ["No functions with meaningful logic were found"],
    integration: present.integration ? [`${routes.length} HTTP endpoints`, `${routes.filter((r) => r.validates).length} validate input and ${routes.filter(isWrite).length} change data: the most failure-prone code`, routes.some((r) => r.auth) ? `${routes.filter((r) => r.auth).length} are protected by auth, so access rules need testing` : "no auth detected on the routes"] : ["No HTTP routes found"],
    contract: present.contract ? [`${routes.length} endpoints whose response shape other code depends on`, model.openapi ? `An OpenAPI file exists (${model.openapi}) and should be the source of truth` : "No OpenAPI spec found, so shapes are inferred from live responses", uiEdges.length ? `${uiEdges.length} UI → API calls rely on those shapes` : "no UI consumers detected"] : ["No endpoints to protect"],
    pact: present.pact ? [`${model.services.length} services and ${crossEdges.length} service-to-service connections (${[...new Set(crossEdges.map((e) => `${e.from} → ${typeof e.to === "string" && e.to.length < 30 ? e.to : "upstream"}`))].slice(0, 3).join(", ")})`, "Independent deploys can silently break each other: Pact catches it before release"] : [multi ? "Services found, but no calls between them were detected" : "Single service: consumer-driven contracts add little here (add Pact when a second service or client appears)"],
    e2e: present.e2e ? [`${pages.length} page${pages.length === 1 ? "" : "s"}${pages.filter((p) => p.hasForm).length ? `, ${pages.filter((p) => p.hasForm).length} with forms` : ""}`, pages.some((p) => /login|register|signin/i.test(p.path)) ? "A login/registration flow exists: the highest-value E2E journey" : "keep E2E to a few critical journeys: they are slow and brittle"] : ["No UI pages found (this looks like an API-only project)"],
  };

  // ---- normalise to whole percentages (largest-remainder so they add to exactly 100)
  const total = Object.entries(ev).reduce((a, [k, v]) => a + (present[k] ? v : 0), 0) || 1;
  const raw = LAYERS.map((l) => ({ ...l, raw: present[l.id] ? (ev[l.id] / total) * 100 : 0 }));
  // E2E is slow and costly: never recommend a majority share
  const e2e = raw.find((l) => l.id === "e2e");
  if (e2e.raw > 20) { const cut = e2e.raw - 20; e2e.raw = 20; const others = raw.filter((l) => l.id !== "e2e" && l.raw > 0); const sum = others.reduce((a, l) => a + l.raw, 0) || 1; others.forEach((l) => (l.raw += (cut * l.raw) / sum)); }
  const floors = raw.map((l) => Math.floor(l.raw));
  let rest = 100 - floors.reduce((a, b) => a + b, 0);
  raw.map((l, i) => ({ i, frac: l.raw - floors[i] })).sort((a, b) => b.frac - a.frac).forEach(({ i }) => { if (rest > 0 && raw[i].raw > 0) { floors[i]++; rest--; } });
  const mix = raw.map((l, i) => ({
    id: l.id, label: l.label, color: l.color, what: l.what, percent: floors[i], available: present[l.id], reasons: reasons[l.id],
    count: { unit: nontrivial.length, integration: routes.length, contract: routes.length, pact: crossEdges.length, e2e: pages.length }[l.id],
    autoGenerated: { unit: units.filter((u) => u.pure).length, integration: routes.length, contract: routes.length, pact: crossEdges.length ? Math.max(1, model.services.filter((s) => s.routes).length) : 0, e2e: pages.length }[l.id],
  }));

  // ---- risk ranking: what to test first
  const risks = [];
  for (const u of units) {
    if (u.complexity <= 1 && u.loc <= 6) continue;
    const score = u.complexity * (u.exported ? 1.5 : 1) * (u.tested ? 0.4 : 1.6) * (u.throws ? 1.2 : 1);
    risks.push({ kind: "function", id: u.id, label: `${u.name}()`, where: `${u.file}:${u.line}`, score: +score.toFixed(1), why: [`${u.complexity} branches`, u.tested ? "has some tests" : "no test mentions it", u.pure ? "can be tested right now" : `needs mocks: ${u.skipReason}`].join(" · ") });
  }
  for (const r of routes) {
    const score = (isWrite(r) ? 5 : 3) * (r.auth ? 1.4 : 1) * (r.validates ? 1.3 : 1) * (1 + r.statuses.length * 0.15) * (r.tested ? 0.4 : 1.4);
    risks.push({ kind: "endpoint", id: r.id + r.file, label: `${r.method} ${r.path}`, where: `${r.file}:${r.line}`, score: +score.toFixed(1), why: [isWrite(r) ? "changes data" : "read-only", r.auth ? "auth-protected" : "no auth detected", r.validates ? "validates input" : null, `${routeEdgeCases(r).length} edge cases`].filter(Boolean).join(" · ") });
  }
  risks.sort((a, b) => b.score - a.score);

  const notes = [];
  if (model.existing.files) notes.push(`${model.existing.files} existing test file${model.existing.files === 1 ? "" : "s"} found${model.existing.frameworks.length ? ` (${model.existing.frameworks.join(", ")})` : ""}. This mix is for the coverage you still need.`);
  else notes.push("No existing tests found. Start from the top of the risk list and the generated files below.");
  if (!model.openapi && routes.length) notes.push("There is no OpenAPI spec. Writing one makes contract tests far stronger than inferring shapes from responses.");
  if (units.some((u) => !u.pure && u.exported)) notes.push("Many functions mix logic with database/network calls. Pulling the logic into small pure functions makes them unit-testable.");
  return { mix, risks: risks.slice(0, 15), notes, basis: "Scores come from what the scan found: branches per function, endpoint count and input validation, shared response shapes, connections between services, and UI forms. They are scaled to 100% (UI tests are capped at 20% because they are slow). Treat the numbers as a starting point, not a rule." };
}
