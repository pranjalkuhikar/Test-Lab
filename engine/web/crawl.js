// Polite, read-only website crawler. A real (local) browser renders each page like a visitor would, and we record what we see.
// It never submits forms, never logs in, stays on the same origin, respects robots.txt, and visits one page at a time.
import fs from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { findBrowser } from "../verify.js";

const require = createRequire(import.meta.url);
const SKIP_EXT = /\.(pdf|png|jpe?g|gif|svg|webp|ico|zip|gz|mp4|mp3|webm|woff2?|ttf|css|js|json|xml|txt|docx?|xlsx?)(\?|$)/i;
const SKIP_PATH = /(logout|signout|sign-out|log-out|delete|remove|unsubscribe)/i;

const normalize = (u) => { try { const x = new URL(u); x.hash = ""; if (x.pathname.length > 1) x.pathname = x.pathname.replace(/\/+$/, ""); return x.toString(); } catch { return null; } };

function parseRobots(text, ua = "testlab") {
  const rules = { disallow: [], allow: [], crawlDelay: 0, sitemaps: [] };
  let applies = false, seen = false;
  for (const raw of text.split("\n")) {
    const line = raw.split("#")[0].trim(); if (!line) continue;
    const [k, ...rest] = line.split(":"); const key = k.trim().toLowerCase(), val = rest.join(":").trim();
    if (key === "sitemap") { rules.sitemaps.push(val); continue; }
    if (key === "user-agent") { applies = val === "*" || val.toLowerCase().includes(ua); seen = seen || applies; continue; }
    if (!applies) continue;
    if (key === "disallow" && val) rules.disallow.push(val);
    if (key === "allow" && val) rules.allow.push(val);
    if (key === "crawl-delay") rules.crawlDelay = Math.min(10, Number(val) || 0);
  }
  rules.allowed = (p) => { const hit = (list) => list.filter((r) => p.startsWith(r.replace(/\*$/, ""))).sort((a, b) => b.length - a.length)[0]; const d = hit(rules.disallow), a = hit(rules.allow); return !d || (a && a.length >= d.length); };
  return rules;
}

const fetchText = async (url, ms = 8000) => { try { const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(ms), headers: { "user-agent": "TestLab/1.0 (read-only site analysis)" } }); return { status: r.status, text: r.status < 400 ? (await r.text()).slice(0, 400_000) : "", headers: Object.fromEntries(r.headers), location: r.headers.get("location") }; } catch (e) { return { status: 0, error: e.message }; } };

// ---- what to read from a rendered page (runs inside the browser)
const EXTRACT = () => {
  const abs = (h) => { try { return new URL(h, location.href).toString(); } catch { return null; } };
  const meta = (n) => document.querySelector(`meta[name="${n}"],meta[property="${n}"]`)?.content || null;
  const labelOf = (el) => { const id = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`); return (id || el.closest("label"))?.textContent?.trim().slice(0, 60) || el.getAttribute("aria-label") || el.placeholder || null; };
  const imgs = [...document.images];
  const nav = performance.getEntriesByType("navigation")[0] || {};
  const res = performance.getEntriesByType("resource");
  return {
    title: document.title, lang: document.documentElement.lang || null, description: meta("description"), canonical: document.querySelector('link[rel="canonical"]')?.href || null,
    viewport: meta("viewport"), ogTitle: meta("og:title"), ogImage: meta("og:image"), robotsMeta: meta("robots"), generator: meta("generator"),
    h1: [...document.querySelectorAll("h1")].map((h) => h.textContent.trim().slice(0, 100)), headings: document.querySelectorAll("h1,h2,h3").length,
    links: [...document.querySelectorAll("a[href]")].map((a) => ({ href: abs(a.getAttribute("href")), text: (a.textContent || a.getAttribute("aria-label") || "").trim().slice(0, 50) })).filter((l) => l.href),
    forms: [...document.forms].map((f) => ({ action: abs(f.getAttribute("action") || "") || location.href, method: (f.method || "get").toUpperCase(), fields: [...f.elements].filter((e) => e.name || e.id).filter((e) => !["submit", "button", "hidden"].includes(e.type)).map((e) => ({ name: e.name || e.id, type: e.type || e.tagName.toLowerCase(), required: e.required, label: labelOf(e), autocomplete: e.autocomplete || null })), hasSubmit: !!f.querySelector('[type="submit"],button:not([type])') })),
    buttons: document.querySelectorAll("button,[role=button]").length,
    images: { total: imgs.length, missingAlt: imgs.filter((i) => !i.hasAttribute("alt")).length, lazy: imgs.filter((i) => i.loading === "lazy").length, noSize: imgs.filter((i) => !i.getAttribute("width") && !i.getAttribute("height") && !i.naturalWidth).length },
    scripts: [...document.scripts].map((s) => s.src).filter(Boolean), inlineScripts: [...document.scripts].filter((s) => !s.src).length, iframes: [...document.querySelectorAll("iframe")].map((i) => i.src).filter(Boolean),
    framework: { next: !!window.__NEXT_DATA__ || !!document.querySelector('script[src*="/_next/"]'), react: !!document.querySelector("[data-reactroot]") || !!window.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers?.size, vue: !!window.__VUE__ || !!document.querySelector("[data-v-app]"), angular: !!document.querySelector("[ng-version]"), nuxt: !!window.__NUXT__, gatsby: !!document.getElementById("___gatsby"), wordpress: !!document.querySelector('link[href*="wp-content"],script[src*="wp-content"]'), shopify: !!window.Shopify, svelte: !!document.querySelector('[class*="svelte-"]') },
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 2, textLength: (document.body?.innerText || "").length,
    timing: { dcl: Math.round(nav.domContentLoadedEventEnd || 0), load: Math.round(nav.loadEventEnd || 0), ttfb: Math.round(nav.responseStart || 0), transferKB: Math.round(res.reduce((a, r) => a + (r.encodedBodySize || 0), nav.encodedBodySize || 0) / 1024), requests: res.length + 1 },
  };
};
// largest-contentful-paint / layout-shift as the browser measured them
const VITALS = () => new Promise((resolve) => {
  const out = { lcp: null, cls: 0, fcp: null };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) out.lcp = Math.round(e.startTime); }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) out.cls += e.value; }).observe({ type: "layout-shift", buffered: true });
    out.fcp = Math.round(performance.getEntriesByName("first-contentful-paint")[0]?.startTime || 0) || null;
  } catch {}
  setTimeout(() => { out.cls = Math.round(out.cls * 1000) / 1000; resolve(out); }, 900);
});

export async function crawlSite(startUrl, opts = {}) {
  const { maxPages = 12, delayMs = 800, deadlineMs = 170_000, onProgress = () => {} } = opts;
  const start = normalize(startUrl);
  if (!start || !/^https?:$/.test(new URL(start).protocol)) throw Object.assign(new Error("Enter a full http(s) address, e.g. https://example.com"), { status: 400 });
  const origin = new URL(start).origin;
  const exe = findBrowser();
  if (!exe) throw Object.assign(new Error("No Chrome, Brave, Chromium or Edge was found on this machine. Install one (or set PLAYWRIGHT_EXECUTABLE) so pages can be rendered."), { status: 400 });

  const site = { url: start, origin, host: new URL(start).host, scannedAt: Date.now(), pages: [], checks: {}, apis: [], thirdParty: {}, notes: [], blocked: [] };
  const t0 = Date.now();

  // ---- robots.txt first: if the site asks not to be crawled, we stop
  const robotsRes = await fetchText(origin + "/robots.txt");
  const robots = robotsRes.status === 200 ? parseRobots(robotsRes.text) : { disallow: [], allow: [], sitemaps: [], crawlDelay: 0, allowed: () => true };
  site.checks.robots = { present: robotsRes.status === 200, disallowAll: robots.disallow.includes("/"), sitemaps: robots.sitemaps, rules: robots.disallow.length };
  if (!robots.allowed(new URL(start).pathname)) throw Object.assign(new Error("This site's robots.txt asks automated tools not to visit that path, so TestLab stopped."), { status: 403 });
  const delay = Math.max(delayMs, (robots.crawlDelay || 0) * 1000);

  const browser = await chromium.launch({ executablePath: exe, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: false });
    const axeSource = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
    const queue = [start], seen = new Set([start]);
    while (queue.length && site.pages.length < maxPages && Date.now() - t0 < deadlineMs) {
      const url = queue.shift();
      onProgress(`Visiting ${url.replace(origin, "") || "/"}  (${site.pages.length + 1}/${maxPages})`);
      const page = await context.newPage();
      const rec = { url, path: new URL(url).pathname + new URL(url).search, status: null, errors: [], consoleErrors: [], failedRequests: [], requests: [] };
      page.on("pageerror", (e) => rec.errors.push(String(e.message).slice(0, 160)));
      page.on("console", (m) => { if (m.type() === "error" && !/favicon/i.test(m.text())) rec.consoleErrors.push(m.text().slice(0, 160)); });
      page.on("requestfailed", (r) => rec.failedRequests.push({ url: r.url().slice(0, 140), reason: r.failure()?.errorText }));
      page.on("response", (r) => {
        const req = r.request(), type = req.resourceType(), u = r.url();
        let o; try { o = new URL(u).origin; } catch { return; }
        if (o !== origin) site.thirdParty[new URL(u).host] = (site.thirdParty[new URL(u).host] || 0) + 1;
        if (r.status() >= 400 && o === origin) rec.failedRequests.push({ url: u.slice(0, 140), status: r.status() });
        if ((type === "fetch" || type === "xhr")) rec.requests.push({ url: u.split("#")[0], method: req.method(), status: r.status(), type: r.headers()["content-type"] || "" });
      });
      try {
        const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 25_000 });
        rec.status = resp?.status() ?? null;
        rec.finalUrl = page.url();
        if (new URL(rec.finalUrl).origin !== origin) { rec.redirectedAway = rec.finalUrl; site.notes.push(`${rec.path} redirects to another site (${new URL(rec.finalUrl).host}); not followed`); await page.close(); continue; }
        const headers = resp?.headers() || {};
        rec.headers = Object.fromEntries(["strict-transport-security", "content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy", "permissions-policy", "cache-control", "content-encoding", "server", "x-powered-by", "x-vercel-id", "cf-ray", "set-cookie"].filter((h) => headers[h]).map((h) => [h, headers[h].slice(0, 300)]));
        if ([401, 403, 429].includes(rec.status) || /just a moment|attention required|access denied/i.test(await page.title())) { site.blocked.push({ url, status: rec.status }); rec.blocked = true; }
        else {
          Object.assign(rec, await page.evaluate(EXTRACT));
          rec.vitals = await page.evaluate(VITALS);
          try { await page.addScriptTag({ content: axeSource }); rec.axe = await page.evaluate(async () => { const r = await window.axe.run({ resultTypes: ["violations"] }); return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, count: v.nodes.length, example: v.nodes[0]?.target?.[0] || null })); }); } catch (e) { rec.axe = null; rec.axeError = String(e.message).slice(0, 80); }
          if (site.pages.length === 0) {
            const cookies = await context.cookies(); rec.cookies = cookies.map((c) => ({ name: c.name, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite }));
          }
          // discover more pages (same origin, HTML-looking, not already seen)
          for (const l of rec.links || []) {
            const n = normalize(l.href); if (!n || seen.has(n) || !n.startsWith(origin)) continue;
            const p = new URL(n); if (SKIP_EXT.test(p.pathname) || SKIP_PATH.test(p.pathname) || !robots.allowed(p.pathname)) continue;
            seen.add(n); if (queue.length + site.pages.length < maxPages * 3) queue.push(n);
          }
        }
      } catch (e) { rec.error = String(e.message).split("\n")[0].slice(0, 140); }
      rec.links = (rec.links || []).slice(0, 150);
      site.pages.push(rec);
      await page.close();
      await new Promise((r) => setTimeout(r, delay));
    }
    if (queue.length) site.notes.push(`Stopped after ${site.pages.length} pages (${queue.length} more were found). Raise the page limit to see more.`);

    // ---- API calls the pages made (the "backend" a website talks to)
    const api = new Map();
    for (const p of site.pages) for (const r of p.requests || []) { const k = `${r.method} ${r.url.split("?")[0]}`; if (!api.has(k)) api.set(k, { ...r, urlNoQuery: r.url.split("?")[0], sameOrigin: r.url.startsWith(origin), pages: [p.path] }); }
    site.apis = [...api.values()].slice(0, 40);

    // ---- site-level checks (plain HTTP, no browser)
    const home = new URL(start);
    const [sitemap, nf, http] = await Promise.all([
      fetchText(origin + "/sitemap.xml"), fetchText(origin + "/testlab-check-" + Math.random().toString(36).slice(2, 8)),
      home.protocol === "https:" ? fetchText("http://" + home.host + "/") : Promise.resolve(null),
    ]);
    site.checks.sitemap = { present: sitemap.status === 200 && /<urlset|<sitemapindex/.test(sitemap.text), urls: (sitemap.text.match(/<loc>/g) || []).length };
    site.checks.notFound = { status: nf.status, goodStatus: nf.status === 404, soft404: nf.status === 200 };
    site.checks.httpsRedirect = http ? { status: http.status, redirects: [301, 302, 307, 308].includes(http.status) && /^https:/i.test(http.location || "") } : null;
    site.checks.https = home.protocol === "https:";
  } finally { await browser.close(); }
  site.durationMs = Date.now() - t0;
  return site;
}
