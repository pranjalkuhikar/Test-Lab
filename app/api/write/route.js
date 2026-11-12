import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { guard, fail } from "@/lib/guard";
import { loadJson } from "@/lib/store";

export const dynamic = "force-dynamic";

// Writes the bundle to <project>/tests-generated/. Only on an explicit request, never overwrites unless told to.
export async function POST(req) {
  const denied = guard(req);
  if (denied) return denied;
  const b = await req.json().catch(() => ({}));
  const gen = loadJson("gens", b.genId);
  const model = gen && loadJson("scans", gen.scanId);
  if (!gen || !model) return fail(404, "Generated tests not found");
  const target = path.join(model.dir, "tests-generated");
  if (fs.existsSync(target) && fs.readdirSync(target).length && b.overwrite !== true) return fail(409, `${target} already exists and is not empty. Confirm to overwrite it.`);
  for (const f of gen.files) {
    const abs = path.resolve(target, f.path);
    if (!abs.startsWith(target + path.sep)) return fail(400, "Unsafe file path in bundle");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content);
  }
  return NextResponse.json({ ok: true, dir: target, files: gen.files.length });
}
