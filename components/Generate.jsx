"use client";
import { useMemo, useState } from "react";

const LAYER_LABEL = { unit: "Unit", integration: "Integration", contract: "Contract", pact: "Pact", e2e: "E2E", support: "Support" };
const api = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
};

function Code({ file }) {
  const [copied, setCopied] = useState(false);
  if (!file) return <div className="codebox empty">Pick a file to see its code</div>;
  const lines = file.content.split("\n");
  return (
    <div className="codebox">
      <div className="codehead"><b>{file.path}</b><span>{lines.length} lines{file.tests ? ` · ${file.tests} tests` : ""}</span>
        <button className="btn sm" onClick={async () => { await navigator.clipboard.writeText(file.content).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "✓ Copied" : "Copy"}</button></div>
      <pre>{lines.slice(0, 600).map((l, i) => (<div key={i}><i>{i + 1}</i>{l || " "}</div>))}{lines.length > 600 && <div className="more">… {lines.length - 600} more lines (download the file to see everything)</div>}</pre>
    </div>
  );
}

export default function Generate({ scan, disc, onError }) {
  const rec = scan.recommendation.mix;
  const [layers, setLayers] = useState(() => Object.fromEntries(rec.map((m) => [m.id, m.available && m.percent > 0])));
  const [flavor, setFlavor] = useState("node");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(null);
  const [gen, setGen] = useState(null);
  const [sel, setSel] = useState(null);
  const [ver, setVer] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [open, setOpen] = useState({});
  const [saved, setSaved] = useState(null);

  const chosen = Object.keys(layers).filter((k) => layers[k]);
  const needsApp = chosen.some((k) => ["integration", "contract", "pact"].includes(k));

  async function generate() {
    setBusy("generate"); setVer(null); setSaved(null); onError(null);
    try { const g = await api("/api/generate", { scanId: scan.id, layers: chosen, flavor, baseUrl, token }); setGen(g); setSel(g.files.find((f) => !f.support && !f.data)?.path || g.files[0]?.path); }
    catch (e) { onError(e.message); }
    setBusy(null);
  }
  async function run() {
    setBusy("verify"); onError(null);
    try { setVer(await api("/api/verify", { genId: gen.id, baseUrl, token, layers: chosen, confirmRequests: confirm })); }
    catch (e) { onError(e.message); }
    setBusy(null);
  }
  async function write(overwrite) {
    try { setSaved(await api("/api/write", { genId: gen.id, overwrite })); }
    catch (e) { if (/already exists/.test(e.message) && confirmWindow(e.message)) return write(true); onError(e.message); }
  }
  const confirmWindow = (m) => window.confirm(m + "\n\nOverwrite it?");

  const grouped = useMemo(() => { const g = {}; for (const f of gen?.files || []) (g[f.support ? "support" : f.data ? f.layer : f.layer] ||= []).push(f); return g; }, [gen]);
  const file = gen?.files.find((f) => f.path === sel);
  const result = (p) => ver?.results?.find((r) => r.path === p);

  return (
    <section className="card" id="generate">
      <h2>Generate tests</h2>
      <p className="muted">Pick the layers, point at the running app (for API and contract tests), and TestLab writes the files.</p>

      <div className="genopts">
        <div>
          <h4>Layers</h4>
          {rec.map((m) => (
            <label key={m.id} className={"chk layer" + (m.available ? "" : " off")}>
              <input type="checkbox" disabled={!m.available} checked={!!layers[m.id]} onChange={(e) => setLayers({ ...layers, [m.id]: e.target.checked })} />
              <i style={{ background: m.color }} /><b>{m.label}</b><em>{m.percent}% recommended</em>
            </label>
          ))}
        </div>
        <div>
          <h4>Runner</h4>
          <select value={flavor} onChange={(e) => setFlavor(e.target.value)}>
            <option value="node">node:test (built in, nothing to install)</option>
            <option value="vitest">Vitest (generated only, not run here)</option>
          </select>
          <h4 style={{ marginTop: 14 }}>Running app {needsApp ? <em>needed for API / contract tests</em> : <em>optional</em>}</h4>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:3000" spellCheck={false} />
          <div className="chips">{(disc?.servers || []).map((s) => (<button key={s.url} className={"chip" + (baseUrl === s.url ? " on" : "")} onClick={() => setBaseUrl(s.url)}><i className="dot" />{s.name} <em>:{s.port}</em></button>))}</div>
          <h4 style={{ marginTop: 10 }}>Bearer token <em>optional, for apps that require sign-in</em></h4>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJ…" autoComplete="off" />
        </div>
      </div>
      <button className="btn go" onClick={generate} disabled={busy || !chosen.length}>{busy === "generate" ? "Analysing and writing tests…" : gen ? "↻ Regenerate" : "✨ Generate tests"}</button>
      {busy === "generate" && <span className="muted"> &nbsp;Recording real function behaviour in a sandbox: this can take up to a minute.</span>}

      {gen && (
        <>
          <div className="kpis" style={{ marginTop: 18 }}>
            <div className="kpi"><span className="k">Test files</span><b className="v">{gen.summary.files}</b></div>
            <div className="kpi"><span className="k">Tests</span><b className="v">{gen.summary.tests}</b><span className="s">{Object.entries(gen.summary.byLayer).map(([k, v]) => `${v} ${k}`).join(" · ")}</span></div>
            <div className="kpi"><span className="k">Skipped</span><b className="v">{gen.skipped.length}</b><span className="s">with reasons below</span></div>
            <div className="kpi"><span className="k">App reachable</span><b className={"v " + (gen.summary.reachable ? "good" : "")}>{gen.summary.reachable ? "yes" : baseUrl ? "no" : "–"}</b><span className="s">{gen.summary.reachable ? (gen.summary.expectAuth ? "sign-in is enforced" : "no sign-in required") : ""}</span></div>
          </div>

          <div className="filebrowser">
            <div className="filelist">
              {Object.entries(grouped).map(([layer, fs]) => (
                <div key={layer}><h5>{LAYER_LABEL[layer] || layer}</h5>
                  {fs.map((f) => { const r = result(f.path); return (
                    <button key={f.path} className={sel === f.path ? "on" : ""} onClick={() => setSel(f.path)}>
                      <span className="fp">{f.path}</span>
                      {r ? <span className={"pill " + (r.status === "pass" ? "good" : r.status === "fail" || r.status === "error" ? "bad" : "")}>{r.status === "pass" ? `✓ ${r.tests.length}` : r.status === "fail" ? `✗ ${r.tests.filter((t) => t.status === "fail").length}` : r.status}</span> : f.tests ? <span className="pill">{f.tests}</span> : null}
                    </button>); })}
                </div>
              ))}
            </div>
            <Code file={file} />
          </div>

          <div className="actions">
            <a className="btn" href={`/api/download/${gen.id}`}>⬇ Download ZIP</a>
            <button className="btn" onClick={() => write(false)}>📁 Write to <code>{scan.name}/tests-generated</code></button>
            {saved && <span className="okmsg">✓ Wrote {saved.files} files to {saved.dir}</span>}
          </div>

          {(gen.skipped.length > 0 || gen.notes.length > 0) && (
            <details className="skipped"><summary>{gen.skipped.length} things were skipped, and why</summary>
              {gen.notes.map((n, i) => (<p key={i} className="note">ℹ {n}</p>))}
              <table className="tbl"><tbody>{gen.skipped.slice(0, 120).map((s, i) => (<tr key={i}><td><span className="pill">{s.layer}</span></td><td><code>{s.what}</code></td><td className="why">{s.reason}</td></tr>))}</tbody></table>
            </details>
          )}

          <h2 style={{ marginTop: 28 }}>Verify</h2>
          <p className="muted">Run what was generated and see what passes. Unit tests run in a restricted sandbox (no file writes, no subprocesses). API and contract tests send real requests.</p>
          {needsApp && <label className="chk warnbox"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I understand API tests send real requests to <code>{baseUrl || "the app"}</code> and will create, change and delete data there. It is a development environment.</label>}
          <button className="btn go" onClick={run} disabled={busy || (gen.flavor === "vitest")}>{busy === "verify" ? "Running tests…" : "▶ Run tests"}</button>
          {gen.flavor === "vitest" && <span className="muted"> &nbsp;Vitest files aren’t run here. Use <code>npx vitest run tests-generated</code> in your project.</span>}

          {ver?.totals && (
            <>
              <div className="kpis" style={{ marginTop: 16 }}>
                <div className="kpi"><span className="k">Passed</span><b className="v good">{ver.totals.passed}</b></div>
                <div className="kpi"><span className="k">Failed</span><b className={"v " + (ver.totals.failed ? "bad" : "")}>{ver.totals.failed}</b></div>
                <div className="kpi"><span className="k">Skipped</span><b className="v">{ver.totals.skipped}</b><span className="s">e.g. need a token</span></div>
                <div className="kpi"><span className="k">Files not run</span><b className="v">{ver.totals.filesNotRun + ver.totals.filesErrored}</b><span className="s">{ver.totals.filesErrored} errored</span></div>
              </div>
              <div className="results">
                {ver.results.map((r) => (
                  <div key={r.path} className={"resrow " + r.status}>
                    <button className="reshead" onClick={() => setOpen({ ...open, [r.path]: !open[r.path] })}>
                      <span className={"pill " + (r.status === "pass" ? "good" : r.status === "fail" || r.status === "error" ? "bad" : "")}>{r.status}</span>
                      <b>{r.path}</b><span className="muted">{r.tests.length ? `${r.tests.filter((t) => t.status === "pass").length}/${r.tests.length} passed` : ""} {r.ms ? `· ${r.ms} ms` : ""}</span><span className="caret">{open[r.path] ? "▾" : "▸"}</span>
                    </button>
                    {r.note && <p className="note">{r.note}</p>}
                    {open[r.path] && <div className="resbody">{[...r.tests].sort((a, b) => (a.status === "fail" ? -1 : 0) - (b.status === "fail" ? -1 : 0)).map((t, i) => (<div key={i} className={"tcase " + t.status}><span>{t.status === "pass" ? "✓" : t.status === "fail" ? "✗" : "○"}</span><div><b>{t.name}</b>{t.message && <pre>{t.message}</pre>}</div></div>))}</div>}
                  </div>
                ))}
              </div>
            </>
          )}
          {ver?.note && <p className="note">{ver.note}</p>}
        </>
      )}
    </section>
  );
}
