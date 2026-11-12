// Can this module be imported on its own (no env vars, no side effects that hang)? Runs under node --permission.
import { pathToFileURL } from "node:url";
try { await import(pathToFileURL(process.argv[2]).href); process.stdout.write(JSON.stringify({ ok: true })); }
catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message ?? e).split("\n")[0].slice(0, 200), code: e?.code || null })); }
process.exit(0); // the module may have left timers or sockets open
