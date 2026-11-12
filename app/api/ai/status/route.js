import { NextResponse } from "next/server";
import { guard } from "@/lib/guard";
import { MODELS, DEFAULT_MODEL, hasServerCredentials } from "@/engine/ai/client";

export const dynamic = "force-dynamic";

export async function GET(req) {
  const denied = guard(req);
  if (denied) return denied;
  return NextResponse.json({ serverKey: hasServerCredentials(), defaultModel: DEFAULT_MODEL, models: Object.entries(MODELS).map(([id, m]) => ({ id, ...m })) });
}
