// Scans and generated bundles are kept as JSON files under data/ (nothing leaves this machine).
import fs from "node:fs";
import path from "node:path";

const root = path.join(process.cwd(), "data");
const dir = (n) => { const d = path.join(root, n); fs.mkdirSync(d, { recursive: true }); return d; };
const safe = (id) => (/^[a-f0-9]{6,32}$/.test(String(id)) ? id : null);

export const saveJson = (kind, id, value) => fs.writeFileSync(path.join(dir(kind), id + ".json"), JSON.stringify(value));
export function loadJson(kind, id) { if (!safe(id)) return null; try { return JSON.parse(fs.readFileSync(path.join(dir(kind), id + ".json"), "utf8")); } catch { return null; } }
export const runDir = (id) => path.join(dir("runs"), safe(id) || "x");
export function listScans(limit = 8) {
  try { return fs.readdirSync(dir("scans")).map((f) => { const s = JSON.parse(fs.readFileSync(path.join(dir("scans"), f), "utf8")); return { id: s.id, name: s.name, dir: s.dir, scannedAt: s.scannedAt }; }).sort((a, b) => b.scannedAt - a.scannedAt).filter((s, i, all) => all.findIndex((x) => x.dir === s.dir) === i).slice(0, limit); } catch { return []; }
}
