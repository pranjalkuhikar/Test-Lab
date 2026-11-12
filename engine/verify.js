// Runs the generated tests and reports what passed.
//  • unit tests run in a restricted child process (node --permission: no file writes, no subprocesses)
//  • API/contract tests send real requests to the app, so they only run against localhost and only after explicit confirmation
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const unesc1 = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&#10;/g, "\n");

const unesc = (s) => unesc1(unesc1(s)); // node's JUnit reporter escapes twice
export function parseJunit(xml) {
  const tests = [];
  const re = /<testcase name="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const inner = m[2] || "";
    const fail = inner.match(/<failure[^>]*message="([^"]*)"/);
    const failBody = inner.match(/<failure[^>]*>([\s\S]*?)<\/failure>/);
    const name = unesc(m[1]); const failed = !!fail || /<failure/.test(inner);
    tests.push({ name, status: failed ? (/^\[AI (finding|expectation)\]/.test(name) ? "finding" : "fail") : /<skipped/.test(inner) ? "skip" : "pass", message: fail ? unesc(fail[1]).slice(0, 400) : failBody ? unesc(failBody[1]).trim().slice(0, 400) : undefined });
  }
  return tests;
}

// A locally installed Chromium-family browser for the E2E tests (so nothing has to be downloaded)
export function findBrowser() {
  const cands = [process.env.PLAYWRIGHT_EXECUTABLE, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean);
  return cands.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}
const playwrightCli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@playwright", "test", "cli.js");

// Playwright's JSON report → the same test list shape the other layers use
export function parsePlaywright(json) {
  const tests = [];
  (function walk(suite, prefix) {
    for (const spec of suite.specs || []) for (const t of spec.tests || []) {
      const r = t.results?.[t.results.length - 1] || {};
      const st = r.status === "passed" ? "pass" : r.status === "skipped" || t.status === "skipped" ? "skip" : "fail";
      tests.push({ name: [prefix, spec.title].filter(Boolean).join(" › "), status: st, message: st === "fail" ? String(r.error?.message || r.errors?.[0]?.message || r.status || "failed").replace(/\u001b\[[0-9;]*m/g, "").slice(0, 500) : undefined });
    }
    for (const s of suite.suites || []) walk(s, [prefix, s.title && !/\.spec\./.test(s.title) ? s.title : ""].filter(Boolean).join(" › "));
  })({ suites: json.suites || [] }, "");
  return tests;
}

function run(args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err, killed, ms: Date.now() - t0 }); });
  });
}

export function materialize(files, runDir, projectRoot) {
  const root = path.join(runDir, "tests-generated");
  fs.rmSync(runDir, { recursive: true, force: true });
  for (const f of files) {
    let content = f.content;
    // the verification copy lives outside the project, so point its imports at the project by absolute path
    if ((f.layer === "unit" || (f.layer === "ai" && f.path.startsWith("unit/"))) && projectRoot) content = content.replace(/new URL\("(?:\.\.\/)+([^"]+)", import\.meta\.url\)/, (_, p) => `new URL(${JSON.stringify(pathToFileURL(path.join(projectRoot, p)).href)})`);
    const abs = path.join(root, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

export async function verify({ files, runDir, projectRoot, baseUrl, token, expectAuth, layers, flavor, confirmRequests, onFile }) {
  const results = [];
  if (flavor === "vitest") return { results, note: "The Vitest flavour is not run by TestLab. Run it in your project with `npx vitest run tests-generated`." };
  const root = materialize(files, runDir, projectRoot);
  const wanted = files.filter((f) => !f.support && !f.data && f.tests > 0 && (layers.includes(f.layer) || f.layer === "ai"));
  const baseEnv = { ...process.env, BASE_URL: baseUrl || "", TEST_TOKEN: token || "", ...(expectAuth !== undefined ? { EXPECT_AUTH: expectAuth ? "1" : "0" } : {}), NODE_ENV: "test" };
  for (const f of wanted) {
    const abs = path.join(root, f.path);
    const entry = { path: f.path, layer: f.layer, tests: [], status: "pass", ms: 0 };
    const http = f.layer !== "unit" && !(f.layer === "ai" && f.path.startsWith("unit/"));
    if (f.layer === "e2e") { // a real browser drives the app: needs the app URL, a local browser, and your confirmation (forms get submitted)
      const exe = findBrowser();
      if (!(confirmRequests && baseUrl)) entry.status = "not-run", entry.note = !baseUrl ? "needs the app's URL" : "needs your confirmation: the browser will click through the app and submit its forms";
      else if (!exe) entry.status = "not-run", entry.note = "no Chrome/Brave/Chromium found. Install one or set PLAYWRIGHT_EXECUTABLE";
      else {
        const r = await run([playwrightCli, "test", "--config", path.join("tests-generated", "e2e", "playwright.config.mjs"), "--reporter=json"], { cwd: fs.realpathSync(runDir), env: { ...baseEnv, PLAYWRIGHT_EXECUTABLE: exe, BASE_URL: baseUrl, PLAYWRIGHT_JSON_OUTPUT_NAME: "" }, timeoutMs: 240000 });
        entry.ms = r.ms;
        try { entry.tests = parsePlaywright(JSON.parse(r.out.slice(r.out.indexOf("{")))); } catch { entry.tests = []; }
        if (!entry.tests.length) { entry.status = "error"; entry.note = (r.err.split("\n").find((l) => /Error|error/.test(l)) || r.out.slice(0, 160) || "no tests ran").trim().slice(0, 220); }
        else { entry.status = entry.tests.some((t) => t.status === "fail") ? "fail" : "pass"; entry.note = `browser: ${path.basename(exe)}`; }
      }
      results.push(entry); onFile?.(entry); continue;
    }
    if (http && !(confirmRequests && baseUrl)) { entry.status = "not-run"; entry.note = !baseUrl ? "needs the app's URL" : "needs your confirmation: these tests send real requests"; results.push(entry); onFile?.(entry); continue; }
    // Real paths + a relative entry file: on macOS /tmp is a symlink, and resolving it would need read access to /tmp itself.
    const realRun = fs.realpathSync(runDir), realRoot = fs.realpathSync(projectRoot || runDir);
    const entryFile = path.join("tests-generated", f.path);
    const args = http ? ["--test-reporter=junit", entryFile] : ["--permission", `--allow-fs-read=${realRoot}`, `--allow-fs-read=${realRun}`, "--test-reporter=junit", entryFile];
    const r = await run(args, { cwd: realRun, env: http ? baseEnv : { NODE_ENV: "test", PATH: process.env.PATH }, timeoutMs: http ? 120000 : 60000 });
    entry.ms = r.ms;
    const xmlStart = r.out.indexOf("<?xml");
    const tests = xmlStart >= 0 ? parseJunit(r.out.slice(xmlStart)) : [];
    entry.tests = tests;
    if (!tests.length) {
      entry.status = "error";
      const msg = (r.err.split("\n").find((l) => /Error|error|ERR_/.test(l)) || r.err.split("\n").find((l) => l.trim()) || (r.killed ? "timed out" : "no tests ran")).trim();
      entry.note = (/ERR_ACCESS_DENIED|Permission/.test(r.err) ? "blocked by the sandbox: the module tried to do something not allowed (write files, run programs). " : "") + msg.slice(0, 220);
    } else {
      const failed = tests.filter((t) => t.status === "fail").length;
      const found = tests.filter((t) => t.status === "finding").length;
      entry.status = failed ? "fail" : found ? "findings" : tests.every((t) => t.status === "skip") ? "skipped" : "pass";
      if (r.killed) entry.note = "timed out";
    }
    results.push(entry); onFile?.(entry);
  }
  const all = results.flatMap((r) => r.tests);
  return { results, totals: { passed: all.filter((t) => t.status === "pass").length, failed: all.filter((t) => t.status === "fail").length, findings: all.filter((t) => t.status === "finding").length, skipped: all.filter((t) => t.status === "skip").length, filesNotRun: results.filter((r) => r.status === "not-run").length, filesErrored: results.filter((r) => r.status === "error").length } };
}
