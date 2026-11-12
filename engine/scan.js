// Static project scanner (it never runs your code). Reads every JS/TS file, builds a model of:
// services, HTTP routes, exported functions, UI pages/forms, inter-service calls, existing tests.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseSource, walk, isFn, text, chain, calleeName, strValue, measure, freeVars, paramFields } from "./ast.js";
import { walkFiles } from "./walkfiles.js";

const HTTP = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
const METHOD_EXPORTS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const PURE_BUILTINS = new Set(["path", "node:path", "util", "node:util", "url", "node:url", "assert", "node:assert"]);
const IMPURE_GLOBALS = new Set(["fetch", "process", "require", "setTimeout", "setInterval", "XMLHttpRequest", "localStorage", "sessionStorage", "document", "window", "navigator", "globalThis", "Buffer"]);
const SAFE_NEW = new Set(["RegExp", "Map", "Set", "WeakMap", "Error", "TypeError", "Date"]);
const SAFE_CALL = new Set(["Object.freeze", "Object.keys", "Object.values", "Object.entries", "Object.fromEntries", "Symbol", "Number", "String", "Boolean", "parseInt", "parseFloat", "Array.from", "Array.isArray", "Math.max", "Math.min", "JSON.stringify"]);
const AUTH_RE = /authorization|bearer|requireUser|authenticate|jsonwebtoken|\bjwt\b|x-user-id|req\.user\b|getServerSession|isAuthenticated/i;
const TEST_FILE = /(\.(test|spec)\.[jt]sx?$)|(^|\/)__tests__\//;
const SAFE_GLOBALS = new Set(["Math", "JSON", "Number", "String", "Boolean", "Array", "Object", "Date", "RegExp", "Error", "TypeError", "RangeError", "SyntaxError", "Map", "Set", "WeakMap", "WeakSet", "Symbol", "BigInt", "Promise", "parseInt", "parseFloat", "isNaN", "isFinite", "undefined", "NaN", "Infinity", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI", "console", "arguments", "Intl"]);
const EXTS = ["", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", "/index.js", "/index.jsx", "/index.ts", "/index.tsx"];

const pkgDeps = (p) => ({ ...(p.dependencies || {}), ...(p.devDependencies || {}) });

// ---------------------------------------------------------------- handler analysis
function analyzeHandler(code, node, localFns, depth = 0, seen = new Set()) {
  const out = { statuses: new Set(), bodyFields: new Set(), queryFields: new Set(), calls: new Set(), auth: false, validates: false, returnsJson: false };
  if (!node) return out;
  const add = (n) => out.statuses.add(n);
  const merge = (o) => { for (const k of ["statuses", "bodyFields", "queryFields", "calls"]) o[k].forEach((v) => out[k].add(v)); out.auth ||= o.auth; out.validates ||= o.validates; out.returnsJson ||= o.returnsJson; };
  const statusIn = (obj) => {
    if (obj?.type !== "ObjectExpression") return null;
    const p = obj.properties.find((x) => x.key && (x.key.name === "status" || x.key.value === "status"));
    return p && p.value.type === "NumericLiteral" ? p.value.value : null;
  };

  walk(node.body ?? node, (n) => {
    if (n.type === "StringLiteral" && AUTH_RE.test(n.value) && n.value.length < 60) out.auth = true;
    if (n.type === "Identifier" && /^(requireUser|authenticate|requireAuth|verifyToken|isAuthenticated)$/.test(n.name)) out.auth = true;

    if (n.type === "NewExpression" && chain(n.callee) === "Response") { const s = statusIn(n.arguments[1]); add(s ?? 200); out.returnsJson = true; }
    if (n.type === "CallExpression") {
      const cn = calleeName(n) || "";
      const prop = n.callee.type === "MemberExpression" && n.callee.property.type === "Identifier" ? n.callee.property.name : null;
      if (prop && ["status", "sendStatus", "code"].includes(prop) && n.arguments[0]?.type === "NumericLiteral") add(n.arguments[0].value);
      if (/(^|\.)(Response|NextResponse)\.(json|redirect)$/.test(cn)) { const s = statusIn(n.arguments[1]); add(s ?? (/redirect$/.test(cn) ? 307 : 200)); out.returnsJson = true; }
      else if (prop === "json" || prop === "send" || prop === "end") {
        out.returnsJson = true;
        const viaStatus = n.callee.object.type === "CallExpression" && ["status", "code"].includes(n.callee.object.callee?.property?.name);
        if (!viaStatus && /^(res|reply|response)$/.test(chain(n.callee.object) || "")) add(200);
      }
      if (/searchParams\.get$/.test(cn) && strValue(n.arguments[0])) out.queryFields.add(strValue(n.arguments[0]));
      if (/(^|\.)(safeParse|parse|validate|validateSync|assert)$/.test(cn) && !/JSON\.parse|parseInt|parseFloat|Date\.parse|path\.parse|url\.parse/.test(cn)) out.validates = true;
      if (/\.get$/.test(cn) && /^(req|request)\./.test(cn) && /authorization/i.test(strValue(n.arguments[0]) || "")) out.auth = true;
      // follow one level into local helper functions such as badId() / notFound()
      if (n.callee.type === "Identifier" && !localFns.has(n.callee.name)) out.calls.add(n.callee.name);
      if (n.callee.type === "Identifier" && localFns.has(n.callee.name) && depth < 2 && !seen.has(n.callee.name)) {
        seen.add(n.callee.name);
        merge(analyzeHandler(code, localFns.get(n.callee.name).node, localFns, depth + 1, seen));
      }
    }
    if (n.type === "MemberExpression") {
      const c = chain(n);
      let m;
      if (c && (m = c.match(/^(?:req|request)\.body\.(\w+)/) || c.match(/^body\.(\w+)/))) out.bodyFields.add(m[1]);
      if (c && (m = c.match(/^(?:req|request)\.query\.(\w+)/) || c.match(/^query\.(\w+)/))) out.queryFields.add(m[1]);
      if (c && /^(req|request)\.(user|headers\.authorization)/.test(c)) out.auth = true;
    }
    if (n.type === "VariableDeclarator" && n.id.type === "ObjectPattern" && n.init) {
      // only a direct read of the request body counts: `const { a, b } = req.body` / `await request.json()`
      const init = n.init.type === "AwaitExpression" ? n.init.argument : n.init;
      const direct = /^(req|request)\.body$/.test(chain(init) || "") || chain(init) === "body" || (init.type === "CallExpression" && /^(req|request)\.json$/.test(calleeName(init) || ""));
      if (direct) for (const p of n.id.properties) if (p.key?.name) out.bodyFields.add(p.key.name);
    }
    if (n.type === "UnaryExpression" && n.operator === "typeof") out.validates = true;
  });
  if (out.returnsJson && out.statuses.size === 0) add(200);
  return out;
}

const handlerInfo = (h) => ({ statuses: [...h.statuses].sort((a, b) => a - b), bodyFields: [...h.bodyFields], queryFields: [...h.queryFields], calls: [...h.calls], auth: h.auth, validates: h.validates });

// ---------------------------------------------------------------- JSX analysis
function analyzeJsx(code, node) {
  const out = { hasForm: false, inputs: [], buttons: [], links: [], headings: [], usesState: false, hasJsx: false };
  walk(node, (n) => {
    if (n.type === "JSXElement" || n.type === "JSXFragment") out.hasJsx = true;
    if (n.type === "CallExpression" && /^(useState|useReducer)$/.test(calleeName(n) || "")) out.usesState = true;
    if (n.type === "JSXElement") {
      const name = n.openingElement.name.name;
      const attrs = Object.fromEntries(n.openingElement.attributes.filter((a) => a.type === "JSXAttribute" && a.value?.type === "StringLiteral").map((a) => [a.name.name, a.value.value]));
      const inner = n.children.filter((c) => c.type === "JSXText").map((c) => c.value.trim()).filter(Boolean).join(" ");
      if (name === "form") out.hasForm = true;
      if (name === "input" || name === "textarea" || name === "select") out.inputs.push({ name: attrs.name || attrs.id || null, type: attrs.type || (name === "input" ? "text" : name), placeholder: attrs.placeholder || null, tag: name });
      if (name === "button") out.buttons.push(inner || attrs["aria-label"] || attrs.type || "button");
      if (name === "a" || name === "Link") if (attrs.href) out.links.push(attrs.href);
      if (/^h[1-3]$/.test(name) && inner) out.headings.push(inner);
    }
  });
  return out;
}

function inferParamKind(name) {
  const n = name.toLowerCase();
  if (/^(is|has|can|should|enabled|disabled|done|active|flag)/.test(n) || /(flag|enabled)$/.test(n)) return "boolean";
  if (/(^|_)(id|ids)$|uuid/.test(n) && !/^(valid|paid)/.test(n)) return /ids$/.test(n) ? "array" : "id";
  if (/^(n|num|count|limit|offset|page|size|index|idx|total|max|min|age|amount|price|qty|quantity|days|ms|seconds|length|rounds|ttl)/.test(n) || /(count|limit|offset|size|total|amount|price)$/.test(n)) return "number";
  if (/(email)/.test(n)) return "email";
  if (/(items|list|arr|array|rows|todos|users|values|entries|tags|ids)$/.test(n) || /^(items|list|arr|rows|tags)/.test(n)) return "array";
  if (/(opts|options|config|settings|data|body|payload|params|obj|input|req|request|user|todo|row)$/.test(n)) return "object";
  if (/(str|text|title|name|label|slug|path|url|query|search|message|msg|desc|description|value|key|token|password|s)$/.test(n)) return "string";
  return "unknown";
}

// ---------------------------------------------------------------- per-file analysis
function analyzeFile(file, code, service) {
  const rel = file.rel;
  const info = { rel, service, loc: code.split("\n").length, bindings: new Map(), imports: [], impureImports: new Set(), localFns: new Map(), exports: new Set(), units: [], routes: [], components: [], apiCalls: [], proxies: [], mounts: [], sideEffects: false, usesAlias: false, parseFailed: false, isTest: TEST_FILE.test(rel), jsx: null };
  let ast;
  try { ast = parseSource(code, rel); } catch (e) { info.parseFailed = true; info.parseError = e.message.slice(0, 120); return info; }
  const body = ast.program.body;

  const addImport = (source, names) => {
    info.imports.push(source);
    if (source.startsWith("@/")) info.usesAlias = true;
    if (!source.startsWith(".") && !source.startsWith("@/") && !PURE_BUILTINS.has(source)) info.impureImports.add(source);
    for (const n of names) info.bindings.set(n, source);
  };
  // ---- imports / requires
  for (const s of body) {
    if (s.type === "ImportDeclaration") addImport(s.source.value, s.specifiers.map((x) => x.local.name));
    if (s.type === "VariableDeclaration") for (const d of s.declarations) {
      const init = d.init?.type === "AwaitExpression" ? d.init.argument : d.init;
      if (init?.type === "CallExpression" && calleeName(init) === "require" && strValue(init.arguments[0])) {
        const names = d.id.type === "Identifier" ? [d.id.name] : d.id.type === "ObjectPattern" ? d.id.properties.map((p) => p.value?.name || p.key?.name).filter(Boolean) : [];
        addImport(strValue(init.arguments[0]), names);
      }
    }
  }
  walk(ast.program, (n) => { // dynamic requires / imports deep in the file still count as impure dependencies
    if (n.type === "CallExpression" && (calleeName(n) === "require" || n.callee.type === "Import") && strValue(n.arguments[0])) {
      const s = strValue(n.arguments[0]);
      if (!s.startsWith(".") && !s.startsWith("@/") && !PURE_BUILTINS.has(s)) info.impureImports.add(s);
    }
  });

  // ---- top-level declarations
  const unwrapFn = (init) => {
    if (isFn(init)) return { node: init, wrapped: false };
    if (init?.type === "CallExpression") for (const a of init.arguments) { if (isFn(a)) return { node: a, wrapped: true }; }
    return null;
  };
  const consts = new Map();
  for (const s of body) {
    const decl = s.type === "ExportNamedDeclaration" || s.type === "ExportDefaultDeclaration" ? s.declaration : s;
    const exported = s.type === "ExportNamedDeclaration" || s.type === "ExportDefaultDeclaration";
    if (decl?.type === "FunctionDeclaration" && decl.id) { info.localFns.set(decl.id.name, { node: decl, wrapped: false }); if (exported) info.exports.add(decl.id.name); }
    else if (decl?.type === "VariableDeclaration") for (const d of decl.declarations) {
      if (d.id.type !== "Identifier") continue;
      const f = unwrapFn(d.init);
      if (f) info.localFns.set(d.id.name, f); else if (d.init) consts.set(d.id.name, { init: d.init, stmt: code.slice(decl.start, decl.end) });
      if (exported) info.exports.add(d.id.name);
    }
    if (s.type === "ExportNamedDeclaration") for (const sp of s.specifiers || []) if (sp.exported?.name) info.exports.add(sp.local?.name || sp.exported.name);
    if (s.type === "ExportDefaultDeclaration") { if (s.declaration.type === "Identifier") info.exports.add(s.declaration.name); else if (s.declaration.id) info.exports.add(s.declaration.id.name); else if (isFn(s.declaration)) { info.localFns.set("default", { node: s.declaration, wrapped: false }); info.exports.add("default"); } }
    // CommonJS exports
    if (s.type === "ExpressionStatement" && s.expression.type === "AssignmentExpression") {
      const l = chain(s.expression.left), r = s.expression.right;
      if (l === "module.exports") {
        if (r.type === "ObjectExpression") for (const p of r.properties) { const k = p.key?.name || p.key?.value; if (k) info.exports.add(p.value?.type === "Identifier" ? p.value.name : k); if (k && isFn(p.value)) info.localFns.set(k, { node: p.value, wrapped: false }); }
        else if (r.type === "Identifier") info.exports.add(r.name);
        else if (isFn(r)) { info.localFns.set("default", { node: r, wrapped: false }); info.exports.add("default"); }
      } else if (l && /^(module\.)?exports\.(\w+)$/.test(l)) { const k = l.split(".").pop(); info.exports.add(r.type === "Identifier" ? r.name : k); if (isFn(r)) info.localFns.set(k, { node: r, wrapped: false }); }
    }
  }

  // ---- side effects at import time (decides whether the module can be safely executed for unit tests)
  const safeInit = (n) => {
    if (!n) return true;
    switch (n.type) {
      case "StringLiteral": case "NumericLiteral": case "BooleanLiteral": case "NullLiteral": case "BigIntLiteral": case "RegExpLiteral": case "Identifier": return true;
      case "ArrowFunctionExpression": case "FunctionExpression": case "ClassExpression": return true;
      case "TemplateLiteral": return n.expressions.every(safeInit);
      case "ObjectExpression": return n.properties.every((p) => p.type === "SpreadElement" ? safeInit(p.argument) : (!p.computed || safeInit(p.key)) && (p.type === "ObjectMethod" || safeInit(p.value)));
      case "ArrayExpression": return n.elements.every((e) => !e || safeInit(e.type === "SpreadElement" ? e.argument : e));
      case "MemberExpression": { const c = chain(n); return !(c && /^process\./.test(c)) && safeInit(n.object); }
      case "UnaryExpression": return safeInit(n.argument);
      case "BinaryExpression": case "LogicalExpression": return safeInit(n.left) && safeInit(n.right);
      case "ConditionalExpression": return safeInit(n.test) && safeInit(n.consequent) && safeInit(n.alternate);
      case "NewExpression": return SAFE_NEW.has(chain(n.callee)) && n.arguments.every(safeInit);
      case "CallExpression": { const c = calleeName(n); if (c === "require") { const s = strValue(n.arguments[0]); return !!s && (s.startsWith(".") || PURE_BUILTINS.has(s)); } return SAFE_CALL.has(c) && n.arguments.every(safeInit); }
      case "TSAsExpression": case "TSNonNullExpression": case "TSSatisfiesExpression": return safeInit(n.expression);
      default: return false;
    }
  };
  for (const s of body) {
    const t = s.type;
    if (["ImportDeclaration", "FunctionDeclaration", "ClassDeclaration", "TSInterfaceDeclaration", "TSTypeAliasDeclaration", "EmptyStatement", "ExportAllDeclaration"].includes(t)) continue;
    if (t === "ExportNamedDeclaration" || t === "ExportDefaultDeclaration") { const d = s.declaration; if (d && d.type === "VariableDeclaration" && !d.declarations.every((x) => safeInit(x.init))) info.sideEffects = true; else if (d && d.type !== "VariableDeclaration" && !isFn(d) && d.type !== "ClassDeclaration" && !safeInit(d)) info.sideEffects = true; continue; }
    if (t === "VariableDeclaration") { if (!s.declarations.every((d) => safeInit(d.init))) info.sideEffects = true; continue; }
    if (t === "ExpressionStatement") {
      const e = s.expression;
      if (e.type === "StringLiteral") continue; // "use client" / "use strict"
      if (e.type === "AssignmentExpression" && /^(module\.exports|exports(\.\w+)?|module\.exports\.\w+)$/.test(chain(e.left) || "") && safeInit(e.right)) continue;
      if (e.type === "CallExpression" && calleeName(e) === "Object.defineProperty" && /exports/.test(chain(e.arguments[0]) || "")) continue;
      info.sideEffects = true; continue;
    }
    info.sideEffects = true;
  }
  if (body.some((s) => s.type === "ExpressionStatement" && s.expression.type === "AwaitExpression")) info.sideEffects = true;

  // ---- routes (Next.js app/pages routers)
  const nextApp = rel.match(/(?:^|\/)app\/(.*?)\/?route\.[jt]sx?$/);
  const nextPages = rel.match(/(?:^|\/)pages\/api\/(.*)\.[jt]sx?$/);
  if (nextApp || nextPages) {
    let p = nextApp ? "/" + nextApp[1] : "/api/" + nextPages[1].replace(/\/index$/, "");
    p = p.split("/").filter((seg) => !/^\(.*\)$/.test(seg) && !seg.startsWith("@")).join("/").replace(/\[\.\.\.(\w+)\]/g, ":$1*").replace(/\[(\w+)\]/g, ":$1").replace(/\/+/g, "/") || "/";
    if (nextApp) {
      for (const name of info.exports) if (METHOD_EXPORTS.has(name)) {
        let f = info.localFns.get(name);
        const alias = consts.get(name)?.init; // export const PUT = update;
        if (!f && alias?.type === "Identifier") f = info.localFns.get(alias.name);
        const h = f ? analyzeHandler(code, f.node, info.localFns) : analyzeHandler(code, null, info.localFns);
        info.routes.push({ method: name, path: p, file: rel, line: f?.node.loc.start.line || 1, source: "next-app", owner: null, ...handlerInfo(h), handlerFound: !!f });
      }
    } else {
      const f = info.localFns.get("default");
      const h = analyzeHandler(code, f?.node, info.localFns);
      info.routes.push({ method: "ALL", path: p, file: rel, line: f?.node.loc.start.line || 1, source: "next-pages", owner: null, ...handlerInfo(h), handlerFound: !!f });
    }
  }

  // ---- everything else via one AST walk: express routes, mounts, API calls, proxies
  walk(ast.program, (n) => {
    if (n.type !== "CallExpression") return;
    const cn = calleeName(n) || "";
    const prop = n.callee.type === "MemberExpression" && !n.callee.computed ? n.callee.property.name : null;

    if (prop && HTTP.has(prop) && n.callee.object.type === "Identifier" && n.arguments.length >= 2) {
      const pathArg = n.arguments[0];
      const paths = pathArg.type === "ArrayExpression" ? pathArg.elements.map(strValue).filter(Boolean) : [strValue(pathArg)].filter(Boolean);
      const handlers = n.arguments.slice(1);
      const looksLikeHandler = handlers.some((a) => isFn(a) || a.type === "Identifier" || a.type === "CallExpression" || a.type === "MemberExpression");
      if (paths.length && paths.every((x) => x.startsWith("/")) && looksLikeHandler && !/^(axios|http|https|got|fetch|superagent|request|map|cache|headers|searchParams|params|formData|store|localStorage|sessionStorage)$/i.test(n.callee.object.name)) {
        // the real handler is the last argument; resolve through wrap(fn) and named local functions
        const last = handlers[handlers.length - 1];
        let hn = null;
        if (isFn(last)) hn = last;
        else if (last.type === "CallExpression") hn = last.arguments.find(isFn) || null;
        else if (last.type === "Identifier") { if (consts.has(last.name)) return; /* a middleware such as rateLimit(...), not a handler */ hn = info.localFns.get(last.name)?.node || null; }
        const h = analyzeHandler(code, hn, info.localFns);
        for (const mid of handlers.slice(0, -1)) if (mid.type === "Identifier" && AUTH_RE.test(mid.name)) h.auth = true; // e.g. app.get("/me", requireUser, handler)
        for (const pth of paths) info.routes.push({ method: prop.toUpperCase(), path: pth, file: rel, line: n.loc.start.line, source: "express", owner: n.callee.object.name, ...handlerInfo(h), handlerFound: !!hn });
      }
    }
    if (prop === "use" && n.arguments.length >= 2 && strValue(n.arguments[0])?.startsWith("/")) {
      const a = n.arguments[1];
      if (a.type === "Identifier") info.mounts.push({ prefix: strValue(n.arguments[0]), ident: a.name });
      else if (a.type === "CallExpression" && calleeName(a) === "require" && strValue(a.arguments[0])) info.mounts.push({ prefix: strValue(n.arguments[0]), source: strValue(a.arguments[0]) });
    }
    if (cn === "fetch" || /^axios(\.(get|post|put|patch|delete))?$/.test(cn) || /^(http|https)\.(request|get)$/.test(cn) || cn === "got") {
      const a0 = n.arguments[0];
      if (a0) {
        let method = /\.(get|post|put|patch|delete)$/.test(cn) ? cn.split(".").pop().toUpperCase() : null;
        const opt = n.arguments[1];
        if (opt?.type === "ObjectExpression") { const m = opt.properties.find((p) => p.key?.name === "method"); if (m && strValue(m.value)) method = strValue(m.value).toUpperCase(); }
        info.apiCalls.push({ file: rel, line: n.loc.start.line, url: text(code, a0, 110), method: method || "GET", service });
      }
    }
    if (/createProxyMiddleware$/.test(cn) && n.arguments[0]?.type === "ObjectExpression") {
      const o = Object.fromEntries(n.arguments[0].properties.filter((p) => p.key && !p.computed).map((p) => [p.key.name || p.key.value, text(code, p.value, 80)]));
      if (o.target) info.proxies.push({ file: rel, line: n.loc.start.line, target: o.target, pathFilter: o.pathFilter || null, service });
    }
  });

  // ---- components / UI (React)
  const isPageFile = /(^|\/)(app\/(.*\/)?page|pages\/(?!api\/).*)\.[jt]sx?$/.test(rel);
  for (const [name, f] of info.localFns) {
    const j = analyzeJsx(code, f.node);
    if (j.hasJsx && (/^[A-Z]/.test(name) || name === "default")) info.components.push({ name: name === "default" ? path.basename(rel, path.extname(rel)) : name, file: rel, line: f.node.loc.start.line, hasForm: j.hasForm, inputs: j.inputs, buttons: j.buttons, links: j.links, headings: j.headings, usesState: j.usesState });
  }
  info.jsx = info.components.length > 0;
  info.isPageFile = isPageFile;

  // ---- unit candidates: top-level functions that are not UI components and not route handlers
  const isRouteFile = !!(nextApp || nextPages);
  const isTs = /\.tsx?$/.test(rel);
  const impureNames = new Set([...info.bindings].filter(([, src]) => !src.startsWith(".") && !src.startsWith("@/") && !PURE_BUILTINS.has(src)).map(([n]) => n));

  // Can this function run on its own? Collect everything it depends on (safe constants, other pure helpers).
  // Anything else (imports, DB, process.env, network) makes it non-extractable, with the reason recorded.
  const extract = (rootName) => {
    const order = [], seen = new Set();
    let reason = null;
    const visit = (name) => {
      if (seen.has(name) || reason) return;
      seen.add(name);
      const f = info.localFns.get(name);
      if (f) {
        if (f.wrapped) { reason = `${name} is wrapped by another function`; return; }
        for (const v of freeVars(f.node)) {
          if (v === name || SAFE_GLOBALS.has(v)) continue;
          if (info.localFns.has(v) || consts.has(v)) visit(v);
          else { reason = info.bindings.has(v) ? `uses ${info.bindings.get(v)} (${v})` : `uses ${v}`; return; }
          if (reason) return;
        }
        order.push(f.node.type === "FunctionDeclaration" ? code.slice(f.node.start, f.node.end) : `const ${name} = ${code.slice(f.node.start, f.node.end)};`);
        return;
      }
      const c = consts.get(name);
      if (c) {
        if (!safeInit(c.init)) { reason = `${name} is set up with code that needs its environment`; return; }
        for (const v of freeVars({ type: "ArrowFunctionExpression", params: [], body: c.init })) { if (SAFE_GLOBALS.has(v)) continue; if (info.localFns.has(v) || consts.has(v)) visit(v); else { reason = `uses ${v}`; return; } }
        if (!reason) order.push(c.stmt);
      }
    };
    visit(rootName);
    if (reason) return { ok: false, reason };
    const src = order.join("\n");
    return src.length > 12000 ? { ok: false, reason: "too large to extract" } : { ok: true, source: src };
  };

  for (const [name, f] of info.localFns) {
    if (info.isTest || (isRouteFile && METHOD_EXPORTS.has(name))) continue;
    if (info.components.some((c) => c.line === f.node.loc.start.line)) continue;
    if (f.wrapped) continue; // wrap()/observe() handlers are exercised as routes
    const m = measure(code, f.node);
    const params = f.node.params.map((p, i) => {
      if (p.type === "Identifier") return { name: p.name, kind: inferParamKind(p.name) };
      if (p.type === "AssignmentPattern") { const nm = p.left.name || `arg${i}`; const dv = p.right; return { name: nm, kind: dv.type === "NumericLiteral" ? "number" : dv.type === "StringLiteral" ? "string" : dv.type === "BooleanLiteral" ? "boolean" : inferParamKind(nm), hasDefault: true }; }
      if (p.type === "ObjectPattern") return { name: `opts${i}`, kind: "object", keys: p.properties.map((x) => x.key?.name).filter(Boolean) };
      if (p.type === "RestElement") return { name: p.argument.name || "rest", kind: "rest" };
      return { name: `arg${i}`, kind: "unknown" };
    });
    const src = code.slice(f.node.start, f.node.end);
    const ex = isTs ? { ok: false, reason: "TypeScript source (needs a compiler)" } : f.node.generator ? { ok: false, reason: "generator function" } : extract(name);
    info.fnFields = info.fnFields || {};
    info.fnFields[name] = paramFields(f.node);
    info.units.push({
      id: `${rel}#${name}`, name, file: rel, line: f.node.loc.start.line, endLine: f.node.loc.end.line, loc: f.node.loc.end.line - f.node.loc.start.line + 1,
      exported: info.exports.has(name), async: !!f.node.async, params, complexity: m.complexity, conditions: m.conditions, throws: m.throws, service,
      nondeterministic: /\b(Math\.random|Date\.now|new Date\(|randomUUID)/.test(src),
      extractable: ex.ok, extractSource: ex.ok ? ex.source : null, skipReason: ex.ok ? null : ex.reason, fields: paramFields(f.node),
    });
  }
  return info;
}

// ---------------------------------------------------------------- whole project
export function scanProject(dirInput) {
  const root = path.resolve(String(dirInput || "").trim().replace(/^~(?=$|\/)/, process.env.HOME || "~"));
  let st; try { st = fs.statSync(root); } catch { return { error: "Folder not found" }; }
  if (!st.isDirectory()) return { error: "That path is not a folder" };

  const { files, other } = walkFiles(root);
  if (!files.length) return { error: "No JavaScript or TypeScript files found in that folder" };

  // ---- packages → services
  const packages = [];
  for (const o of other.filter((x) => /package\.json$/i.test(x.rel))) {
    try { const p = JSON.parse(fs.readFileSync(o.abs, "utf8")); const d = pkgDeps(p); packages.push({ dir: path.posix.dirname(o.rel) === "." ? "" : path.posix.dirname(o.rel), name: p.name || path.basename(path.dirname(o.abs)), deps: Object.keys(d), scripts: p.scripts || {}, kind: d.next ? "Next.js" : d.express || d.fastify || d.koa || d.hono ? "Node API" : d.react ? "React" : "Node" }); } catch {}
  }
  packages.sort((a, b) => b.dir.length - a.dir.length);
  const serviceOf = (rel) => (packages.find((p) => p.dir === "" || rel === p.dir || rel.startsWith(p.dir + "/")) || { dir: "" }).dir;
  const aliasRoots = new Map(); // service dir → where "@/" points (from jsconfig/tsconfig paths)
  for (const o of other.filter((x) => /(js|ts)config\.json$/i.test(x.rel))) { try { const c = JSON.parse(fs.readFileSync(o.abs, "utf8")); const t = c.compilerOptions?.paths?.["@/*"]?.[0]; if (t) aliasRoots.set(path.posix.dirname(o.rel) === "." ? "" : path.posix.dirname(o.rel), t.replace(/\/\*$/, "").replace(/^\.\//, "")); } catch {} }

  // ---- analyze files
  const infos = new Map();
  const parseErrors = [];
  const testTokens = new Set();
  let totalLoc = 0;
  for (const f of files) {
    let code; try { code = fs.readFileSync(f.abs, "utf8"); } catch { continue; }
    const info = analyzeFile(f, code, serviceOf(f.rel));
    totalLoc += info.loc;
    if (info.parseFailed) parseErrors.push({ file: f.rel, error: info.parseError });
    if (info.isTest) for (const w of code.match(/[A-Za-z_$][\w$]{2,}/g) || []) testTokens.add(w);
    infos.set(f.rel, { ...info, code: undefined });
  }
  const testFiles = [...infos.values()].filter((i) => i.isTest);

  // ---- import resolution
  const resolve = (fromRel, source) => {
    let base = null;
    if (source.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), source));
    else if (source.startsWith("@/")) { const sd = serviceOf(fromRel); const ar = aliasRoots.get(sd) ?? aliasRoots.get(""); if (ar === undefined) return null; base = path.posix.normalize(path.posix.join(sd, ar, source.slice(2))); }
    else return null;
    for (const e of EXTS) if (infos.has(base + e)) return base + e;
    return null;
  };
  const resolved = new Map();
  for (const [rel, i] of infos) resolved.set(rel, i.imports.map((s) => ({ source: s, target: resolve(rel, s) })));

  // ---- module purity (recursive over relative imports)
  const pureMemo = new Map();
  const isPure = (rel, stack = new Set()) => {
    if (pureMemo.has(rel)) return pureMemo.get(rel);
    if (stack.has(rel)) return true;
    stack.add(rel);
    const i = infos.get(rel);
    let ok = !!i && !i.sideEffects && !i.parseFailed && i.impureImports.size === 0 && !i.usesAlias && !i.jsx;
    if (ok) for (const r of resolved.get(rel)) { if (r.source.startsWith(".")) { if (!r.target || !isPure(r.target, stack)) { ok = false; break; } } }
    pureMemo.set(rel, ok);
    return ok;
  };

  // ---- mounts → route prefixes (microservices: app.use("/api/auth", authRouter))
  for (const [rel, i] of infos) {
    for (const m of i.mounts) {
      let targetRel = null;
      if (m.source) targetRel = resolve(rel, m.source);
      else if (i.bindings.has(m.ident)) targetRel = resolve(rel, i.bindings.get(m.ident));
      const targets = targetRel ? [[infos.get(targetRel), null]] : [[i, m.ident]];
      for (const [t, owner] of targets) for (const r of t.routes) if (!owner || r.owner === owner) if (!r.mountedBy) { r.path = (m.prefix.replace(/\/$/, "") + (r.path === "/" ? "" : r.path)) || "/"; r.mountedBy = rel; }
    }
  }

  // ---- collect
  const routes = [], units = [], components = [], apiCalls = [], proxies = [];
  for (const i of infos.values()) { routes.push(...i.routes); components.push(...i.components); apiCalls.push(...i.apiCalls); proxies.push(...i.proxies); }
  routes.forEach((r) => { r.service = infos.get(r.file).service; r.id = `${r.method} ${r.path}`; r.tested = [...testTokens].some((t) => t === r.path) || false; });
  // a route's body fields can come from validator functions it calls in another file (one level)
  for (const r of routes) {
    const i = infos.get(r.file);
    for (const c of r.calls || []) {
      const src = i.bindings.get(c); const target = src ? resolve(r.file, src) : null;
      const fields = target ? infos.get(target).fnFields?.[c] : null;
      if (fields && ["POST", "PUT", "PATCH"].includes(r.method)) for (const f of fields) if (!r.bodyFields.includes(f)) r.bodyFields.push(f);
    }
  }
  for (const i of infos.values()) for (const u of i.units) {
    u.pure = u.extractable;                    // can be run on its own, safely
    u.moduleSafe = isPure(u.file);             // the whole module can be imported without side effects
    u.tested = testTokens.has(u.name);
    units.push(u);
  }

  // ---- pages (E2E targets). A page also "contains" the client components it imports (one level).
  const pages = [];
  for (const [rel, i] of infos) {
    if (!i.isPageFile) continue;
    const m = rel.match(/(?:^|\/)app\/(.*?)\/?page\.[jt]sx?$/) || rel.match(/(?:^|\/)pages\/(.*)\.[jt]sx?$/);
    if (!m) continue;
    let p = "/" + m[1].replace(/\/index$/, "").split("/").filter((seg) => !/^\(.*\)$/.test(seg)).join("/").replace(/\[(\w+)\]/g, ":$1");
    p = p.replace(/\/+$/, "") || "/";
    if (/\/_(app|document|error)$/.test(p) || /(^|\/)\[|:/.test(p) === false && false) continue;
    const comps = [...i.components];
    for (const r of resolved.get(rel)) if (r.target) comps.push(...infos.get(r.target).components);
    pages.push({ path: p, file: rel, service: i.service, hasForm: comps.some((c) => c.hasForm), inputs: comps.flatMap((c) => c.inputs), buttons: [...new Set(comps.flatMap((c) => c.buttons))].slice(0, 8), headings: comps.flatMap((c) => c.headings).slice(0, 3), links: [...new Set(comps.flatMap((c) => c.links))].slice(0, 8), interactive: comps.some((c) => c.usesState || c.hasForm), dynamic: p.includes(":") });
  }

  // ---- service graph: who calls whom
  const names = packages.map((p) => ({ dir: p.dir, name: p.name, tokens: [path.basename(p.dir || root), p.name].join(" ").toLowerCase() }));
  const guessTarget = (txt, from) => { const t = txt.toLowerCase(); const hit = names.find((n) => n.dir !== from && n.tokens.split(/[\s\-_/@]+/).some((tok) => tok.length > 3 && !/^(service|app|api)$/.test(tok) && t.includes(tok))); return hit ? hit.name : null; };
  const NOISE = /loki|posthog|mixpanel|sentry|datadog|googleapis|segment/i;
  const edges = [
    ...proxies.filter((p) => !NOISE.test(p.target)).map((p) => ({ kind: "proxy", from: p.service || ".", to: guessTarget(p.target, p.service) || p.target, detail: `${p.pathFilter || "*"} → ${p.target}`, file: p.file, line: p.line })),
    ...apiCalls.filter((c) => !NOISE.test(c.url) && /https?:|process\.env|config\.|URL|Url|\/api\//.test(c.url)).map((c) => ({ kind: /^["'`]\//.test(c.url) ? "ui→api" : "service→service", from: c.service || ".", to: guessTarget(c.url, c.service) || c.url, detail: `${c.method} ${c.url}`, file: c.file, line: c.line })),
  ];

  // ---- misc signals
  const allDeps = new Set(packages.flatMap((p) => p.deps));
  const has = (...ds) => ds.some((d) => allDeps.has(d));
  const frameworks = [
    allDeps.has("next") && "Next.js", has("express") && "Express", has("fastify") && "Fastify", has("koa") && "Koa", has("react") && "React", has("react-native") && "React Native",
    has("pg", "mysql2", "mysql") && "SQL database", has("mongoose", "mongodb") && "MongoDB", has("@prisma/client", "prisma") && "Prisma", has("sequelize", "knex", "typeorm") && "ORM",
    has("redis", "ioredis") && "Redis", has("amqplib", "bullmq", "kafkajs") && "Message queue", has("jsonwebtoken", "jose", "next-auth", "passport") && "Auth (JWT/session)", has("zod", "joi", "yup") && "Schema validation",
  ].filter(Boolean);
  const existing = { files: testFiles.length, frameworks: ["jest", "vitest", "mocha", "@playwright/test", "playwright", "cypress", "@pact-foundation/pact", "supertest"].filter((d) => allDeps.has(d)) };
  const openapi = other.find((o) => /(openapi|swagger)\./i.test(o.rel))?.rel || null;
  const services = (packages.length ? packages : [{ dir: "", name: path.basename(root), kind: "Node", deps: [] }]).map((p) => ({ dir: p.dir || ".", name: p.name, kind: p.kind, routes: routes.filter((r) => (r.service || "") === p.dir).length, units: units.filter((u) => (u.service || "") === p.dir).length, pages: pages.filter((x) => (x.service || "") === p.dir).length })).filter((s) => s.routes || s.units || s.pages || packages.length <= 1).reverse();

  const id = crypto.createHash("sha1").update(root + Date.now()).digest("hex").slice(0, 10);
  return {
    id, dir: root, name: path.basename(root), scannedAt: Date.now(),
    stats: { files: files.length, lines: totalLoc, routes: routes.length, units: units.length, pureUnits: units.filter((u) => u.pure).length, pages: pages.length, components: components.length, edges: edges.length, services: services.length },
    frameworks, packages: packages.map((p) => ({ dir: p.dir || ".", name: p.name, kind: p.kind })), services, routes, units, pages, edges, existing, openapi,
    docker: other.some((o) => /(docker-compose|Dockerfile)/i.test(o.rel)), parseErrors: parseErrors.slice(0, 20),
    _internal: { resolvedCount: resolved.size },
  };
}
