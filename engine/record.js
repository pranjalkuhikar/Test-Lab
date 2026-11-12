// Records what a function ACTUALLY does for a set of inputs, inside a restricted child process.
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function recordUnit(unit, cases, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--permission", `--allow-fs-read=${here}`, path.join(here, "record-child.mjs")], { stdio: ["pipe", "pipe", "pipe"], cwd: os.tmpdir() });
    let out = "", err = "", done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ error: "timed out (the function may loop forever)" }); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", () => {
      try { const j = JSON.parse(out); finish(j.fatal ? { error: j.fatal } : { results: j.results }); }
      catch { finish({ error: (err.split("\n").find((l) => l.trim()) || "sandbox produced no output").slice(0, 160) }); }
    });
    child.stdin.end(JSON.stringify({ source: unit.extractSource, name: unit.name, cases }));
  });
}

// Can this module be imported by a plain Node process without help (env vars, a bundler, ...)? Checked in the same sandbox.
export function preflightImport(projectRoot, relFile, timeoutMs = 7000) {
  return new Promise((resolve) => {
    const abs = path.join(projectRoot, relFile);
    const child = spawn(process.execPath, ["--permission", `--allow-fs-read=${here}`, `--allow-fs-read=${projectRoot}`, path.join(here, "preflight-child.mjs"), abs], { stdio: ["ignore", "pipe", "pipe"], cwd: os.tmpdir(), env: { NODE_ENV: "test", PATH: process.env.PATH } });
    let out = "", err = "", done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ ok: false, error: "importing it hangs (it probably starts a server or connection)" }); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", () => { try { finish(JSON.parse(out)); } catch { finish({ ok: false, error: (err.split("\n").find((l) => /Error/.test(l)) || "could not import").slice(0, 200) }); } });
  });
}
