// Integration (API) tests: real HTTP requests against a running app.
// Rule for assertions: assert exact statuses only where the code itself shows them; otherwise assert robust invariants
// (client errors are 4xx, never 5xx; JSON stays valid; no stack traces) so generated tests don't produce false failures.
import { flavor, header, q, slug, envName, bodyLiteral, pathTemplate } from "./util.js";

export const HTTP_HELPER = `// Tiny HTTP client used by the generated API tests (no dependencies; uses Node's built-in fetch).
//   BASE_URL     where the app is running (default below)
//   TEST_TOKEN   optional bearer token, for apps that require sign-in
//   EXPECT_AUTH  "1" if the app enforces sign-in (enables the 401 tests)
export const BASE_URL = (process.env.BASE_URL || "__BASE_URL__").replace(/\\/$/, "");
export const TOKEN = process.env.TEST_TOKEN || "";
export const EXPECT_AUTH = process.env.EXPECT_AUTH ? process.env.EXPECT_AUTH === "1" : __EXPECT_AUTH__;

export function baseFor(service) {
  const v = process.env["BASE_URL_" + String(service).toUpperCase().replace(/[^A-Z0-9]+/g, "_")];
  return (v || BASE_URL).replace(/\\/$/, "");
}

export async function api(base, method, path, { body, raw, headers = {}, auth = true } = {}) {
  const h = { ...headers };
  if (auth && TOKEN) h.authorization = "Bearer " + TOKEN;
  let payload;
  if (raw !== undefined) { payload = raw; h["content-type"] ??= "application/json"; }
  else if (body !== undefined) { payload = JSON.stringify(body); h["content-type"] ??= "application/json"; }
  const res = await fetch(base + path, { method, headers: h, body: payload, redirect: "manual" });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, text, json };
}
`;

const isCollection = (r) => !/:\w+/.test(r.path);
const WRITE = ["POST", "PUT", "PATCH", "DELETE"];
const SKIP_PATHS = /^\/(metrics|_next)/;

export function integrationFile(service, routes, fl, opts = {}) {
  const f = flavor(fl);
  const usable = routes.filter((r) => !SKIP_PATHS.test(r.path) && r.method !== "ALL" && r.method !== "HEAD" && r.method !== "OPTIONS");
  if (!usable.length) return null;
  const out = [header(`API integration tests: ${service}`, [`Run:  BASE_URL=http://localhost:PORT ${fl === "vitest" ? "npx vitest run <this file>" : "node --test <this file>"}   (see README)`, "These send real requests: POST/PUT/PATCH/DELETE change data in the app under test. Use a development database."]), f.imports,
    'import { api, baseFor, TOKEN, EXPECT_AUTH } from "../helpers/http.mjs";', "", `const base = baseFor(${q(service)});`,
    `const needsToken = EXPECT_AUTH && !TOKEN; // protected routes need TEST_TOKEN for the "success" tests`,
    "const created = []; // ids created by tests, deleted at the end", ""];
  let count = 0;
  const T = (name, body, o) => { count++; return f.it(name, body, o); };

  // group routes by resource: /api/todos (collection) + /api/todos/:id (item)
  const groups = new Map();
  for (const r of usable) { const base = r.path.replace(/\/:\w+\*?$/, ""); (groups.get(base) || groups.set(base, []).get(base)).push(r); }

  for (const [basePath, rs] of groups) {
    const get = (m, item) => rs.find((r) => r.method === m && (item ? !isCollection(r) : isCollection(r)));
    const list = get("GET", false), post = get("POST", false), one = get("GET", true), put = get("PUT", true), patch = get("PATCH", true), del = get("DELETE", true);
    const writer = put || patch;
    const fields = [...new Set([...(post?.bodyFields || []), ...(writer?.bodyFields || [])])].filter((x) => /^[\w$-]+$/.test(x));
    const requiresAuth = rs.some((r) => r.auth);
    const tests = [];
    const skipIfNoToken = requiresAuth ? "needsToken" : undefined;
    const has = (r, n) => !!r && r.statuses.includes(n);

    // ---- read endpoints
    if (list) {
      const ok = list.statuses.filter((s) => s < 400);
      tests.push(T(`GET ${list.path} returns ${ok.join("/") || "200"} with valid JSON`, `const res = await api(base, "GET", ${q(list.path)});\n${f.ok(`[${(ok.length ? ok : [200]).join(", ")}${list.auth ? ", ...(TOKEN ? [] : [401, 403])" : ""}].includes(res.status)`, "`unexpected status ${res.status}: ${res.text.slice(0, 120)}`")}\n${f.ok("res.json !== undefined", '"body is not valid JSON"')}\n${f.ok('(res.headers.get("content-type") || "").includes("json")', '"content-type should be JSON"')}`, { skip: skipIfNoToken }));
      if (list.queryFields.some((x) => /limit|size|page|offset/i.test(x))) {
        const lim = list.queryFields.find((x) => /limit|size/i.test(x)) || "limit";
        tests.push(T(`GET ${list.path} survives odd pagination values (${lim}=0, -1, 1000000, abc)`, `for (const v of ["0", "-1", "1000000", "abc", ""]) {\n  const res = await api(base, "GET", ${q(list.path)} + "?${lim}=" + v);\n  ${f.ok("res.status < 500", "`${" + `"${lim}"` + "}=${v} caused ${res.status}`")}\n}`, { skip: skipIfNoToken }));
      }
    }
    // ---- create + lifecycle
    const canCreate = post && fields.length > 0;
    const create = canCreate ? `const made = await api(base, "POST", ${q(post.path)}, { body: ${bodyLiteral(fields.filter((x) => x !== "done"))} });\n${f.ok("made.status < 300", "`create failed: ${made.status} ${made.text.slice(0, 120)}`")}\nconst id = made.json?.id ?? made.json?.data?.id;\n${f.ok("id !== undefined", '"create response has no id, cannot continue"')}\ncreated.push(id);` : null;
    if (post) {
      tests.push(T(`POST ${post.path} rejects an empty body with a client error`, `const res = await api(base, "POST", ${q(post.path)}, { body: {} });\n${f.ok(has(post, 400) ? "res.status >= 400 && res.status < 500" : "res.status < 500", "`empty body gave ${res.status}`")}`, { skip: skipIfNoToken }));
      tests.push(T(`POST ${post.path} rejects malformed JSON without a server error`, `const res = await api(base, "POST", ${q(post.path)}, { raw: "{not json" });\n${f.ok("res.status >= 400 && res.status < 500", "`malformed JSON gave ${res.status}: ${res.text.slice(0, 120)}`")}\n${f.ok("!/node_modules|at \\S+ \\(|\\.js:\\d+/.test(res.text)", '"error response leaks a stack trace"')}`, { skip: skipIfNoToken }));
      if (canCreate) {
        for (const field of fields.slice(0, 3)) {
          const base0 = fields.filter((x) => x !== field);
          tests.push(T(`POST ${post.path}: "${field}" missing / null / wrong type / blank / 201 chars never crashes the server`, `const good = ${bodyLiteral(base0)};\nfor (const bad of [undefined, null, 12345, "", "   ", "x".repeat(201), [], {}]) {\n  const res = await api(base, "POST", ${q(post.path)}, { body: bad === undefined ? good : { ...good, ${/^[A-Za-z_$][\w$]*$/.test(field) ? field : q(field)}: bad } });\n  ${f.ok("res.status < 500", "`${JSON.stringify(bad)} gave ${res.status}: ${res.text.slice(0, 100)}`")}\n  if (res.status < 300 && res.json?.id !== undefined) created.push(res.json.id);\n}`, { skip: skipIfNoToken }));
        }
        tests.push(T(`POST ${post.path} ignores privileged fields (mass assignment)`, `const res = await api(base, "POST", ${q(post.path)}, { body: ${bodyLiteral(fields, { id: 999999999, user_id: "attacker", is_admin: true, role: "admin" })} });\n${f.ok("res.status < 500", "`gave ${res.status}`")}\nif (res.status < 300 && res.json) {\n  created.push(res.json.id);\n  ${f.ok("res.json.id !== 999999999", '"client was able to choose the id"')}\n  ${f.ok('res.json.is_admin !== true && res.json.role !== "admin" && res.json.user_id !== "attacker"', '"privileged field was accepted"')}\n}`, { skip: skipIfNoToken }));
        tests.push(T(`POST ${post.path} twice does not crash (double submit)`, `const body = ${bodyLiteral(fields.filter((x) => x !== "done"))};\nconst a = await api(base, "POST", ${q(post.path)}, { body });\nconst b = await api(base, "POST", ${q(post.path)}, { body });\n${f.ok("a.status < 500 && b.status < 500", "`double submit gave ${a.status}/${b.status}`")}\nfor (const r of [a, b]) if (r.status < 300 && r.json?.id !== undefined) created.push(r.json.id);`, { skip: skipIfNoToken }));
        tests.push(T(`POST ${post.path} stores HTML/unicode text safely`, `const text = "<script>alert(1)</script> ñandú 🚀 \\u202Erlo";\nconst field = ${q(fields.find((x) => /title|name|text/i.test(x)) || fields[0])};\nconst res = await api(base, "POST", ${q(post.path)}, { body: { ...${bodyLiteral(fields)}, [field]: text } });\n${f.ok("res.status < 500", "`gave ${res.status}`")}\nif (res.status < 300) { created.push(res.json?.id); ${f.ok("res.json?.[field] === text || res.json === undefined", '"text was altered on the way in"')} }`, { skip: skipIfNoToken }));
      }
    }
    if (canCreate && one) {
      const url = pathTemplate(one.path);
      tests.push(T(`lifecycle: create → read → ${writer ? "update → " : ""}${del ? "delete → read gives not-found" : "read"}`,
        `${create}\nconst got = await api(base, "GET", ${url});\n${f.eq("got.status", "200")}\n${fields.find((x) => /title|name/i.test(x)) ? f.eq(`got.json?.${fields.find((x) => /title|name/i.test(x))}`, `${q("TestLab sample")}`) + "\n" : ""}${writer ? `const upd = await api(base, ${q(writer.method)}, ${pathTemplate(writer.path)}, { body: { ${fields.find((x) => /title|name/i.test(x)) ? `${fields.find((x) => /title|name/i.test(x))}: "TestLab updated"` : `${fields[0]}: "updated"`} } });\n${f.ok("upd.status >= 200 && upd.status < 300", "`update gave ${upd.status}: ${upd.text.slice(0, 120)}`")}\n` : ""}${del ? `const gone = await api(base, "DELETE", ${pathTemplate(del.path)});\n${f.ok("gone.status >= 200 && gone.status < 300", "`delete gave ${gone.status}`")}\nconst after = await api(base, "GET", ${url});\n${f.ok("after.status >= 400 && after.status < 500", "`deleted item still answers ${after.status}`")}\ncreated.pop();` : ""}`, { skip: skipIfNoToken }));
      if (patch && fields.length > 1 && fields.some((x) => /done|completed|active/i.test(x)) && fields.some((x) => /title|name/i.test(x))) {
        const tf = fields.find((x) => /title|name/i.test(x)), df = fields.find((x) => /done|completed|active/i.test(x));
        tests.push(T(`PATCH ${patch.path} changes only the fields sent`, `${create}\nconst p = await api(base, "PATCH", ${pathTemplate(patch.path)}, { body: { ${df}: true } });\n${f.ok("p.status < 300", "`patch gave ${p.status}`")}\nconst got = await api(base, "GET", ${url});\n${f.eq(`got.json?.${tf}`, q("TestLab sample"))}\n${f.eq(`got.json?.${df}`, "true")}`, { skip: skipIfNoToken }));
      }
    }
    // ---- id edge cases (any route with :id)
    for (const r of rs.filter((x) => !isCollection(x))) {
      const m = r.method;
      const needsBody = ["POST", "PUT", "PATCH"].includes(m);
      const bodyArg = needsBody ? `, { body: ${bodyLiteral(fields.length ? fields : ["title"])} }` : "";
      tests.push(T(`${m} ${r.path}: ids that do not exist or are malformed give a client error, never a server error`, `for (const id of ["987654321", "0", "-1", "abc", "1.5", "2147483648", "99999999999999999999", "1;DROP TABLE x", "%00", "00000000-0000-0000-0000-000000000000"]) {\n  const res = await api(base, ${q(m)}, ${pathTemplate(r.path)}${bodyArg});\n  ${f.ok("res.status < 500", "`id=${id} gave ${res.status}: ${res.text.slice(0, 100)}`")}\n  ${f.ok("res.status >= 400", "`id=${id} unexpectedly succeeded with ${res.status}`")}\n}`, { skip: skipIfNoToken }));
    }
    if (del && canCreate && one) {
      tests.push(T(`DELETE ${del.path} twice: second call is a client error, not a crash`, `${create}\nconst a = await api(base, "DELETE", ${pathTemplate(del.path)});\n${f.ok("a.status < 300", "`first delete gave ${a.status}`")}\nconst b = await api(base, "DELETE", ${pathTemplate(del.path)});\n${f.ok("b.status < 500", "`second delete gave ${b.status}`")}\ncreated.pop();`, { skip: skipIfNoToken }));
    }
    // ---- auth
    for (const r of rs.filter((x) => x.auth)) {
      const url = isCollection(r) ? q(r.path) : pathTemplate(r.path, { id: '"1"' });
      tests.push(T(`${r.method} ${r.path} without credentials is rejected (401)`, `const res = await api(base, ${q(r.method)}, ${url}, { auth: false${["POST", "PUT", "PATCH"].includes(r.method) ? ", body: {}" : ""} });\n${f.eq("res.status", "401")}`, { skip: "!EXPECT_AUTH" }));
    }
    if (requiresAuth) {
      const r = rs.find((x) => x.auth);
      const url = isCollection(r) ? q(r.path) : pathTemplate(r.path, { id: '"1"' });
      tests.push(T(`${r.method} ${r.path} with a malformed or tampered token is rejected`, `for (const authorization of ["Bearer", "Bearer not.a.jwt", "Basic dXNlcjpwYXNz", "Bearer " + "A".repeat(500)]) {\n  const res = await api(base, ${q(r.method)}, ${url}, { auth: false, headers: { authorization } });\n  ${f.ok("res.status === 401 || res.status === 403", "`${authorization.slice(0, 20)} gave ${res.status}`")}\n}`, { skip: "!EXPECT_AUTH" }));
    }
    // ---- delete-less read-only routes: smoke
    for (const r of rs.filter((x) => x.method === "GET" && isCollection(x) && x !== list)) {
      const ok = r.statuses.filter((s) => s < 400);
      tests.push(T(`GET ${r.path} responds ${ok.join("/") || "200"}`, `const res = await api(base, "GET", ${q(r.path)});\n${f.ok(`[${(ok.length ? ok : [200]).join(", ")}${r.auth ? ", 401, 403" : ""}].includes(res.status)`, "`status ${res.status}`")}`));
    }
    // ---- other write routes without a resource group (login, register, ...)
    for (const r of rs.filter((x) => x.method === "POST" && x !== post)) {
      tests.push(T(`POST ${r.path} rejects an empty body without a server error`, `const res = await api(base, "POST", ${q(r.path)}, { body: {}, auth: false });\n${f.ok("res.status < 500", "`gave ${res.status}: ${res.text.slice(0, 100)}`")}`));
      tests.push(T(`POST ${r.path} rejects malformed JSON without a server error`, `const res = await api(base, "POST", ${q(r.path)}, { raw: "{broken", auth: false });\n${f.ok("res.status >= 400 && res.status < 500", "`gave ${res.status}`")}`));
    }
    if (!tests.length) continue;
    out.push(`describe(${q(`${basePath}  (${rs.map((r) => r.method).join(", ")})`)}, () => {`, ...tests, "});", "");
  }
  out.push(`describe("cleanup", () => {`, f.it("removes records created by this file", `const del = ${q(routes.find((r) => r.method === "DELETE")?.path || "")};\nif (!del) return;\nfor (const id of created.filter((x) => x !== undefined)) await api(base, "DELETE", del.replace(/:\\w+\\*?/, encodeURIComponent(id)));`, { skip: skipCleanup(routes) }), "});", "");
  return { content: out.join("\n"), count };
}
const skipCleanup = (routes) => (routes.some((r) => r.auth) ? "needsToken" : undefined);
