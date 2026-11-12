import { NextResponse } from "next/server";
import { guard, fail } from "@/lib/guard";
import { loadJson } from "@/lib/store";
import { present } from "@/lib/present";

export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  const denied = guard(req);
  if (denied) return denied;
  const model = loadJson("scans", (await params).id);
  return model ? NextResponse.json(present(model)) : fail(404, "Scan not found");
}
