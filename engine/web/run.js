// Runs the generated website tests in a real local browser and reports per-file results.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findBrowser } from "../verify.js";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", "@playwright", "test", "cli.js");
const ansi = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, "");

// Playwright JSON report → { fileName: [tests] }
export function parseByFile(json) {
  const out = {};
  (function walk(suite, file, prefix) {
    const f = suite.file || file;
    for (const spec of suite.specs || []) for (const t of spec.tests || []) {
      const r = t.results?.[t.results.length - 1] || {};
      const status = r.status === "passed" ? "pass" : r.status === "skipped" || t.status === "skipped" ? "skip" : "fail";
      (out[f] ||= []).push({ name: `[${t.projectName || "default"}] ${[prefix, spec.title].filter(Boolean).join(" › ")}`, status, message: status === "fail" ? ansi(r.error?.message || r.errors?.[0]?.message || r.status || "failed").slice(0, 900) : undefined });
    }
    for (const s of suite.suites || []) walk(s, f, s.file ? "" : [prefix, s.title].filter(Boolean).join(" › "));
  })({ suites: json.suites || [] }, "", "");
  return out;
}

const run = (args, { cwd, env, timeoutMs }) => new Promise((resolve) => {
  const t0 = Date.now();
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "", killed = false;
  const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, timeoutMs);
  child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
  child.on("close", () => { clearTimeout(timer); resolve({ out, err, killed, ms: Date.now() - t0 }); });
});

export async function verifySite({ files, runDir, baseUrl, confirm }) {
  if (!confirm) return { results: [], note: "needs your confirmation: a real browser will visit the site" };
  const exe = findBrowser();
  if (!exe) return { results: [], note: "no Chrome, Brave, Chromium or Edge found. Install one or set PLAYWRIGHT_EXECUTABLE" };
  fs.rmSync(runDir, { recursive: true, force: true });
  for (const f of files) { const abs = path.join(runDir, f.path); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, f.content); }
  const cwd = fs.realpathSync(runDir);
  const env = { ...process.env, BASE_URL: baseUrl, PLAYWRIGHT_EXECUTABLE: exe, CI: "1" };
  const cfg = path.join("site-tests", "playwright.config.mjs");
  const notes = [];
  if (files.some((f) => f.path.endsWith("visual.spec.mjs"))) { // first pass creates the baseline screenshots so the real run can compare
    const b = await run([cli, "test", "--config", cfg, "visual", "--update-snapshots", "--reporter=json"], { cwd, env, timeoutMs: 240000 });
    notes.push(b.killed ? "visual baselines timed out" : "visual baselines were created from the current site");
  }
  const r = await run([cli, "test", "--config", cfg, "--reporter=json"], { cwd, env, timeoutMs: 360000 });
  let byFile = {};
  try { byFile = parseByFile(JSON.parse(r.out.slice(r.out.indexOf("{")))); } catch {}
  const results = [];
  for (const f of files.filter((x) => !x.support && x.tests > 0)) {
    const name = path.basename(f.path);
    const tests = byFile[name] || [];
    results.push({ path: f.path, layer: f.layer, tests, ms: 0, status: !tests.length ? "error" : tests.some((t) => t.status === "fail") ? "fail" : "pass", ...(!tests.length ? { note: ansi(r.err.split("\n").find((l) => /Error/.test(l)) || "no results") .slice(0, 200) } : {}) });
  }
  const all = results.flatMap((x) => x.tests);
  return { results, notes, browser: path.basename(exe), ms: r.ms, totals: { passed: all.filter((t) => t.status === "pass").length, failed: all.filter((t) => t.status === "fail").length, skipped: all.filter((t) => t.status === "skip").length, findings: 0, filesNotRun: 0, filesErrored: results.filter((x) => x.status === "error").length } };
}
