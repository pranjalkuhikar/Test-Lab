// AI-supplied test inputs are CODE (e.g. `[new Uint32Array(520).fill(3), 95]`). Before one is executed or written into a test file,
// it must pass this whitelist: literals, arrays/objects, typed arrays, a few builtins, simple arrow functions. No identifiers other
// than builtins, no statements, no property access that could reach the Function constructor or process.
import { parse } from "@babel/parser";
import { walk, freeVars } from "../ast.js";

const ALLOWED = new Set(["Array", "Object", "Math", "JSON", "Number", "String", "Boolean", "BigInt", "Date", "Map", "Set", "RegExp", "Symbol", "NaN", "Infinity", "undefined", "Error", "TypeError", "RangeError",
  "Uint8Array", "Int8Array", "Uint16Array", "Int16Array", "Uint32Array", "Int32Array", "Float32Array", "Float64Array"]);
const NODES = new Set(["File", "Program", "ExpressionStatement", "StringLiteral", "NumericLiteral", "BooleanLiteral", "NullLiteral", "BigIntLiteral", "RegExpLiteral", "TemplateLiteral", "TemplateElement",
  "Identifier", "ArrayExpression", "ObjectExpression", "ObjectProperty", "SpreadElement", "NewExpression", "CallExpression", "MemberExpression", "OptionalMemberExpression", "OptionalCallExpression", "ArrowFunctionExpression",
  "BinaryExpression", "LogicalExpression", "UnaryExpression", "ConditionalExpression", "ParenthesizedExpression", "SequenceExpression"]);
const BAD_PROPS = new Set(["constructor", "__proto__", "prototype", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "caller", "callee", "arguments"]);

export function safeExpr(expr, { maxLen = 3000 } = {}) {
  if (typeof expr !== "string" || !expr.trim()) return { ok: false, reason: "empty" };
  if (expr.length > maxLen) return { ok: false, reason: "too long" };
  let ast;
  try { ast = parse("(" + expr + ")", { sourceType: "script", createParenthesizedExpressions: false }); } catch (e) { return { ok: false, reason: "does not parse: " + e.message.split("\n")[0].slice(0, 80) }; }
  if (ast.program.body.length !== 1 || ast.program.body[0].type !== "ExpressionStatement") return { ok: false, reason: "must be a single expression" };
  let bad = null;
  walk(ast.program, (n) => {
    if (bad) return false;
    if (!NODES.has(n.type)) { bad = `${n.type} is not allowed`; return false; }
    if (n.type === "MemberExpression" || n.type === "OptionalMemberExpression") {
      const p = n.property;
      if (!n.computed && p.type === "Identifier" && BAD_PROPS.has(p.name)) { bad = `.${p.name} is not allowed`; return false; }
      if (n.computed && p.type !== "NumericLiteral" && p.type !== "StringLiteral") { bad = "computed property access is not allowed"; return false; }
      if (n.computed && p.type === "StringLiteral" && BAD_PROPS.has(p.value)) { bad = "forbidden property"; return false; }
    }
    if (n.type === "ArrowFunctionExpression" && n.body.type === "BlockStatement") { bad = "function bodies must be a single expression"; return false; }
    if (n.type === "CallExpression" && n.callee.type === "Identifier" && !ALLOWED.has(n.callee.name)) { bad = `call to ${n.callee.name} is not allowed`; return false; }
  });
  if (bad) return { ok: false, reason: bad };
  const wrapper = parse(`(() => (${expr}))`, { sourceType: "script" }).program.body[0].expression;
  const free = freeVars(wrapper.type === "ParenthesizedExpression" ? wrapper.expression : wrapper).filter((x) => !ALLOWED.has(x));
  if (free.length) return { ok: false, reason: `unknown identifier ${free[0]}` };
  return { ok: true };
}
