# Embed quota view for T3 (uncommitted checklist)

- [x] 1. `how` over the affected subsystem. Done inline: App.tsx router (hash), ProtectedRoute, MainLayout chrome, QuotaPage (header/tabs/toolbar/grid/pagination/timeline), quota store is in-memory only, themes.scss variables; T3 color tokens via --color-*.
- [x] 2. `architect` for parallel design exploration. skip: one small route plus a message contract; the shape is pinned in the contract below, no competing designs worth a panel.
- [x] 3. Write the throughput checkpoint as four todo items.
  - [x] Blocking first steps. Contract fixed before fan-out (below). Worktree ~/personal/cpamc-embed-quota on feat/embed-quota. /tmp/t3cpc/serve.cjs verified (page 200, API 401 without key, 200 with key).
  - [x] Independent workstreams. A: CPAMC embed route + theme receiver (cpamc worktree). B: T3 extension frame URL + theme sender (t3-extensions main checkout, examples/cliproxy-console). Disjoint repos.
  - [x] Shared mutable state. None shared between A and B except the message contract, which is fixed here. Live dist/index.html in the main CPAMC checkout is off limits (it is what the server serves).
  - [x] Smallest safe decomposition. Two workers, one per repo; the parent runs the end-to-end check in a cloned T3.
- [x] 4. Delegate code-writing to a subagent using your configured feature model. Two opus workers (CPAMC worktree, extension). Diffs reviewed by parent.
- [x] 5. Verify on the matching surface. Cloned T3 + /tmp/t3cpc/serve.cjs over the real API: tab opens #/embed/quota, all 15 colors received and applied, live switch to iris (light) followed, refresh reloads and re-themes. bun run verify 1559/0, npm test 38/0. Claude cards hit upstream 429 (open question).
- [x] 6. Rebase into small, ordered commits. Stack follow-ups. 533499d theme store, 19f9c66 embed route; fast-forwarded into main and built (live == dist).
- [x] 7. If the design is contested, `interrogate` before shipping. skip: not contested.
- [x] 8. Run **Opening a PR**. skip: user asked to merge straight into the fork's main; not pushed.

## Contract

Frame URL: `${source.url}/management.html#/embed/quota`

frame -> parent: `{ source: "cpamc-embed", type: "ready" }` via `window.parent.postMessage(msg, "*")` on mount (no secrets in it).

parent -> frame: `{ source: "t3", type: "theme", mode: "dark" | "light", colors: { background, foreground, card, popover, muted, mutedForeground, accent, border, input, primary, primaryForeground, success, warning, destructive, info }, fontFamily }`
sent with targetOrigin = the console's origin, on every "ready" and whenever T3's theme changes. Colors are resolved CSS color strings.

Refresh: T3's refresh button reloads the frame; the embed view loads every visible quota on mount.
