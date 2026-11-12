import { NextResponse } from "next/server";
import { guard, fail } from "@/lib/guard";
import { loadJson, runDir } from "@/lib/store";
import { verifySite } from "@/engine/web/run";

export const dynamic = "force-dynamic";
export const maxDuration = 900;

export async function POST(req) {
  const denied = guard(req);
  if (denied) return denied;
  const b = await req.json().catch(() => ({}));
  const gen = loadJson("gens", b.genId);
  const site = gen && gen.kind === "site" && loadJson("sites", gen.siteId);
  if (!gen || !site || !site.site.consent) return fail(404, "Generated tests not found: generate them again");
  const out = await verifySite({ files: gen.files, runDir: runDir(gen.id), baseUrl: gen.baseUrl, confirm: b.confirm === true });
  return NextResponse.json(out);
}
