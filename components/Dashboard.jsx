"use client";
import { useCallback, useEffect, useState } from "react";
import { Summary, Mix, Risks, EdgeCases } from "./Analysis";
import Generate from "./Generate";
import Website from "./Website";

const getJson = async (url, opts) => { const r = await fetch(url, opts); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`); return j; };

export default function Dashboard() {
  const [dir, setDir] = useState("");
  const [scan, setScan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [disc, setDisc] = useState(null);
  const [recent, setRecent] = useState([]);
  const [mode, setMode] = useState("project");

  const loadRecent = useCallback(() => getJson("/api/scan").then((d) => setRecent(d.scans)).catch(() => {}), []);
  useEffect(() => { getJson("/api/discover").then(setDisc).catch(() => {}); loadRecent(); }, [loadRecent]);

  async function doScan(d = dir) {
    if (!d.trim()) return;
    setDir(d); setBusy(true); setError(null);
    try { setScan(await getJson("/api/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir: d }) })); loadRecent(); }
    catch (e) { setError(e.message); }
    setBusy(false);
  }
  async function openScan(id) { setBusy(true); setError(null); try { const s = await getJson(`/api/scan/${id}`); setScan(s); setDir(s.dir); } catch (e) { setError(e.message); } setBusy(false); }

  return (
    <div className="shell">
      <header className="top">
        <div className="brand"><span className="logo">🧪</span><div><b>TestLab</b><small>know what to test, and get the tests</small></div></div>
        {scan && <nav><a href="#mix">Mix</a><a href="#risks">Risks</a><a href="#edge">Edge cases</a><a href="#generate">Generate</a></nav>}
      </header>

      <div className="modetabs">
        <button className={mode === "project" ? "on" : ""} onClick={() => setMode("project")}>📁 Project folder <small>source code</small></button>
        <button className={mode === "website" ? "on" : ""} onClick={() => setMode("website")}>🌐 Live website <small>just a URL</small></button>
      </div>
      {mode === "website" ? <Website /> : (<>
      <section className="card scanbar">
        <h2>{scan ? "Project" : "Point TestLab at a JavaScript project"}</h2>
        <div className="row">
          <input value={dir} onChange={(e) => setDir(e.target.value)} onKeyDown={(e) => e.key === "Enter" && doScan()} placeholder="/path/to/your/project" spellCheck={false} />
          <button className="btn go" onClick={() => doScan()} disabled={busy || !dir.trim()}>{busy ? "Scanning…" : scan ? "↻ Rescan" : "🔍 Scan"}</button>
        </div>
        <div className="chips">
          {(disc?.projects || []).map((p) => (<button key={p.dir} className={"chip" + (dir === p.dir ? " on" : "")} onClick={() => doScan(p.dir)} disabled={busy}>📁 {p.name}</button>))}
          {recent.filter((r) => !(disc?.projects || []).some((p) => p.dir === r.dir)).slice(0, 4).map((r) => (<button key={r.id} className="chip" onClick={() => openScan(r.id)}>🕘 {r.name}</button>))}
        </div>
        <p className="muted small">TestLab only <b>reads</b> your source files. Nothing is executed during the scan, and nothing leaves this machine.</p>
        {error && <div className="alert" onClick={() => setError(null)}>{error}</div>}
      </section>

      {!scan && !busy && (
        <section className="hero card">
          <span className="eyebrow">Unit · Integration · Contract · Pact · E2E</span>
          <h1>Find out which tests your project needs, then get them written.</h1>
          <div className="tiles">
            <div><b>🔎 It reads your code</b><span>Routes, functions, forms, and the calls between your services.</span></div>
            <div><b>📊 It recommends a mix</b><span>For example 40% unit, 35% integration, 15% contract, with the reasons.</span></div>
            <div><b>🧩 It lists edge cases</b><span>Per endpoint and per function: bad IDs, missing fields, auth, security payloads.</span></div>
            <div><b>✅ It writes <i>and runs</i> the tests</b><span>Real files you can download, checked in a sandbox so you know what passes.</span></div>
          </div>
          <p className="muted">Pick a project above to begin. Works best with Node.js, Express and Next.js projects.</p>
        </section>
      )}
      {busy && !scan && <section className="card"><p className="muted">Reading and analysing your project…</p></section>}

      {scan && (
        <div className="stack">
          <Summary s={scan} />
          <div id="mix"><Mix rec={scan.recommendation} /></div>
          <div id="risks"><Risks rec={scan.recommendation} /></div>
          <div id="edge"><EdgeCases s={scan} /></div>
          <Generate key={scan.id} scan={scan} disc={disc} onError={setError} />
        </div>
      )}
      </>)}
      <footer className="foot">TestLab generates a strong first draft. Review the tests before trusting them: they can only know what your code <i>does</i>, not what it <i>should</i> do.</footer>
    </div>
  );
}
