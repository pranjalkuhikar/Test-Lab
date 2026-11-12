# 🧪 TestLab: know what to test, and get the tests

Point TestLab at a **JavaScript project**. It reads the code, tells you **which kinds of tests you need and in what proportion**,
lists the **edge cases** for every endpoint and function, **writes the test files**, and **runs them** so you know what passes.

```
Scan  →  Recommend a mix  →  Edge cases  →  Generate files  →  Verify
        (e.g. 40% unit,      per endpoint    unit, API,         unit in a sandbox,
         35% API, 15%        and function    contract, Pact,    API against your
         contract …)                         E2E (Playwright)   running app
```

Built with **Next.js** and plain JavaScript. One dependency besides Next/React: `@babel/parser`. No database.

## Run it
```bash
cd test-lab
npm install
npm run dev          # http://localhost:5100
```
Open it, click one of your project folders (or paste a path), and press **Scan**.

## What you get

| Step | What happens |
|---|---|
| **Scan** | Parses every `.js/.jsx/.ts/.tsx/.mjs/.cjs` file (it never runs your code) and finds HTTP routes (Next.js app and pages routers, Express-style `app.get(...)`, including router prefixes mounted in other files), exported functions, UI pages and forms, calls between services, existing tests |
| **Recommended mix** | Percentages for **Unit · Integration · Contract (schema) · Pact · E2E**, each with the evidence behind it |
| **What to test first** | Functions and endpoints ranked by risk (complexity, writes data, auth-protected, already tested?) |
| **Edge cases** | Per endpoint and per function: bad IDs, missing/blank/oversized fields, malformed JSON, mass assignment, double submit, auth, pagination, XSS/SQL payloads… Items marked `auto` become test code |
| **Generate** | Real files in `tests-generated/`, runnable with `node --test` (or Vitest). Download as ZIP or write into the project |
| **Verify** | Runs what was generated. Unit tests run in a **restricted sandbox**; API/contract tests run against your running app after you confirm |

### The five test layers

| Layer | How it is generated |
|---|---|
| **Unit** | **Characterization tests.** Each self-contained exported function is executed in a sandbox with 30–45 edge inputs (empty, huge, `null`, `NaN`, wrong types, missing fields, …). The test pins what it really returned or threw. Results that change between runs (time, randomness) are dropped |
| **Integration (API)** | Real HTTP requests: create → read → update → delete lifecycles, bad/missing IDs, malformed JSON, per-field abuse, mass assignment, double submit, XSS payloads, stack-trace leaks, auth (401, tampered tokens) |
| **Contract (schema)** | Learns each `GET` response's real shape by probing your running app (read-only), then asserts it stays that shape |
| **Pact** | Writes **Pact v3 JSON files** (type matching rules) per consumer/provider pair, plus a verifier that replays them against the provider |
| **E2E** | **Playwright** specs: every page loads without errors; forms accept input and submit. (Generated, not run by TestLab; needs `@playwright/test`) |

## How the percentages are calculated
Each layer scores the evidence the scan found, then scores are scaled to 100%:

- **Unit**: branches (complexity) of functions with real logic, weighted up for functions that can be run in isolation
- **Integration**: endpoints, plus input validation, body fields, auth and writes
- **Contract**: endpoints (plus an OpenAPI file or UI consumers, if present)
- **Pact**: connections between services (proxies, service-to-service calls) and the number of services; **0% for a single service**
- **E2E**: pages, forms, and a login/registration flow; **capped at 20%** because browser tests are slow and brittle

It is a transparent heuristic, **not a rule**. The page shows the reasons behind each number.

## Safety
- **The scan only reads files.** Nothing from your project is executed while scanning.
- **Unit-test recording runs in a restricted child process** (`node --permission`: no file writes, no subprocesses, no workers, read access only to TestLab's own folder), and only for functions that depend on nothing but themselves and safe constants. Functions that touch the database, network, `process.env`, or imports are skipped (with the reason shown).
- **Before generating**, each module is test-imported in the same sandbox. If it can't load on its own (needs env vars, JSX/TypeScript, hangs), its tests are **not generated**; you see it under "skipped" with the reason.
- **API and contract tests send real requests**, including `POST/PUT/PATCH/DELETE`. They only run against **localhost** and only after you tick a confirmation box. Contract probing uses **GET only**.
- The API answers only the dashboard on a loopback host (blocks other sites in your browser). Generated files are written to your project **only when you click the button**, and an existing `tests-generated/` is never overwritten without confirmation.

## Please read: limits
- **Characterization tests pin what the code does today, not what it should do.** If a function has a bug, its test will bless it. Read each expected value.
- Functions that mix logic with database/network calls aren't unit-tested automatically (they'd need mocks). Move the logic into small pure functions, or rely on the API tests.
- Body fields for endpoints are inferred from code (including validators in other files, one level deep). Unusual patterns may be missed; edit the generated test.
- Contract and Pact tests need the app **running** (to learn real shapes) and, for protected routes, a bearer token.
- E2E tests are generated but not executed here.
- Static analysis is heuristic: routes registered dynamically (loops, plugins) may be missed.
- JavaScript/TypeScript only; TypeScript source is scanned for routes, but its functions are not unit-tested (they need a compiler).
- No LLM is used. Everything is deterministic analysis, so the same project gives the same output. An AI layer could write richer assertions and is a natural next step.

## Running the generated tests
```bash
# unit
node --test "tests-generated/unit/*.test.mjs"
# API + contract (set the app's URL; add TEST_TOKEN for protected apps)
BASE_URL=http://localhost:3000 TEST_TOKEN=... node --test "tests-generated/integration/*.test.mjs" "tests-generated/contract/*.test.mjs"
```
Quote the patterns (Node 21+). Environment variables: `BASE_URL`, `BASE_URL_<SERVICE>`, `TEST_TOKEN`, `EXPECT_AUTH`.

## HTTP API
| Endpoint | Purpose |
|---|---|
| `POST /api/scan` `{dir}` | Scan a project → model, recommendation, edge cases |
| `GET /api/scan`, `GET /api/scan/:id` | Recent scans / reload one |
| `POST /api/generate` `{scanId, layers, flavor, baseUrl, token}` | Generate files |
| `POST /api/verify` `{genId, confirmRequests}` | Run them and return per-test results |
| `GET /api/download/:id` | ZIP of the files |
| `POST /api/write` `{genId, overwrite?}` | Write into `<project>/tests-generated` |
| `GET /api/discover` | Local servers and sibling projects |

## Layout
```
engine/
  scan.js           static analysis: routes, functions, pages, edges, tests
  recommend.js      test mix + risk ranking
  edgecases.js      edge-case catalogue + concrete inputs
  record.js, record-child.mjs, preflight-child.mjs   sandboxed execution
  generate/         unit.js · integration.js · contract.js (+Pact) · e2e.js · index.js
  verify.js         runs the generated tests, parses JUnit results
  zip.js            dependency-free ZIP writer
app/ + components/  the dashboard (Next.js)
```
