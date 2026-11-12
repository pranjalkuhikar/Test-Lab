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
| **Verify** | Runs what was generated. Unit tests run in a **restricted sandbox**; API, contract and browser (E2E) tests run against your running app after you confirm |

### The five test layers

| Layer | How it is generated |
|---|---|
| **Unit** | **Characterization tests.** Each self-contained exported function is executed in a sandbox with 30–45 edge inputs (empty, huge, `null`, `NaN`, wrong types, missing fields, …). The test pins what it really returned or threw. Results that change between runs (time, randomness) are dropped |
| **Integration (API)** | Real HTTP requests: create → read → update → delete lifecycles, bad/missing IDs, malformed JSON, per-field abuse, mass assignment, double submit, XSS payloads, stack-trace leaks, auth (401, tampered tokens) |
| **Contract (schema)** | Learns each `GET` response's real shape by probing your running app (read-only), then asserts it stays that shape |
| **Pact** | Writes **Pact v3 JSON files** (type matching rules) per consumer/provider pair, plus a verifier that replays them against the provider |
| **E2E** | **Playwright** specs: every page loads without errors; forms accept input and submit, or are correctly blocked (a disabled submit button counts as a pass). TestLab runs them in a **locally installed Chrome, Brave, Chromium or Edge** (or `PLAYWRIGHT_EXECUTABLE`), so nothing is downloaded |

## Live websites (just a URL)
Switch to the **🌐 Live website** tab, enter a URL (for example your hosted portfolio), confirm you own it, and press **Analyze**. No source code is needed.

| Step | What happens |
|---|---|
| **Visit** | A real local browser (Chrome/Brave/Chromium/Edge) opens up to 30 pages, **one at a time with pauses**, and records titles, headings, forms, links, images, scripts, third-party hosts, console errors, timings (LCP, CLS, load, size), the JSON API calls the pages make, response headers, cookie flags, `robots.txt`, `sitemap.xml`, the 404 behaviour and the http→https redirect. Accessibility is measured with **axe-core** inside each rendered page |
| **Recommend** | A mix tailored to a website: **End-to-end/smoke · Accessibility · Performance · Visual/responsive · SEO · Security headers (passive) · Links · API contract**, each with the evidence behind it. A portfolio comes out smoke + accessibility + SEO + links heavy; a web app gets more end-to-end and API checks |
| **Problems now** | A severity-ranked list you can act on today (low contrast, missing alt text, missing security headers, broken links, slow pages…), each with how to fix it |
| **Generate** | Playwright specs: `smoke` (desktop + mobile), `links`, `a11y`, `seo`, `security-headers`, `performance` (1.5× regression budgets plus Google's "good" thresholds), `visual` (desktop + mobile snapshots), `forms` (never submitted) and `api-contract` (shapes learned from the real JSON responses). Download as a ZIP |
| **Run** | A real browser runs them against the live site (visual baselines are created first). Failing checks are real problems on the site, or a check that needs adjusting |

**Safety:** you must tick that you own the site or have permission. It only **reads**: it respects `robots.txt` (and stops if it disallows the start page), stays on the same domain, never submits forms or logs in, does not try to get around bot protection (a blocked page is reported as blocked), and refuses link-local/metadata addresses. Running the generated tests needs a second confirmation. Only test sites you own.

**Limits:** it sees what a visitor sees. Logged-in areas, admin screens and server-side logic are not covered, and results reflect the connection and machine it ran on. Automatic accessibility scans catch only part of real problems; a keyboard walkthrough is still worth doing.

## AI review (optional)
Tick **✨ AI review** in the Generate panel and Claude (default `claude-opus-5-5`; Sonnet 5.5 and Haiku 5.5 are selectable) reviews the ~10 riskiest functions and ~8 endpoints. It adds what rules can't:

- **Realistic structured inputs** (nested objects, arrays of records, typed arrays of counts) that reach branches generic edge values never do
- **Suspected bugs**, each with a concrete input and what a correct implementation would return
- **Endpoint rules** from reading the handler and its validators (exact length limits, required vs optional fields, expected status codes)

**The AI proposes; TestLab disposes.** Nothing the model says is trusted:

| Step | What happens |
|---|---|
| Input check | Every input the AI writes is **code**. It must pass a strict whitelist (literals, arrays/objects, typed arrays, a few builtins). `process`, `require`, `fetch`, `eval`, `constructor` tricks and loops are rejected before anything runs |
| Execution | Accepted inputs run in the same restricted sandbox as every other unit test; the **real** result is recorded |
| Cross-check | Each "bug" claim is compared with that real result. If the code already does what the AI said it should, the claim is **discarded**. Only real discrepancies survive |
| API cases | AI predictions for endpoints become tests that run against your app; a wrong prediction shows up as a finding, not as silent breakage |

Findings are **leads for a human**: the sandbox proves the code differs from the AI's expectation, not that the AI is right about what is correct. They appear in the UI, in `AI-FINDINGS.md`, and as `[AI finding]` / `[AI expectation]` tests, reported separately from real failures.

**Privacy and cost:** AI review is off by default and needs an explicit consent tick, because the source of the reviewed functions/endpoints (and the validators they call) is sent to the Anthropic API. Strings that look like secrets (API keys, tokens, private keys, passwords) are redacted first. The key you paste is used for that request only and is never stored or logged; alternatively set `ANTHROPIC_API_KEY` where TestLab runs. A price estimate is shown before you generate and the real token usage after.

### Does it actually catch bugs? (mutation testing)
Method: generate tests from the original code, then break the code one small way at a time (`>` → `>=`, `&&` → `||`, `3600` → `3601`, …) and count how many broken versions the tests notice. On the load-tester's own helper functions (120 mutants):

| Test inputs | Mutants caught |
|---|---|
| Generic edge values only | 43% |
| + boundary values taken from the function's own constants and comparisons | 77.5% |
| + long text outputs pinned by length and SHA-256 | 79% |
| + realistic structured inputs *(measured with a scripted stand-in for the AI)* | 89% |

The last row measures the mechanism (richer inputs kill more mutants), not a specific model's quality. Survivors are mostly functions that need domain-specific data and a few equivalent mutants that cannot change behaviour.

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
- E2E tests only cover "pages load cleanly" and "forms accept input". They do not know your business flows. They submit forms, so run them against a development database.
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
