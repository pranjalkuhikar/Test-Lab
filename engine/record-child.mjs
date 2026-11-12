// Runs in a restricted child process (node --permission: no file writes, no child processes, no workers).
// Input (stdin JSON): { source, name, isAsync, cases: [{ label, args }] }  → output (stdout JSON): results per case.
import vm from "node:vm";
import { encode, decode } from "./serialize.js";

const input = JSON.parse(await new Promise((r) => { let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => r(d)); }));
const sandbox = { console: { log() {}, warn() {}, error() {}, info() {}, debug() {} } }; // a bare context: no process, no require, no fetch
const ctx = vm.createContext(sandbox);
let fn;
try { fn = vm.runInContext(`${input.source}\n;(${input.name === "default" ? "typeof default_ !== 'undefined' ? default_ : undefined" : input.name})`, ctx, { timeout: 2000 }); }
catch (e) { process.stdout.write(JSON.stringify({ fatal: `could not load function: ${e.message}` })); process.exit(0); }
if (typeof fn !== "function") { process.stdout.write(JSON.stringify({ fatal: "not a function after loading" })); process.exit(0); }

const classify = (v) => ({ kind: "return", value: encode(v) });
const thrown = (e) => ({ kind: "throw", name: String(e?.name ?? "Error"), message: String(e?.message ?? e) });
const settle = async (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("__timeout__")), 1500))]);

const evalExpr = (expr) => vm.runInContext("(" + expr + ")", ctx, { timeout: 800 });

async function runOnce(args) {
  try {
    const out = fn(...args);
    if (out && typeof out.then === "function") return classify(await settle(out));
    return classify(out);
  } catch (e) { return e?.message === "__timeout__" ? { kind: "timeout" } : thrown(e); }
}

const results = [];
for (const c of input.cases) {
  // Inputs come either as tagged JSON (our own edge values) or as a pre-validated expression (AI-proposed, e.g. typed arrays).
  // Each run gets fresh arguments; results that differ between the two runs are non-deterministic and are dropped.
  const makeArgs = () => (c.argsExpr !== undefined ? evalExpr(c.argsExpr) : structuredClone(c.args).map(decode));
  let a, b, error;
  try { const x = makeArgs(); if (!Array.isArray(x)) throw new Error("the inputs expression did not produce an array"); a = await runOnce(x); b = await runOnce(makeArgs()); }
  catch (e) { error = String(e?.message ?? e).slice(0, 160); }
  if (error) { results.push({ label: c.label, argsExpr: c.argsExpr, args: c.args, error, stable: false }); continue; }
  const entry = { label: c.label, args: c.args, argsExpr: c.argsExpr, result: a, stable: JSON.stringify(a) === JSON.stringify(b) && a.kind !== "timeout" };
  if (c.expect) { // what an AI reviewer believes a correct implementation should do: evaluated here so it can be compared with reality
    try { entry.expected = c.expect.kind === "throws" ? { kind: "throw", name: c.expect.errorName || "Error" } : { kind: "return", value: encode(evalExpr(c.expect.valueExpr)) }; }
    catch (e) { entry.expectError = String(e?.message ?? e).slice(0, 120); }
  }
  results.push(entry);
}
process.stdout.write(JSON.stringify({ results }));
