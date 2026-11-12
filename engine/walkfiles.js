import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", "out", "coverage", ".turbo", ".cache", ".vercel", "tests-generated", "storybook-static"]);
const CODE = /\.(js|jsx|mjs|cjs|ts|tsx)$/;
const MAX_FILES = 3000, MAX_BYTES = 400_000;

export function walkFiles(root) {
  const files = [], other = [];
  (function rec(dir, depth) {
    if (depth > 9 || files.length >= MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".env.example") continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) rec(abs, depth + 1); continue; }
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (CODE.test(e.name)) {
        let size = 0; try { size = fs.statSync(abs).size; } catch {}
        if (size <= MAX_BYTES && !e.name.endsWith(".d.ts")) files.push({ abs, rel, size });
      } else if (/^(package\.json|Dockerfile|docker-compose\.ya?ml|openapi\.(json|ya?ml)|swagger\.(json|ya?ml)|jsconfig\.json|tsconfig\.json)$/i.test(e.name)) other.push({ abs, rel });
    }
  })(root, 0);
  return { files, other };
}
