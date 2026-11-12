// Runs the generated tests and reports what passed.
//  • unit tests run in a restricted child process (node --permission: no file writes, no subprocesses)
//  • API/contract tests send real requests to the app, so they only run against localhost and only after explicit confirmation
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

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
    if (f.layer === "unit" && projectRoot) content = content.replace(/new URL\("(?:\.\.\/)+([^"]+)", import\.meta\.url\)/, (_, p) => `new URL(${JSON.stringify(pathToFileURL(path.join(projectRoot, p)).href)})`);
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
  const wanted = files.filter((f) => !f.support && !f.data && f.tests > 0 && (layers.includes(f.layer) || f.layer === "ai") && f.layer !== "e2e");
  const baseEnv = { ...process.env, BASE_URL: baseUrl || "", TEST_TOKEN: token || "", ...(expectAuth !== undefined ? { EXPECT_AUTH: expectAuth ? "1" : "0" } : {}), NODE_ENV: "test" };
  for (const f of wanted) {
    const abs = path.join(root, f.path);
    const entry = { path: f.path, layer: f.layer, tests: [], status: "pass", ms: 0 };
    const http = f.layer !== "unit" && !(f.layer === "ai" && f.path.startsWith("unit/"));
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
