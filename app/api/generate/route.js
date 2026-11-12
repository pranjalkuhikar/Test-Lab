import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { guard, fail, isLoopbackUrl } from "@/lib/guard";
import { loadJson, saveJson } from "@/lib/store";
import { generateTests } from "@/engine/generate/index";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req) {
  const denied = guard(req);
  if (denied) return denied;
  const b = await req.json().catch(() => ({}));
  const model = loadJson("scans", b.scanId);
  if (!model) return fail(404, "Scan not found: scan the project again");
  const baseUrl = String(b.baseUrl || "").trim();
  if (baseUrl && !process.env.ALLOW_REMOTE && !isLoopbackUrl(baseUrl)) return fail(400, "Only localhost URLs are allowed (the tool sends real requests to this address).");
  const layers = (Array.isArray(b.layers) ? b.layers : []).filter((l) => ["unit", "integration", "contract", "pact", "e2e"].includes(l));
  if (!layers.length) return fail(400, "Pick at least one test layer");
  const out = await generateTests(model, { layers, flavor: b.flavor === "vitest" ? "vitest" : "node", baseUrl, token: String(b.token || "") });
  const id = crypto.randomBytes(5).toString("hex");
  saveJson("gens", id, { id, scanId: model.id, createdAt: Date.now(), flavor: b.flavor === "vitest" ? "vitest" : "node", baseUrl, layers, expectAuth: out.summary.expectAuth, files: out.files });
  return NextResponse.json({ id, summary: out.summary, files: out.files.map((f) => ({ path: f.path, layer: f.layer, tests: f.tests, support: !!f.support, data: !!f.data, content: f.content })), skipped: out.skipped, notes: out.notes, probes: out.probes });
}
