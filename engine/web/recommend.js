// A recommended test mix for a website, scored from what the crawl actually found.
const LAYERS = [
  { id: "e2e", label: "End-to-end & smoke", color: "#a78bfa", what: "Pages load, navigation and forms work, no errors in the console" },
  { id: "a11y", label: "Accessibility", color: "#5eead4", what: "Everyone can use it: screen readers, keyboard, contrast" },
  { id: "perf", label: "Performance", color: "#fbbf24", what: "Fast loading, stable layout, sensible page weight" },
  { id: "visual", label: "Visual & responsive", color: "#60a5fa", what: "It looks right and does not break on phones" },
  { id: "seo", label: "SEO & metadata", color: "#f472b6", what: "Titles, descriptions, headings, sharing previews" },
  { id: "security", label: "Security headers (passive)", color: "#f87171", what: "Browser protections and cookie flags your site should send" },
  { id: "links", label: "Links & availability", color: "#4ade80", what: "No broken links; unknown URLs answer 404" },
  { id: "contract", label: "API contract", color: "#fb923c", what: "The JSON your pages fetch keeps its shape" },
];

export function recommendSite(site, an) {
  const pages = site.pages.filter((p) => !p.blocked && !p.error && p.status && p.status < 400);
  const n = pages.length, forms = an.profile.forms;
  const by = (cat) => an.issues.filter((i) => i.category === cat);
  const a11yRules = by("accessibility").filter((i) => i.rule);
  const apis = site.apis.filter((a) => a.sameOrigin && /json/i.test(a.type) && a.method === "GET");
  const lcpSlow = pages.filter((p) => p.vitals?.lcp > 2500).length;
  const missingHdrs = by("security").filter((i) => /HSTS|Content-Security|X-Content|Referrer|embedded/.test(i.title)).length;
  const ev = {
    e2e: 6 + n * 2 + forms * 6 + Math.min(pages.reduce((a, p) => a + (p.buttons || 0), 0), 40) * 0.3 + apis.length * 1.5,
    a11y: 8 + a11yRules.reduce((a, r) => a + (r.severity === "high" ? 4 : r.severity === "medium" ? 3 : 1), 0) + by("accessibility").length * 0.5,
    perf: 6 + lcpSlow * 8 + by("performance").length * 2.5,
    visual: 4 + n * 1.2 + (by("seo").some((i) => /viewport/.test(i.title)) ? 6 : 0) + (by("reliability").some((i) => /Horizontal/.test(i.title)) ? 5 : 0) + (pages.reduce((a, p) => a + (p.images?.total || 0), 0) > 10 ? 4 : 0),
    seo: 4 + by("seo").length * 1.8 + (an.profile.type === "content / portfolio site" ? 6 : 0),
    security: 4 + missingHdrs * 2.5 + by("security").length + forms * 2,
    links: 3 + Math.min(pages.reduce((a, p) => a + (p.links?.length || 0), 0), 150) * 0.08 + an.links.broken.length * 5 + (site.checks.notFound?.soft404 ? 4 : 0),
    contract: apis.length ? apis.length * 4 : 0,
  };
  const present = Object.fromEntries(Object.keys(ev).map((k) => [k, ev[k] > 0]));
  const reasons = {
    e2e: [`${n} page${n === 1 ? "" : "s"} reached${forms ? `, ${forms} form${forms === 1 ? "" : "s"}` : ", no forms"}`, an.profile.type === "content / portfolio site" ? "Mostly content: a short smoke suite is enough (every page loads, links work)" : "Interactive flows deserve real browser tests", site.apis.length ? `${site.apis.length} background API call${site.apis.length === 1 ? "" : "s"} observed` : "no background API calls observed"],
    a11y: [a11yRules.length ? `${a11yRules.length} accessibility rule${a11yRules.length === 1 ? "" : "s"} already fail (${a11yRules.filter((r) => r.severity !== "low").length} serious)` : "no accessibility rule failures found by the automatic scan", "Automatic scans catch roughly a third of issues; a keyboard walkthrough is still worth doing", "Public sites carry legal and reputational risk when inaccessible"],
    perf: [lcpSlow ? `${lcpSlow} page${lcpSlow === 1 ? "" : "s"} paint their main content slower than 2.5 s` : "main content paints within the 'good' range", `${Object.keys(site.thirdParty).length} third-party host${Object.keys(site.thirdParty).length === 1 ? "" : "s"} contacted`, "Budgets stop regressions from creeping in unnoticed"],
    visual: [`${n} page${n === 1 ? "" : "s"} to snapshot on desktop and mobile`, by("seo").some((i) => /viewport/.test(i.title)) ? "A page has no viewport meta tag: mobile layout is at risk" : "viewport meta tag present", "Screenshots catch visual breakage no other test sees"],
    seo: [`${by("seo").length} metadata issue${by("seo").length === 1 ? "" : "s"} found`, an.profile.type === "content / portfolio site" ? "For a portfolio, being found in search is a main goal" : "Matters for discoverability", site.checks.sitemap?.present ? "sitemap.xml present" : "no sitemap.xml"],
    security: [`${missingHdrs} important security header${missingHdrs === 1 ? "" : "s"} missing`, "Passive only: it reads what the site already sends, it does not attack anything", forms ? "Forms increase the value of these protections" : "no forms, lower exposure"],
    links: [`${an.links.checked} extra internal links checked, ${an.links.broken.length} broken`, site.checks.notFound?.soft404 ? "Unknown URLs return 200 (soft 404)" : "Unknown URLs correctly return 404", "Broken links hurt visitors and search ranking"],
    contract: apis.length ? [`${apis.length} JSON GET endpoint${apis.length === 1 ? "" : "s"} the pages depend on`, "If their shape changes, the page silently breaks"] : ["The pages don't fetch JSON from their own backend, so there is nothing to protect with a contract test"],
  };
  const total = Object.entries(ev).reduce((a, [k, v]) => a + (present[k] ? v : 0), 0) || 1;
  const raw = LAYERS.map((l) => ({ ...l, raw: present[l.id] ? (ev[l.id] / total) * 100 : 0 }));
  const e2e = raw.find((l) => l.id === "e2e");
  if (e2e.raw > 30) { const cut = e2e.raw - 30; e2e.raw = 30; const others = raw.filter((l) => l.id !== "e2e" && l.raw > 0); const sum = others.reduce((a, l) => a + l.raw, 0) || 1; others.forEach((l) => (l.raw += (cut * l.raw) / sum)); }
  const floors = raw.map((l) => Math.floor(l.raw));
  let rest = 100 - floors.reduce((a, b) => a + b, 0);
  raw.map((l, i) => ({ i, frac: l.raw - floors[i] })).sort((a, b) => b.frac - a.frac).forEach(({ i }) => { if (rest > 0 && raw[i].raw > 0) { floors[i]++; rest--; } });
  const generated = { e2e: n, a11y: n, perf: Math.min(n, 5), visual: n * 2, seo: n, security: 1, links: 1, contract: apis.length };
  const mix = raw.map((l, i) => ({ id: l.id, label: l.label, color: l.color, what: l.what, percent: floors[i], available: present[l.id], reasons: reasons[l.id], count: { e2e: n, a11y: n, perf: n, visual: n, seo: n, security: 1, links: n, contract: apis.length }[l.id], autoGenerated: generated[l.id] }));
  const notes = [];
  if (!an.counts.high && !an.counts.medium) notes.push("No serious problems found by the automatic checks. Tests will mostly protect what already works.");
  if (an.profile.type === "content / portfolio site") notes.push("This looks like a content/portfolio site: a small, fast suite (smoke, accessibility, SEO, links) gives the most value for the least maintenance.");
  notes.push("The analysis sees only what a visitor sees. Logged-in areas, admin screens and server-side logic are not covered.");
  return { mix, notes, basis: "Each layer scores the evidence the crawl found (pages, forms, API calls, failing accessibility rules, slow pages, missing headers, broken links, metadata gaps) and the scores are scaled to 100%. End-to-end is capped at 30% because browser tests are slow and brittle. It is a transparent heuristic, not a rule." };
}
