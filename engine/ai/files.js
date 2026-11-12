// Turns verified AI results into test files and a findings report.
import { toJsLiteral } from "../serialize.js";
import { flavor, header, q, slug, longStringChecks } from "../generate/util.js";

const oneLine = (s) => String(s).replace(/\s+/g, " ").trim();

export function unitAiFile(file, items, fl) {
  const f = flavor(fl);
  const depth = ("unit/" + slug(file) + ".ai.test.mjs").split("/").length - 1;
  const rel = "../".repeat(depth + 1) + file;
  const out = [header(`AI-assisted unit tests for ${file}`, ["[AI case]    extra inputs proposed by the AI; the expected values were RECORDED from the real code (characterization).", "[AI finding] the AI believes the code is wrong here. These assert the EXPECTED behaviour, so they FAIL until the bug is fixed (or the finding is dismissed)."]), f.imports, 'import { createHash } from "node:crypto";', "",
    `const mod = await import(new URL(${q(rel)}, import.meta.url));`, `const pick = (name) => mod[name] ?? mod.default?.[name] ?? (name === "default" ? mod.default : undefined);`,
    `async function run(fn, ...args) { try { return { ok: true, value: await fn(...args) }; } catch (error) { return { ok: false, error }; } }`, ""];
  let count = 0;
  for (const { unit, extras, findings } of items) {
    const body = [];
    for (const e of extras) {
      const lit = toJsLiteral(e.result.value);
      if (e.result.kind === "return") { if (lit.length > 500 && typeof e.result.value !== "string") continue; body.push(f.it(`[AI case] ${e.label}`, `// why: ${oneLine(e.why)}\nconst r = await run(fn, ...(${e.argsExpr}));\n${f.eq("r.ok", "true")}\n${lit.length > 500 ? longStringChecks(f, e.result.value) : f.deep("r.value", lit)}`)); count++; }
      else if (e.result.kind === "throw") { body.push(f.it(`[AI case] ${e.label}`, `// why: ${oneLine(e.why)}\nconst r = await run(fn, ...(${e.argsExpr}));\n${f.eq("r.ok", "false")}\n${f.eq("r.error.name", q(e.result.name))}\n${f.eq("r.error.message", q(e.result.message.slice(0, 200)))}`)); count++; }
    }
    for (const x of findings) {
      const check = x.expect.kind === "throws" ? `${f.eq("r.ok", "false")}\n${f.eq("r.error?.name", q(x.expect.error_name || "Error"))}` : `${f.eq("r.ok", "true")}\n${f.deep("r.value", x.expect.value_expr)}`;
      body.push(f.it(`[AI finding] ${x.title}`, `// ${x.severity.toUpperCase()}: ${oneLine(x.explanation)}\n// currently the code ${x.actualText}\nconst r = await run(fn, ...(${x.args_expr}));\n${check}`)); count++;
    }
    if (!body.length) continue;
    out.push(`describe(${q(`${unit.name}()  ·  ${file}:${unit.line}  (AI-assisted)`)}, () => {`, `  const fn = pick(${q(unit.name)});`, ...body, "});", "");
  }
  return { content: out.join("\n"), count };
}

export function integrationAiFile(service, items, fl) {
  const f = flavor(fl);
  const out = [header(`AI-reviewed API rules: ${service}`, ["[AI expectation] the AI read the handler and its validators and predicts this status code.", "A failure means either a real bug or a wrong prediction: look at the rationale and decide."]), f.imports,
    'import { api, baseFor, TOKEN, EXPECT_AUTH } from "../helpers/http.mjs";', "", `const base = baseFor(${q(service)});`, "const needsToken = EXPECT_AUTH && !TOKEN;", "const created = [];", ""];
  let count = 0;
  for (const { route, review, createBody, deletePath, createPath } of items) {
    const tests = [];
    for (const c of review.cases) {
      const hasParam = /:\w+/.test(c.path);
      const url = "`" + c.path.replace(/:\w+\*?/g, "${id}") + (c.query ? "?" + c.query : "") + "`";
      const body = c.body_json ? `, { body: ${c.body_json} }` : "";
      let pre = "";
      if (c.needs_record && createPath) pre = `const made = await api(base, "POST", ${q(createPath)}, { body: ${createBody} });\n${f.ok("made.status < 300", "`could not create a record to test against: ${made.status} ${made.text.slice(0, 100)}`")}\nconst id = made.json?.id ?? made.json?.data?.id;\ncreated.push(id);\n`;
      else if (hasParam) pre = `const id = "987654321"; // an id that should not exist\n`;
      tests.push(f.it(`[AI expectation] ${c.title}`, `// why: ${oneLine(c.rationale)}\n${pre}const res = await api(base, ${q(c.method)}, ${url}${body});\n${f.ok(`res.status === ${c.expect_status}`, "`expected " + c.expect_status + " but got ${res.status}: ${res.text.slice(0, 140)}`")}`, { skip: route.auth ? "needsToken" : undefined }));
      count++;
    }
    if (tests.length) out.push(`describe(${q(`${route.method} ${route.path}  (AI-reviewed)`)}, () => {`, `  // ${oneLine(review.summary)}`, ...tests, "});", "");
  }
  const del = items.find((i) => i.deletePath)?.deletePath;
  if (del) out.push(`describe("cleanup", () => {`, f.it("removes records created by this file", `for (const id of created.filter((x) => x !== undefined)) await api(base, "DELETE", ${q(del)}.replace(/:\\w+\\*?/, encodeURIComponent(id)));`, { skip: "needsToken" }), "});", "");
  return { content: out.join("\n"), count };
}

export function findingsReport(model, ai) {
  const L = [`# AI review of \`${model.name}\``, "", `Model: **${ai.model}** · ${ai.units} functions and ${ai.routes} endpoints reviewed · ${ai.usage.input_tokens.toLocaleString("en-US")} input / ${ai.usage.output_tokens.toLocaleString("en-US")} output tokens · about $${ai.cost.toFixed(2)}`, "",
    "Every item below was **checked by running the code**. The AI proposed an input and the behaviour a correct implementation should have; TestLab executed the input in a sandbox. Only claims the code does NOT satisfy are listed. Claims the code already satisfied were discarded" + (ai.refuted ? ` (${ai.refuted} discarded).` : "."), ""];
  if (!ai.findings.length) L.push("No discrepancies were confirmed. That is a good sign, not proof of correctness.", "");
  for (const x of ai.findings) L.push(`## ${x.severity === "bug" ? "🐞" : "⚠️"} ${x.title}`, `**${x.where}** · \`${x.fn}()\` · severity: ${x.severity}`, "", x.explanation, "", "```", `input:    ${x.args}`, `expected: ${x.expectedText}`, `actual:   ${x.actualText}`, "```", "");
  L.push("---", "These are leads for a human to judge, not verdicts. The matching `[AI finding]` tests fail until the code changes (or you delete the test).");
  return L.join("\n");
}
