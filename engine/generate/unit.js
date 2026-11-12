// Unit tests from RECORDED behaviour ("characterization tests"): each function was run in a sandbox with many edge inputs;
// the test pins what it returned or threw. They catch regressions, but a human must confirm the pinned behaviour is correct.
import { toJsLiteral } from "../serialize.js";
import { flavor, header, q, slug, longStringChecks } from "./util.js";

const MAX_LITERAL = 400;

export function unitFile(file, items, fl) {
  const f = flavor(fl);
  const depth = ("unit/" + slug(file) + ".test.mjs").split("/").length - 1; // how far up the project root is
  const rel = "../".repeat(depth + 1) + file; // +1 for the tests-generated folder itself
  const out = [header(`Unit tests (characterization) for ${file}`, ["Each case was executed in a restricted sandbox; the expected values below are what the code really returned or threw."]), f.imports, 'import { createHash } from "node:crypto";', "",
    `const mod = await import(new URL(${q(rel)}, import.meta.url));`,
    `const pick = (name) => mod[name] ?? mod.default?.[name] ?? (name === "default" ? mod.default : undefined);`,
    `async function run(fn, ...args) { try { return { ok: true, value: await fn(...args) }; } catch (error) { return { ok: false, error }; } }`, ""];
  let count = 0;
  for (const { unit, results } of items) {
    const body = [];
    for (const r of results) {
      const args = (r.args || []).map((a) => toJsLiteral(a)).join(", ");
      const res = r.result;
      let lines;
      if (res.kind === "return") {
        const lit = toJsLiteral(res.value);
        if (res.value?.$ === "function") continue;
        if (lit.length > MAX_LITERAL && typeof res.value !== "string") continue; // big structured values are skipped; long text is digested
        lines = `const r = await run(fn${args ? ", " + args : ""});\n${f.eq("r.ok", "true")}\n${lit.length > MAX_LITERAL ? longStringChecks(f, res.value) : f.deep("r.value", lit)}`;
      } else if (res.kind === "throw") {
        lines = `const r = await run(fn${args ? ", " + args : ""});\n${f.eq("r.ok", "false")}\n${f.eq("r.error.name", q(res.name))}\n${f.eq("r.error.message", q(res.message.slice(0, 200)))}`;
      } else continue;
      body.push(f.it(r.label, lines));
      count++;
    }
    if (!body.length) continue;
    out.push(`describe(${q(`${unit.name}()  ·  ${file}:${unit.line}`)}, () => {`, `  const fn = pick(${q(unit.name)});`, `  it("is exported", () => { ${f.ok('typeof fn === "function"', q(`${unit.name} is not exported from ${file}`))} });`, ...body, "});", "");
  }
  return { content: out.join("\n"), count };
}
