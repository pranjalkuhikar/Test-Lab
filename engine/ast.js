// Thin helpers over @babel/parser: parse a file, walk the tree, read names out of nodes.
import { parse } from "@babel/parser";

export function parseSource(code, file) {
  const ts = /\.tsx?$/.test(file);
  return parse(code, { sourceType: "unambiguous", errorRecovery: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, plugins: ["jsx", ...(ts ? ["typescript"] : [])] });
}

const SKIP = new Set(["loc", "start", "end", "extra", "leadingComments", "trailingComments", "innerComments", "errors", "range"]);

// Depth-first walk. Return `false` from visit() to skip a node's children.
export function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== "string") return;
  if (visit(node, parent) === false) return;
  for (const key in node) {
    if (SKIP.has(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === "string") walk(c, visit, node); }
    else if (v && typeof v.type === "string") walk(v, visit, node);
  }
}

export const isFn = (n) => n && (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression");
export const text = (code, n, max = 90) => { const s = code.slice(n.start, n.end).replace(/\s+/g, " ").trim(); return s.length > max ? s.slice(0, max - 1) + "…" : s; };

// a.b.c → "a.b.c"; anything else → null
export function chain(n) {
  if (!n) return null;
  if (n.type === "Identifier") return n.name;
  if (n.type === "ThisExpression") return "this";
  if (n.type === "MemberExpression" || n.type === "OptionalMemberExpression") {
    const o = chain(n.object);
    if (!o) return null;
    if (!n.computed && n.property.type === "Identifier") return `${o}.${n.property.name}`;
    if (n.computed && n.property.type === "StringLiteral") return `${o}.${n.property.value}`;
  }
  return null;
}

export const calleeName = (call) => chain(call.callee) || (call.callee.type === "Import" ? "import" : null);
export const strValue = (n) => (n && n.type === "StringLiteral" ? n.value : n && n.type === "TemplateLiteral" && n.expressions.length === 0 ? n.quasis[0].value.cooked : null);

// McCabe-style complexity plus the branch conditions as readable text (used for edge cases)
export function measure(code, fnNode) {
  let complexity = 1, throws = false, awaits = false;
  const conditions = [];
  const refs = new Set();
  walk(fnNode.body, (n) => {
    switch (n.type) {
      case "IfStatement": complexity++; conditions.push(text(code, n.test)); break;
      case "ConditionalExpression": complexity++; conditions.push(text(code, n.test)); break;
      case "LogicalExpression": complexity++; break;
      case "SwitchCase": if (n.test) { complexity++; conditions.push("case " + text(code, n.test)); } break;
      case "ForStatement": case "ForInStatement": case "ForOfStatement": case "WhileStatement": case "DoWhileStatement": complexity++; break;
      case "CatchClause": complexity++; break;
      case "ThrowStatement": throws = true; break;
      case "AwaitExpression": awaits = true; break;
      case "Identifier": refs.add(n.name); break;
    }
  });
  return { complexity, throws, awaits, conditions: [...new Set(conditions)].slice(0, 12), refs };
}

// Identifiers a function uses but does not declare itself (its "free variables").
// Used to decide whether a function can be run in isolation.
export function freeVars(fn) {
  const declared = new Set(), used = new Set();
  const decl = (p) => {
    if (!p) return;
    switch (p.type) {
      case "Identifier": declared.add(p.name); break;
      case "ObjectPattern": p.properties.forEach((x) => decl(x.type === "RestElement" ? x.argument : x.value)); break;
      case "ArrayPattern": p.elements.forEach(decl); break;
      case "AssignmentPattern": decl(p.left); break;
      case "RestElement": decl(p.argument); break;
    }
  };
  fn.params.forEach(decl);
  walk(fn, (n, parent) => {
    if (n !== fn && isFn(n)) n.params.forEach(decl);
    if ((n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ClassDeclaration") && n.id && n !== fn) declared.add(n.id.name);
    if (n.type === "VariableDeclarator") decl(n.id);
    if (n.type === "CatchClause") decl(n.param);
    if (n.type === "Identifier") {
      if (parent && (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && parent.property === n && !parent.computed) return;
      if (parent && (parent.type === "ObjectProperty" || parent.type === "ObjectMethod" || parent.type === "ClassMethod" || parent.type === "ClassProperty") && parent.key === n && !parent.computed) return;
      if (parent && (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement")) return;
      used.add(n.name);
    }
  });
  return [...used].filter((x) => !declared.has(x));
}

// Property names read off a function's first argument (what shape of object does it expect?)
export function paramFields(fn) {
  const p = fn.params[0];
  const out = new Set();
  if (!p) return [];
  if (p.type === "ObjectPattern") { p.properties.forEach((x) => x.key?.name && out.add(x.key.name)); return [...out]; }
  const name = p.type === "Identifier" ? p.name : p.type === "AssignmentPattern" && p.left.type === "Identifier" ? p.left.name : null;
  if (!name) return [];
  walk(fn.body, (n) => {
    if (n.type === "MemberExpression" && !n.computed && n.object.type === "Identifier" && n.object.name === name && n.property.type === "Identifier") out.add(n.property.name);
    if (n.type === "BinaryExpression" && n.operator === "in" && n.left.type === "StringLiteral" && n.right.type === "Identifier" && n.right.name === name) out.add(n.left.value);
  });
  return [...out];
}

// "Magic values" written in a function: the thresholds it compares against and the constants it computes with.
// Tests that hit exactly these values (and one either side) are what catch off-by-one and boundary bugs.
export function constantsOf(fn) {
  const numbers = new Set(), strings = new Set(), lengths = new Set();
  const num = (n) => (n.type === "NumericLiteral" ? n.value : n.type === "UnaryExpression" && n.operator === "-" && n.argument.type === "NumericLiteral" ? -n.argument.value : null);
  walk(fn.body, (n) => {
    if (n.type === "NumericLiteral" && Number.isFinite(n.value) && Math.abs(n.value) < 1e12) numbers.add(n.value);
    if (n.type === "BinaryExpression" && ["<", "<=", ">", ">=", "===", "!==", "==", "!="].includes(n.operator)) {
      for (const [a, b] of [[n.left, n.right], [n.right, n.left]]) {
        const v = num(b);
        if (v !== null && a.type === "MemberExpression" && !a.computed && a.property.name === "length") lengths.add(v);
        if (b.type === "StringLiteral" && b.value.length <= 24) strings.add(b.value);
      }
    }
    if (n.type === "SwitchCase" && n.test?.type === "StringLiteral") strings.add(n.test.value);
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && ["includes", "startsWith", "endsWith", "indexOf"].includes(n.callee.property?.name) && n.arguments[0]?.type === "StringLiteral" && n.arguments[0].value.length <= 24) strings.add(n.arguments[0].value);
  });
  const trivial = new Set([0, 1, 2]);
  return { numbers: [...numbers].filter((v) => !trivial.has(v)).sort((a, b) => a - b).slice(0, 14), strings: [...strings].slice(0, 8), lengths: [...lengths].filter((v) => v >= 0 && v < 5000).slice(0, 5) };
}
