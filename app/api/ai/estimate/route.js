import { NextResponse } from "next/server";
import { guard, fail } from "@/lib/guard";
import { loadJson } from "@/lib/store";
import { estimateAi } from "@/engine/ai/enhance";

export const dynamic = "force-dynamic";

export async function POST(req) {
  const denied = guard(req);
  if (denied) return denied;
  const b = await req.json().catch(() => ({}));
  const model = loadJson("scans", b.scanId);
  if (!model) return fail(404, "Scan not found");
  const candidates = model.units.filter((u) => u.pure && u.exported && (u.complexity > 1 || u.params.length > 0) && /\.(js|mjs|cjs)$/.test(u.file)).map((u) => u.id);
  return NextResponse.json(estimateAi(model, { testedUnits: candidates }, { model: b.model, maxUnits: Number(b.maxUnits) || 10, maxRoutes: Number(b.maxRoutes) || 8 }));
}
