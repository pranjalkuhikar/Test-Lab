"use client";
import { useState } from "react";
import { Mix } from "./Analysis";
import { api, Code } from "./Generate";

const num = (n) => (n == null ? "–" : Number(n).toLocaleString("en-US"));
const SEV = { high: "bad", medium: "amber", low: "blue", info: "" };
const CAT_ICON = { accessibility: "♿", seo: "🔎", security: "🛡️", performance: "⚡", reliability: "🧯", links: "🔗" };

export default function Website() {
  const [url, setUrl] = useState("");
  const [consent, setConsent] = useState(false);
  const [maxPages, setMaxPages] = useState(10);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [site, setSite] = useState(null);
  const [filter, setFilter] = useState("all");
  const [layers, setLayers] = useState({});
  const [gen, setGen] = useState(null);
  const [sel, setSel] = useState(null);
  const [ver, setVer] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [open, setOpen] = useState({});

  async function analyze() {
    setBusy("analyze"); setError(null); setGen(null); setVer(null);
    try {
      const s = await api("/api/site/analyze", { url, consent, maxPages });
      setSite(s); setLayers(Object.fromEntries(s.mix.map((m) => [m.id, m.available && m.percent > 0]))); setFilter("all");
    } catch (e) { setError(e.message); }
    setBusy(null);
  }
  async function generate() {
    setBusy("generate"); setError(null); setVer(null);
    try { const g = await api("/api/site/generate", { siteId: site.id, layers: Object.keys(layers).filter((k) => layers[k]) }); setGen(g); setSel(g.files.find((f) => !f.support)?.path || g.files[0]?.path); }
    catch (e) { setError(e.message); }
    setBusy(null);
  }
  async function run() {
    setBusy("verify"); setError(null);
    try { setVer(await api("/api/site/verify", { genId: gen.id, confirm })); } catch (e) { setError(e.message); }
    setBusy(null);
  }

  const cats = site ? ["all", ...new Set(site.issues.map((i) => i.category))] : [];
  const shown = site ? site.issues.filter((i) => filter === "all" || i.category === filter) : [];
  const chosen = Object.keys(layers).filter((k) => layers[k]);
  const file = gen?.files.find((f) => f.path === sel);
  const result = (p) => ver?.results?.find((r) => r.path === p);

  return (
    <div className="stack">
      <section className="card scanbar">
        <h2>{site ? "Website" : "Analyze a live website"}</h2>
        <p className="muted">Give TestLab a URL (your portfolio, a company site, a web app). It visits the pages like a visitor, tells you which kinds of tests the site needs, lists problems it can already see, and writes the tests.</p>
        <div className="row">
          <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && url && consent && analyze()} placeholder="https://yourwebsite.com" spellCheck={false} />
          <select className="pages" value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))} title="How many pages to visit">{[5, 10, 20, 30].map((n) => (<option key={n} value={n}>{n} pages</option>))}</select>
          <button className="btn go" onClick={analyze} disabled={busy || !url.trim() || !consent}>{busy === "analyze" ? "Visiting the site…" : site ? "↻ Analyze again" : "🌐 Analyze"}</button>
        </div>
        <label className="chk warnbox"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>I <b>own this website</b> or have permission to test it. TestLab only <b>reads</b> it: one page at a time, it follows <code>robots.txt</code>, stays on the same domain, never submits forms or logs in, and does not try to get around bot protection.</span></label>
        {busy === "analyze" && <p className="muted">Rendering pages in a real browser and running the checks. This takes about 20–90 seconds.</p>}
        {error && <div className="alert" onClick={() => setError(null)}>{error}</div>}
      </section>

      {!site && !busy && (
        <section className="hero card">
          <span className="eyebrow">No source code needed</span>
          <h1>See what a hosted website needs tested, and get the tests.</h1>
          <div className="tiles">
            <div><b>🧭 It explores the site</b><span>Pages, forms, links, images, scripts, the API calls the pages make, and how fast they load.</span></div>
            <div><b>📊 It recommends a mix</b><span>For a portfolio that might be smoke, accessibility, SEO and links; for a web app, more end-to-end and API checks.</span></div>
            <div><b>🔎 It shows problems now</b><span>Low contrast, missing alt text, missing security headers, broken links, slow pages, with how to fix each.</span></div>
            <div><b>✅ It writes and runs tests</b><span>Playwright files you can download, run in a real browser, and keep in CI.</span></div>
          </div>
        </section>
      )}

      {site && (
        <>
          <div className="kpis">
            <div className="kpi"><span className="k">Site</span><b className="v sm">{site.host}</b><span className="s">{site.profile.type}{site.profile.frameworks.length ? ` · ${site.profile.frameworks.join(", ")}` : ""}{site.profile.hosting ? ` · ${site.profile.hosting}` : ""}</span></div>
            <div className="kpi"><span className="k">Pages visited</span><b className="v">{site.pages.length}</b><span className="s">{site.profile.forms} forms · {site.profile.apis} API calls</span></div>
            <div className="kpi"><span className="k">Problems</span><b className={"v " + (site.counts.high ? "bad" : site.counts.medium ? "amber" : "good")}>{site.issues.length}</b><span className="s">{site.counts.high} high · {site.counts.medium} medium · {site.counts.low} low</span></div>
            <div className="kpi"><span className="k">Third-party hosts</span><b className="v">{site.profile.thirdPartyHosts}</b><span className="s">{Object.keys(site.thirdParty).slice(0, 2).join(", ") || "none"}</span></div>
            <div className="kpi"><span className="k">Took</span><b className="v">{Math.round(site.durationMs / 1000)}s</b><span className="s">{site.links.checked} more links checked</span></div>
          </div>

          <Mix rec={{ mix: site.mix, notes: site.notes, basis: site.basis }} />

          <section className="card">
            <h2>Problems found right now</h2>
            <p className="muted">Seen by a real browser during the visit. These are things a test suite should check, and things you can fix today.</p>
            <div className="chips">{cats.map((c) => (<button key={c} className={"chip" + (filter === c ? " on" : "")} onClick={() => setFilter(c)}>{c === "all" ? `All (${site.issues.length})` : `${CAT_ICON[c] || ""} ${c} (${site.issues.filter((i) => i.category === c).length})`}</button>))}</div>
            {shown.length === 0 && <p className="okmsg">Nothing found in this category.</p>}
            {shown.map((i) => (
              <div key={i.id} className={"issue " + i.severity}>
                <div className="ihead"><span className={"pill " + SEV[i.severity]}>{i.severity}</span><span className="pill">{CAT_ICON[i.category]} {i.category}</span><b>{i.title}</b></div>
                <p>{i.detail}</p>
                <p className="fix"><strong>How to fix:</strong> {i.fix}</p>
                {i.pages?.length > 0 && <p className="where">{i.pages.slice(0, 3).map((p) => p.replace(/^https?:\/\/[^/]+/, "") || "/").join(" · ")}{i.pages.length > 3 ? ` · +${i.pages.length - 3} more` : ""}</p>}
              </div>
            ))}
          </section>

          <section className="card">
            <h2>Pages</h2>
            <div className="scroll"><table className="tbl">
              <thead><tr><th>Page</th><th>Status</th><th>Title</th><th>A11y rules failing</th><th>LCP</th><th>Load</th><th>KB</th><th>JS errors</th></tr></thead>
              <tbody>{site.pages.map((p) => (<tr key={p.path}><td><code>{p.path}</code></td><td><span className={"pill " + (p.status < 400 ? "good" : "bad")}>{p.blocked ? "blocked" : p.status || "error"}</span></td><td className="why">{p.title || p.error || "–"}</td><td>{p.axe ?? "–"}</td><td>{p.lcp != null ? `${num(p.lcp)} ms` : "–"}</td><td>{p.loadMs ? `${num(p.loadMs)} ms` : "–"}</td><td>{num(p.kb)}</td><td className={p.errors ? "bad" : ""}>{p.errors}</td></tr>))}</tbody>
            </table></div>
            <div className="sitechecks">
              {[["HTTPS", site.checks.https], ["http → https redirect", site.checks.httpsRedirect ? site.checks.httpsRedirect.redirects : null], ["robots.txt", site.checks.robots?.present], ["sitemap.xml", site.checks.sitemap?.present], ["Real 404 page", site.checks.notFound?.goodStatus]].map(([k, v]) => (<span key={k} className={"pill " + (v === true ? "good" : v === false ? "bad" : "")}>{v === true ? "✓" : v === false ? "✗" : "–"} {k}</span>))}
            </div>
          </section>

          <section className="card" id="generate">
            <h2>Generate tests</h2>
            <p className="muted">Playwright tests built from what was observed. Failing tests point at real problems on the site.</p>
            <div className="layergrid">
              {site.mix.map((m) => (
                <label key={m.id} className={"chk layer" + (m.available ? "" : " off")}>
                  <input type="checkbox" disabled={!m.available} checked={!!layers[m.id]} onChange={(e) => setLayers({ ...layers, [m.id]: e.target.checked })} />
                  <i style={{ background: m.color }} /><b>{m.label}</b><em>{m.percent}% recommended</em>
                </label>
              ))}
            </div>
            <button className="btn go" onClick={generate} disabled={busy || !chosen.length}>{busy === "generate" ? "Writing tests…" : gen ? "↻ Regenerate" : "✨ Generate tests"}</button>

            {gen && (
              <>
                <div className="kpis" style={{ marginTop: 16 }}>
                  <div className="kpi"><span className="k">Test files</span><b className="v">{gen.summary.files}</b></div>
                  <div className="kpi"><span className="k">Tests</span><b className="v">{gen.summary.tests}</b><span className="s">{Object.entries(gen.summary.byLayer).map(([k, v]) => `${v} ${k}`).join(" · ")}</span></div>
                </div>
                <div className="filebrowser">
                  <div className="filelist">
                    {["site-tests", "helpers", "root"].map((grp) => {
                      const fs = gen.files.filter((f) => (grp === "root" ? !f.path.includes("/") : f.path.startsWith(grp + "/")));
                      return fs.length ? (<div key={grp}><h5>{grp === "site-tests" ? "Tests" : grp === "helpers" ? "Helpers" : "Project"}</h5>{fs.map((f) => { const r = result(f.path); return (
                        <button key={f.path} className={sel === f.path ? "on" : ""} onClick={() => setSel(f.path)}><span className="fp">{f.path.replace("site-tests/", "")}</span>
                          {r ? <span className={"pill " + (r.status === "pass" ? "good" : "bad")}>{r.status === "pass" ? `✓ ${r.tests.length}` : `✗ ${r.tests.filter((t) => t.status === "fail").length}`}</span> : f.tests ? <span className="pill">{f.tests}</span> : null}</button>); })}</div>) : null;
                    })}
                  </div>
                  <Code file={file} />
                </div>
                <div className="actions"><a className="btn" href={`/api/download/${gen.id}`}>⬇ Download ZIP</a></div>

                <h2 style={{ marginTop: 26 }}>Run them against the live site</h2>
                <p className="muted">A real browser visits the pages one at a time (read-only; nothing is submitted). Visual baselines are created from the site as it is now.</p>
                <label className="chk warnbox"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /><span>I understand a browser will visit <code>{site.host}</code> about {Math.max(gen.summary.tests * 2, 20)} times over a few minutes, and that I own the site or have permission.</span></label>
                <button className="btn go" onClick={run} disabled={busy || !confirm}>{busy === "verify" ? "Running in the browser… (2–6 minutes)" : "▶ Run tests"}</button>
                {ver?.note && <p className="note">{ver.note}</p>}
                {ver?.totals && (
                  <>
                    <div className="kpis" style={{ marginTop: 16 }}>
                      <div className="kpi"><span className="k">Passed</span><b className="v good">{ver.totals.passed}</b></div>
                      <div className="kpi"><span className="k">Failing checks</span><b className={"v " + (ver.totals.failed ? "bad" : "")}>{ver.totals.failed}</b><span className="s">problems on the site</span></div>
                      <div className="kpi"><span className="k">Browser</span><b className="v sm">{ver.browser}</b><span className="s">{Math.round(ver.ms / 1000)}s run</span></div>
                    </div>
                    {(ver.notes || []).map((n, i) => (<p key={i} className="note">ℹ {n}</p>))}
                    <div className="results">{ver.results.map((r) => (
                      <div key={r.path} className={"resrow " + r.status}>
                        <button className="reshead" onClick={() => setOpen({ ...open, [r.path]: !open[r.path] })}><span className={"pill " + (r.status === "pass" ? "good" : "bad")}>{r.status === "pass" ? "pass" : r.status === "fail" ? "issues" : r.status}</span><b>{r.path.replace("site-tests/", "")}</b><span className="muted">{r.tests.filter((t) => t.status === "pass").length}/{r.tests.length} passed</span><span className="caret">{open[r.path] ? "▾" : "▸"}</span></button>
                        {r.note && <p className="note">{r.note}</p>}
                        {(open[r.path] || r.status === "fail") && <div className="resbody">{[...r.tests].sort((a, b) => (a.status === "fail" ? -1 : 0) - (b.status === "fail" ? -1 : 0)).filter((t) => open[r.path] || t.status === "fail").map((t, i) => (<div key={i} className={"tcase " + t.status}><span>{t.status === "pass" ? "✓" : "✗"}</span><div><b>{t.name}</b>{t.message && <pre>{t.message}</pre>}</div></div>))}</div>}
                      </div>))}</div>
                  </>
                )}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
