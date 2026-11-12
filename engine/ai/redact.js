// Nothing that looks like a secret is sent to the API. Source snippets are scanned and matches are replaced.
const PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "anthropic key"], [/sk-[A-Za-z0-9]{32,}/g, "api key"], [/AKIA[0-9A-Z]{16}/g, "aws key"], [/ghp_[A-Za-z0-9]{30,}/g, "github token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "private key"], [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "jwt"],
  [/(password|passwd|secret|api[_-]?key|token)(["']?\s*[:=]\s*["'])([^"'\n]{8,})(["'])/gi, "credential assignment"],
];
export function redact(text) {
  let hits = 0, out = String(text);
  for (const [re, what] of PATTERNS) out = out.replace(re, (...m) => { hits++; return what === "credential assignment" ? `${m[1]}${m[2]}[REDACTED]${m[4]}` : `[REDACTED ${what}]`; });
  return { text: out, hits };
}
