// Only this dashboard (opened on a loopback host) may call the API: blocks DNS-rebinding and drive-by requests from other sites.
import { NextResponse } from "next/server";
const LOOP = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function guard(req) {
  const host = (req.headers.get("host") || "").toLowerCase();
  const origin = req.headers.get("origin");
  let ok = LOOP.has(host.replace(/:\d+$/, ""));
  if (ok && origin) { try { ok = new URL(origin).host.toLowerCase() === host; } catch { ok = false; } }
  return ok ? null : new NextResponse("Forbidden", { status: 403 });
}
export const fail = (status, error) => NextResponse.json({ error }, { status });
export const isLoopbackUrl = (u) => { try { const h = new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, ""); return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost") || h === "host.docker.internal"; } catch { return false; } };
