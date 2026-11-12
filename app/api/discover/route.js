import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { guard } from "@/lib/guard";

export const dynamic = "force-dynamic";
const PORTS = [3000, 3001, 3002, 3100, 4000, 4010, 4100, 4200, 4500, 5000, 5050, 5173, 8000, 8080, 8081, 9000];
const isOpen = (port) => new Promise((resolve) => { const s = net.connect({ host: "localhost", port, timeout: 300 }); s.once("connect", () => { s.destroy(); resolve(true); }); s.once("timeout", () => { s.destroy(); resolve(false); }); s.once("error", () => resolve(false)); });
const identify = (port) => new Promise((resolve) => {
  const req = http.get({ host: "localhost", port, path: "/", timeout: 1500 }, (res) => { res.resume(); const p = String(res.headers["x-powered-by"] || ""), s = String(res.headers.server || ""); resolve({ ok: !/airtunes|airplay/i.test(s), name: /next/i.test(p) ? "Next.js" : /express/i.test(p) ? "Express" : s ? s.split("/")[0].slice(0, 16) : "HTTP server" }); });
  req.on("timeout", () => { req.destroy(); resolve({ ok: false }); }); req.on("error", () => resolve({ ok: false }));
});

export async function GET(req) {
  const denied = guard(req);
  if (denied) return denied;
  const own = Number((req.headers.get("host") || "").split(":")[1]) || 0;
  const open = (await Promise.all(PORTS.filter((p) => p !== own).map(async (p) => ((await isOpen(p)) ? p : null)))).filter(Boolean);
  const servers = (await Promise.all(open.map(async (port) => ({ port, url: `http://localhost:${port}`, ...(await identify(port)) })))).filter((s) => s.ok);
  // sibling folders that look like projects, so scanning is one click
  const parent = path.dirname(process.cwd());
  let projects = [];
  try { projects = fs.readdirSync(parent, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".") && fs.existsSync(path.join(parent, d.name, "package.json"))).map((d) => ({ name: d.name, dir: path.join(parent, d.name) })); } catch {}
  return NextResponse.json({ servers, projects, here: path.basename(process.cwd()) });
}
