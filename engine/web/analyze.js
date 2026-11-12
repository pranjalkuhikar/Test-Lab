// Turns raw crawl data into (1) problems visible right now, (2) a profile of the site, (3) link health.
const SEV = { high: 3, medium: 2, low: 1, info: 0 };
const uniq = (a) => [...new Set(a)];

async function checkLinks(site, max = 40) {
  const visited = new Map(site.pages.map((p) => [p.url.split("#")[0], p.status]));
  const todo = new Set();
  for (const p of site.pages) for (const l of p.links || []) { const u = (l.href || "").split("#")[0]; if (u.startsWith(site.origin) && !visited.has(u) && !/\.(pdf|zip|png|jpe?g|svg|webp|gif|mp4)$/i.test(u)) todo.add(u); }
  const out = { checked: 0, broken: [], skipped: Math.max(0, todo.size - max) };
  for (const u of [...todo].slice(0, max)) {
    try { const r = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(8000), headers: { "user-agent": "TestLab/1.0 (read-only site analysis)" } }); out.checked++; if (r.status >= 400) out.broken.push({ url: u, status: r.status }); }
    catch { out.checked++; out.broken.push({ url: u, status: 0 }); }
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const p of site.pages) if (p.status >= 400) out.broken.push({ url: p.url, status: p.status });
  return out;
}

export async function analyzeSite(site) {
  const issues = [];
  const add = (severity, category, title, detail, fix, pages = [], extra = {}) => issues.push({ id: issues.length + 1, severity, category, title, detail, fix, pages: uniq(pages).slice(0, 8), ...extra });
  const pages = site.pages.filter((p) => !p.blocked && !p.error && p.status && p.status < 400 && p.title !== undefined);
  const home = pages[0];

  if (site.blocked.length) add("info", "reliability", "The site's bot protection blocked some requests", `${site.blocked.length} page${site.blocked.length === 1 ? " was" : "s were"} refused (${site.blocked.map((b) => b.status).join(", ")}). TestLab does not try to get around protections, so those pages were not analysed.`, "Allow your own IP in the host's firewall/bot settings while testing, or lower the page limit.", site.blocked.map((b) => b.url));
  for (const p of site.pages.filter((x) => x.error)) add("high", "reliability", `Page failed to load: ${p.path}`, p.error, "Check that the page responds and renders without errors.", [p.url]);

  // ---------- accessibility (axe-core, run in the real rendered page)
  const rules = new Map();
  for (const p of pages) for (const v of p.axe || []) { const r = rules.get(v.id) || { ...v, count: 0, pages: [] }; r.count += v.count; r.pages.push(p.url); rules.set(v.id, r); }
  for (const r of rules.values()) add(r.impact === "critical" ? "high" : r.impact === "serious" ? "medium" : "low", "accessibility", `${r.help}`, `${r.count} element${r.count === 1 ? "" : "s"} on ${r.pages.length} page${r.pages.length === 1 ? "" : "s"} (${r.impact}). Example: ${r.example || "n/a"}`, `See ${r.helpUrl}`, r.pages, { rule: r.id, count: r.count });
  const noAlt = pages.reduce((a, p) => a + (p.images?.missingAlt || 0), 0);
  if (noAlt) add("medium", "accessibility", "Images without an alt attribute", `${noAlt} image${noAlt === 1 ? "" : "s"} have no alt text, so screen readers and search engines can't describe them.`, 'Add alt="…" (or alt="" for purely decorative images).', pages.filter((p) => p.images?.missingAlt).map((p) => p.url));

  // ---------- SEO / metadata
  const seoAdd = (cond, sev, title, detail, fix) => { const bad = pages.filter(cond); if (bad.length) add(sev, "seo", title, `${detail} (${bad.length} of ${pages.length} pages)`, fix, bad.map((p) => p.url)); };
  seoAdd((p) => !p.title?.trim(), "high", "Missing page title", "Pages have no <title>", "Give every page a unique, descriptive <title>.");
  seoAdd((p) => p.title && (p.title.length < 10 || p.title.length > 70), "low", "Page title length", "Titles are shorter than 10 or longer than 70 characters", "Aim for 30–60 characters so search results show the whole title.");
  seoAdd((p) => !p.description, "medium", "Missing meta description", "No <meta name=\"description\">", "Add a 50–160 character description: it is what search results show under your link.");
  seoAdd((p) => (p.h1?.length || 0) !== 1, "low", "Page should have exactly one <h1>", "Zero or several <h1> elements", "Use a single <h1> for the main topic and <h2>/<h3> below it.");
  seoAdd((p) => !p.lang, "medium", "Missing lang attribute on <html>", "No language declared", 'Add <html lang="en"> (or your language): it helps screen readers and translation.');
  seoAdd((p) => !p.viewport, "high", "Missing viewport meta tag", "The page is not set up for mobile screens", 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.');
  seoAdd((p) => !p.canonical, "info", "No canonical URL", "No <link rel=\"canonical\">", "Add a canonical link to avoid duplicate-content confusion (e.g. www vs non-www).");
  seoAdd((p) => !p.ogTitle || !p.ogImage, "low", "Missing Open Graph tags", "og:title / og:image are missing, so shared links look plain", "Add og:title, og:description and og:image for nicer previews on social networks and chat apps.");
  seoAdd((p) => /noindex/i.test(p.robotsMeta || ""), "medium", "Page is marked noindex", "Search engines are told not to index it", "Remove noindex if the page should appear in search.");
  if (!site.checks.sitemap?.present) add("low", "seo", "No sitemap.xml", "/sitemap.xml was not found", "Publish a sitemap so search engines discover all pages.");
  if (!site.checks.robots?.present) add("info", "seo", "No robots.txt", "/robots.txt was not found", "Add a robots.txt (it can simply allow everything and point to the sitemap).");

  // ---------- security (passive: only reads headers/cookies the site already sends)
  const h = home?.headers || {};
  const hasCsp = !!h["content-security-policy"];
  if (site.checks.https && !h["strict-transport-security"]) add("medium", "security", "No HSTS header", "Browsers aren't told to always use HTTPS for this site.", "Send Strict-Transport-Security: max-age=31536000; includeSubDomains.", [home?.url]);
  if (home && !hasCsp) add("medium", "security", "No Content-Security-Policy", "Nothing limits which scripts and resources the page may load, which is the main defence against cross-site scripting.", "Start with a report-only policy and tighten it. Frameworks like Next.js document nonce-based CSP.", [home.url]);
  if (home && !h["x-content-type-options"]) add("low", "security", "No X-Content-Type-Options", "Browsers may guess content types.", "Send X-Content-Type-Options: nosniff.", [home.url]);
  if (home && !h["referrer-policy"]) add("low", "security", "No Referrer-Policy", "Full URLs may leak to other sites in the Referer header.", "Send Referrer-Policy: strict-origin-when-cross-origin.", [home.url]);
  if (home && !h["x-frame-options"] && !/frame-ancestors/i.test(h["content-security-policy"] || "")) add("medium", "security", "Page can be embedded in other sites (clickjacking)", "Neither X-Frame-Options nor CSP frame-ancestors is set.", "Send X-Frame-Options: DENY (or CSP frame-ancestors 'self').", [home.url]);
  if (h["x-powered-by"]) add("info", "security", "Technology disclosed in X-Powered-By", `The server announces "${h["x-powered-by"]}".`, "Remove the header: it only helps attackers pick exploits.", [home?.url]);
  for (const c of home?.cookies || []) { const bad = []; if (site.checks.https && !c.secure) bad.push("Secure"); if (!c.httpOnly) bad.push("HttpOnly"); if (!c.sameSite || c.sameSite === "None") bad.push("SameSite"); if (bad.length) add("low", "security", `Cookie "${c.name}" lacks ${bad.join(", ")}`, "Cookie flags protect against theft and cross-site requests.", "Set Secure, HttpOnly and SameSite=Lax (or Strict) where the cookie allows it.", [home.url]); }
  if (site.checks.https && site.checks.httpsRedirect && !site.checks.httpsRedirect.redirects) add("high", "security", "http:// does not redirect to https://", `Requesting the http address answered ${site.checks.httpsRedirect.status}.`, "Redirect all http traffic to https (301).");
  if (!site.checks.https) add("high", "security", "Site is served over plain http", "Traffic can be read and altered in transit.", "Serve the site over HTTPS.");

  // ---------- reliability
  for (const p of pages) if (p.consoleErrors?.length || p.errors?.length) {
    const net = !p.errors?.length && p.consoleErrors.every((e) => /Failed to load resource|net::ERR/i.test(e)); // network hiccups, not code errors
    add(net ? "low" : "medium", "reliability", net ? `Some resources failed to load on ${p.path}` : `JavaScript errors on ${p.path}`, [...p.errors, ...p.consoleErrors].slice(0, 3).join(" · "), net ? "Usually a slow or blocked third-party request. Re-check; if it repeats, fix or remove the reference." : "Open the browser console on this page and fix the errors.", [p.url]);
  }
  const failedReq = pages.flatMap((p) => (p.failedRequests || []).filter((f) => f.status).map((f) => ({ ...f, page: p.url })));
  if (failedReq.length) add("medium", "reliability", "Resources that fail to load", `${failedReq.length} request${failedReq.length === 1 ? "" : "s"} returned errors, e.g. ${failedReq[0].url.slice(0, 80)} (${failedReq[0].status})`, "Fix or remove the broken references.", failedReq.map((f) => f.page));
  if (site.checks.notFound?.soft404) add("medium", "reliability", "Unknown URLs return 200 instead of 404", "A made-up address answered 200, so broken links look fine to search engines and monitors.", "Return a real 404 status (with a friendly page) for unknown routes.");
  const mobileOverflow = pages.filter((p) => p.overflowX);
  if (mobileOverflow.length) add("medium", "reliability", "Horizontal scrolling at desktop width", "Some content is wider than the screen.", "Find the element that overflows (often a wide image, table or fixed width).", mobileOverflow.map((p) => p.url));

  // ---------- performance (as measured by this browser on this connection)
  for (const p of pages) {
    const v = p.vitals || {}, t = p.timing || {};
    if (v.lcp > 4000) add("high", "performance", `Slow largest paint on ${p.path}`, `LCP ${v.lcp} ms (good is under 2500 ms)`, "Optimise the hero image/text, serve it from a CDN, preload it.", [p.url]);
    else if (v.lcp > 2500) add("medium", "performance", `Largest paint could be faster on ${p.path}`, `LCP ${v.lcp} ms (good is under 2500 ms)`, "Compress and size images, preload the main image, reduce render-blocking scripts.", [p.url]);
    if (v.cls > 0.1) add("medium", "performance", `Layout shifts on ${p.path}`, `CLS ${v.cls} (good is under 0.1)`, "Reserve space for images, embeds and fonts with width/height or aspect-ratio.", [p.url]);
    if (t.transferKB > 3000) add("medium", "performance", `Heavy page: ${p.path}`, `About ${Math.round(t.transferKB / 1024 * 10) / 10} MB transferred in ${t.requests} requests`, "Compress images (WebP/AVIF), lazy-load below-the-fold media, split large JavaScript bundles.", [p.url]);
    if (p.images?.total > 6 && p.images.lazy === 0) add("low", "performance", `Images not lazy-loaded on ${p.path}`, `${p.images.total} images, none with loading="lazy"`, 'Add loading="lazy" to images below the fold.', [p.url]);
  }
  if (home && !h["content-encoding"]) add("low", "performance", "HTML is not compressed", "The main document had no content-encoding (gzip/brotli).", "Enable compression on your host or CDN.", [home.url]);
  const tp = Object.keys(site.thirdParty);
  if (tp.length > 8) add("low", "performance", "Many third-party hosts", `${tp.length} external hosts are contacted (${tp.slice(0, 5).join(", ")}…)`, "Each one costs time and privacy; remove what you don't need.");

  // ---------- links
  const links = await checkLinks(site);
  if (links.broken.length) add("high", "links", "Broken links", `${links.broken.length} internal link${links.broken.length === 1 ? "" : "s"} do not work, e.g. ${links.broken[0].url.replace(site.origin, "")} (${links.broken[0].status || "no response"})`, "Fix or remove them, or add redirects.", links.broken.map((b) => b.url));
  const empty = pages.flatMap((p) => (p.links || []).filter((l) => !l.text).map(() => p.url));
  if (empty.length) add("low", "accessibility", "Links without visible text", `${empty.length} link${empty.length === 1 ? "" : "s"} have no text or aria-label`, "Give icon-only links an aria-label so everyone knows where they go.", empty);

  issues.sort((a, b) => SEV[b.severity] - SEV[a.severity] || a.category.localeCompare(b.category));
  issues.forEach((x, i) => (x.id = i + 1));

  // ---------- what kind of site is this?
  const forms = pages.reduce((a, p) => a + (p.forms?.length || 0), 0);
  const sameApis = site.apis.filter((a) => a.sameOrigin && /json/i.test(a.type));
  const fw = Object.entries(home?.framework || {}).filter(([, v]) => v).map(([k]) => k);
  const profile = {
    type: sameApis.length >= 3 || forms >= 3 ? "web application" : forms >= 1 || sameApis.length ? "site with some interactivity" : "content / portfolio site",
    frameworks: fw, hosting: h["x-vercel-id"] ? "Vercel" : h["cf-ray"] ? "Cloudflare" : h.server || null,
    pages: pages.length, forms, apis: sameApis.length, thirdPartyHosts: tp.length,
  };
  return { issues, profile, links, counts: { high: issues.filter((i) => i.severity === "high").length, medium: issues.filter((i) => i.severity === "medium").length, low: issues.filter((i) => i.severity === "low").length, info: issues.filter((i) => i.severity === "info").length } };
}
