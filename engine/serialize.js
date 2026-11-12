// Values travel between processes (and into generated test files) as JSON, so values JSON can't carry
// (undefined, NaN, ±Infinity, -0, bigint) are tagged. toJsLiteral() turns a value into source code for tests.
export function encode(v, depth = 0) {
  if (depth > 6) return { $: "truncated" };
  if (v === undefined) return { $: "undefined" };
  if (typeof v === "number") { if (Number.isNaN(v)) return { $: "NaN" }; if (v === Infinity) return { $: "Infinity" }; if (v === -Infinity) return { $: "-Infinity" }; if (Object.is(v, -0)) return { $: "-0" }; return v; }
  if (typeof v === "bigint") return { $: "bigint", v: v.toString() };
  if (typeof v === "function") return { $: "function" };
  if (typeof v === "symbol") return { $: "symbol" };
  if (ArrayBuffer.isView(v) && !(v instanceof DataView) && typeof v.length === "number") return { $: "typed", ctor: v.constructor.name, v: Array.from(v.length > 600 ? v.slice(0, 600) : v), truncated: v.length > 600 ? v.length : undefined };
  if (v instanceof Date) return { $: "date", v: Number.isNaN(v.getTime()) ? null : v.toISOString() };
  if (v instanceof RegExp) return { $: "regexp", v: String(v) };
  if (v instanceof Error) return { $: "error", name: v.name, message: v.message };
  if (v instanceof Map) return { $: "map", v: [...v].map(([a, b]) => [encode(a, depth + 1), encode(b, depth + 1)]) };
  if (v instanceof Set) return { $: "set", v: [...v].map((x) => encode(x, depth + 1)) };
  if (Array.isArray(v)) return v.map((x) => encode(x, depth + 1));
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = encode(v[k], depth + 1); return o; }
  return v;
}
export function decode(v) {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === "object") {
    if (typeof v.$ === "string") {
      switch (v.$) { case "undefined": return undefined; case "NaN": return NaN; case "Infinity": return Infinity; case "-Infinity": return -Infinity; case "-0": return -0; case "bigint": return BigInt(v.v); case "date": return v.v === null ? new Date(NaN) : new Date(v.v); case "typed": return new (globalThis[v.ctor] || Array)(v.v); case "map": return new Map(v.v.map(([a, b]) => [decode(a), decode(b)])); case "set": return new Set(v.v.map(decode)); default: return undefined; }
    }
    const o = {}; for (const k of Object.keys(v)) o[k] = decode(v[k]); return o;
  }
  return v;
}
// Source-code literal for an encoded value (used inside generated tests)
export function toJsLiteral(e, indent = 0) {
  const pad = (n) => "  ".repeat(n);
  if (e === null) return "null";
  if (typeof e === "string") return JSON.stringify(e);
  if (typeof e === "number" || typeof e === "boolean") return String(e);
  if (Array.isArray(e)) { if (!e.length) return "[]"; const parts = e.map((x) => toJsLiteral(x, indent + 1)); const one = `[${parts.join(", ")}]`; return one.length < 100 && !one.includes("\n") ? one : `[\n${parts.map((p) => pad(indent + 1) + p).join(",\n")}\n${pad(indent)}]`; }
  if (typeof e === "object") {
    switch (e.$) {
      case "undefined": return "undefined"; case "NaN": return "NaN"; case "Infinity": return "Infinity"; case "-Infinity": return "-Infinity"; case "-0": return "-0";
      case "typed": return e.truncated ? "undefined" : `new ${e.ctor}(${toJsLiteral(e.v)})`;
      case "bigint": return `${e.v}n`; case "date": return e.v === null ? "new Date(NaN)" : `new Date(${JSON.stringify(e.v)})`;
      case "map": return `new Map([${e.v.map(([a, b]) => `[${toJsLiteral(a)}, ${toJsLiteral(b)}]`).join(", ")}])`; case "set": return `new Set([${e.v.map((x) => toJsLiteral(x)).join(", ")}])`;
      case "regexp": return e.v; case "error": return `new ${/^[A-Za-z]+$/.test(e.name) ? e.name : "Error"}(${JSON.stringify(e.message)})`; case "function": case "symbol": case "truncated": return "undefined";
    }
    const keys = Object.keys(e); if (!keys.length) return "{}";
    const parts = keys.map((k) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${toJsLiteral(e[k], indent + 1)}`);
    const one = `{ ${parts.join(", ")} }`;
    return one.length < 100 && !one.includes("\n") ? one : `{\n${parts.map((p) => pad(indent + 1) + p).join(",\n")}\n${pad(indent)}}`;
  }
  return "undefined";
}
