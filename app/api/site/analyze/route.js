import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { guard, fail } from "@/lib/guard";
import { saveJson } from "@/lib/store";
import { crawlSite } from "@/engine/web/crawl";
import { analyzeSite } from "@/engine/web/analyze";
import { recommendSite } from "@/engine/web/recommend";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Addresses that must never be fetched on someone's behalf (cloud metadata / link-local)
const FORBIDDEN = /^(169\.254\.|0\.0\.0\.0|metadata\.google\.internal)/;

export async function POST(req) {
  const denied = guard(req);
  if (denied) return denied;
  const b = await req.json().catch(() => ({}));
  if (b.consent !== true) return fail(400, "Please confirm that you own this website or have permission to test it.");
  let url;
  try { url = new URL(String(b.url || "").trim().match(/^https?:\/\//i) ? String(b.url).trim() : "https://" + String(b.url || "").trim()); } catch { return fail(400, "Enter a website address, e.g. https://example.com"); }
  if (FORBIDDEN.test(url.hostname)) return fail(400, "That address is not allowed.");
  try {
    const site = await crawlSite(url.toString(), { maxPages: Math.min(Math.max(Number(b.maxPages) || 10, 1), 30) });
    const analysis = await analyzeSite(site);
    const rec = recommendSite(site, analysis);
    const id = crypto.randomBytes(5).toString("hex");
    site.id = id; site.consent = true;
    saveJson("sites", id, { id, site, analysis, rec });
    return NextResponse.json(present(id, site, analysis, rec));
  } catch (e) { return fail(e.status || 500, e.message || "Analysis failed"); }
}

export function present(id, site, an, rec) {
  return {
    id, url: site.url, host: site.host, durationMs: site.durationMs, profile: an.profile, counts: an.counts, issues: an.issues, mix: rec.mix, notes: [...rec.notes, ...site.notes], basis: rec.basis, links: an.links,
    checks: site.checks, thirdParty: site.thirdParty, apis: site.apis.map(({ sample, ...a }) => a), blocked: site.blocked,
    pages: site.pages.map((p) => ({ path: p.path, status: p.status, title: p.title || null, h1: (p.h1 || [])[0] || null, forms: (p.forms || []).length, links: (p.links || []).length, axe: p.axe ? p.axe.length : null, lcp: p.vitals?.lcp ?? null, cls: p.vitals?.cls ?? null, loadMs: p.timing?.load ?? null, kb: p.timing?.transferKB ?? null, errors: (p.consoleErrors?.length || 0) + (p.errors?.length || 0), blocked: !!p.blocked, error: p.error || null })),
  };
}
