import { NextResponse } from "next/server";
import { guard, fail } from "@/lib/guard";
import { saveJson, listScans } from "@/lib/store";
import { scanProject } from "@/engine/scan";
import { present } from "@/lib/present";

export const dynamic = "force-dynamic";

export async function GET(req) {
  const denied = guard(req);
  return denied || NextResponse.json({ scans: listScans() });
}

export async function POST(req) {
  const denied = guard(req);
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const model = scanProject(String(body.dir || ""));
  if (model.error) return fail(400, model.error);
  saveJson("scans", model.id, model);
  return NextResponse.json(present(model));
}
