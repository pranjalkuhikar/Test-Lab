import { NextResponse } from "next/server";
import { guard, fail, isLoopbackUrl } from "@/lib/guard";
import { loadJson, runDir } from "@/lib/store";
import { verify } from "@/engine/verify";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(req) {
  const denied = guard(req);
  if (denied) return denied;
  const b = await req.json().catch(() => ({}));
  const gen = loadJson("gens", b.genId);
  const model = gen && loadJson("scans", gen.scanId);
  if (!gen || !model) return fail(404, "Generated tests not found: generate them again");
  const baseUrl = String(b.baseUrl || gen.baseUrl || "").trim();
  if (baseUrl && !process.env.ALLOW_REMOTE && !isLoopbackUrl(baseUrl)) return fail(400, "Only localhost URLs are allowed.");
  const out = await verify({ files: gen.files, runDir: runDir(gen.id), projectRoot: model.dir, baseUrl, token: String(b.token || ""), expectAuth: gen.expectAuth, layers: Array.isArray(b.layers) ? b.layers : gen.layers, flavor: gen.flavor, confirmRequests: b.confirmRequests === true });
  return NextResponse.json(out);
}
