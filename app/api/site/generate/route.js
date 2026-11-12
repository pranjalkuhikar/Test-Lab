import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { guard, fail } from "@/lib/guard";
import { loadJson, saveJson } from "@/lib/store";
import { siteFiles } from "@/engine/web/generate";

export const dynamic = "force-dynamic";

export async function POST(req) {
  const denied = guard(req);
  if (denied) return denied;
  const b = await req.json().catch(() => ({}));
  const m = loadJson("sites", b.siteId);
  if (!m) return fail(404, "Analysis not found: analyse the site again");
  const layers = (Array.isArray(b.layers) ? b.layers : []).filter((l) => ["e2e", "a11y", "perf", "visual", "seo", "security", "links", "contract"].includes(l));
  if (!layers.length) return fail(400, "Pick at least one kind of test");
  const out = siteFiles(m.site, m.analysis, m.rec, layers);
  const id = crypto.randomBytes(5).toString("hex");
  saveJson("gens", id, { id, kind: "site", siteId: m.id, createdAt: Date.now(), baseUrl: m.site.origin, layers, files: out.files });
  const byLayer = {};
  for (const f of out.files) if (!f.support) byLayer[f.layer] = (byLayer[f.layer] || 0) + f.tests;
  return NextResponse.json({ id, summary: { files: out.files.filter((f) => !f.support).length, tests: out.count, byLayer }, files: out.files.map((f) => ({ path: f.path, layer: f.layer, tests: f.tests, support: !!f.support, content: f.content })), skipped: out.skipped });
}
