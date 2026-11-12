# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: pages.spec.mjs >> page / >> empty form submission does not crash the page
- Location: tests-generated/e2e/pages.spec.mjs:34:3

# Error details

```
Test timeout of 30000ms exceeded.
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - main [ref=e2]:
    - heading "Next.js app (Postgres)" [level=1] [ref=e3]
    - paragraph [ref=e4]:
      - text: "API:"
      - link "/api/todos" [ref=e5] [cursor=pointer]:
        - /url: /api/todos
      - text: ·
      - link "/api/health" [ref=e6] [cursor=pointer]:
        - /url: /api/health
      - text: ·
      - link "/api/metrics" [ref=e7] [cursor=pointer]:
        - /url: /api/metrics
    - generic [ref=e8]:
      - textbox "New todo" [ref=e9]
      - button "Add" [disabled] [ref=e10]
    - list [ref=e11]:
      - listitem [ref=e12]:
        - generic [ref=e13]:
          - checkbox "sample" [ref=e14]
          - text: sample
        - button "delete" [ref=e15]
      - listitem [ref=e16]:
        - generic [ref=e17]:
          - checkbox "Check these rows in Adminer (localhost:8081)" [ref=e18]
          - text: Check these rows in Adminer (localhost:8081)
        - button "delete" [ref=e19]
      - listitem [ref=e20]:
        - generic [ref=e21]:
          - checkbox "Open Grafana (localhost:3001) to watch requests" [ref=e22]
          - text: Open Grafana (localhost:3001) to watch requests
        - button "delete" [ref=e23]
      - listitem [ref=e24]:
        - generic [ref=e25]:
          - checkbox "Add your own todo with the form above" [ref=e26]
          - text: Add your own todo with the form above
        - button "delete" [ref=e27]
      - listitem [ref=e28]:
        - generic [ref=e29]:
          - checkbox "Edit or delete any todo to try the app" [ref=e30]
          - text: Edit or delete any todo to try the app
        - button "delete" [ref=e31]
      - listitem [ref=e32]:
        - generic [ref=e33]:
          - checkbox "Welcome! Tick me to mark this as done" [ref=e34]
          - text: Welcome! Tick me to mark this as done
        - button "delete" [ref=e35]
  - button "Open Next.js Dev Tools" [ref=e41] [cursor=pointer]
  - alert [ref=e45]
```