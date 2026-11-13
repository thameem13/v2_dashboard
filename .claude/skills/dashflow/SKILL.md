---
name: dashflow
description: Project knowledge for the dashflow.trade monitoring dashboard (repo v2_dashboard) - the v2 bucket log trading model, its signal-monitoring UI, and its Supabase data layer. Use for any work in this repo: adding or changing a tab, card, chart or table; touching the CSS tokens or design system; the /api/rpc Worker proxy; the v2_* RPCs, bucket tables or volume-regime views; Telegram alerting; deploys and rollbacks; or questions about how a signal is scored, graded or logged.
---

# dashflow.trade

A read-only monitoring dashboard for the **v2 bucket log** model: an
options-flow divergence strategy on SPY and QQQ 0DTE options. Its job is to
show signals as they fire, explain how the model reached each verdict, and let
patterns be spotted across sessions. It places no orders and writes nothing.

Start here, then open only the reference you need.

## Two corrections to common assumptions

Both of these are wrong often enough to state up front:

1. **It does not deploy to GitHub Pages.** It is a Cloudflare Worker
   (`worker.js` + `wrangler.jsonc`) that serves the repo root as static assets
   and proxies `/api/rpc/*`. Pushing `main` deploys. See
   [references/deployment.md](references/deployment.md).
2. **The site is not public.** Cloudflare Access gates the whole hostname. The
   **repo** is public, which is the thing to protect. See
   [references/security.md](references/security.md).

## Layout

```
index.html         one page, 5 tabs, all markup; holds THE version number
css/*.css          8 files, load order load-bearing (tokens.css first)
js/*.js            15 classic scripts, one shared global scope, load order load-bearing
worker.js          Cloudflare Worker: RPC proxy + Telegram alert cron
wrangler.jsonc     deploy config; Cloudflare reads this on every push
sql/*.sql          database source, run by hand via the Supabase SQL editor
*.md               internal notes (RELEASE.md, VOLUME_REGIME.md, FEASIBILITY_REVIEW.md)
```

`js/` is **not** ES modules. Top-level `function` and `let` share one global
scope and `index.html` uses inline `onclick` handlers that depend on it. Do not
add `import`/`export` or `type="module"` to these files.

## Data flow

```
TradingView alert
  -> Make.com webhook scenario (outside this repo)
  -> Supabase: spy_bucket_log_v2 / qqq_bucket_log_v2
  -> bucket_v2_all (view, unions both + adds symbol)
  -> v2_*_by_strategy RPCs (SECURITY DEFINER, resolve strategy -> symbol in SQL)
  -> Cloudflare Worker /api/rpc/<fn> (holds the secret key, allowlists fn names)
  -> browser (js/rpc.js), 10s poll on today, no poll on historical ranges
```

The browser never holds a Supabase key and never learns which table a strategy
reads. Every RPC takes `p_strategy`. Details, field lists and types:
[references/data-layer.md](references/data-layer.md).

## References

| File | What is in it |
|---|---|
| [references/bucket-model.md](references/bucket-model.md) | The six buckets, `divergence_flow`, the 5-part score, grades A-D, the six `has_signal` gates, the volume-regime definitions |
| [references/data-layer.md](references/data-layer.md) | Every table and RPC the dashboard reads, with columns and types; the proxy; paging; refresh and polling |
| [references/frontend.md](references/frontend.md) | File layout, how to add a tab / card / chart, the token system, type scale, theming, the render-guard pattern |
| [references/frontend-craft.md](references/frontend-craft.md) | The quality bar: accessibility, performance on the 10s poll path, XSS discipline, state rules, a review checklist, and the known gaps that are debt rather than precedent |
| [references/deployment.md](references/deployment.md) | Cloudflare Workers Builds, the custom domain, Access, local preview, the version bump, rollback |
| [references/security.md](references/security.md) | What may and may not be committed, the RLS audit as actually verified, and the open findings |
| [references/new-strategies.md](references/new-strategies.md) | Adding a strategy or a whole new model as a modular addition |

## Guardrails

The dashboard is **read-only monitoring**. In this repo:

- **Never** modify trading logic, signal generation, the Postgres triggers, or
  anything that could place an order. The grading rule lives in SQL
  (`v2_dashboard_by_strategy`); changing it changes what counts as a signal
  historically, not just on screen.
- **Never** write to production tables and **never** change schema without
  asking first. The MCP Supabase server in `.mcp.json` is pinned
  `read_only=true`; keep it that way.
- `sql/*.sql` files are **source, not migrations**. They are applied by hand,
  and nothing records which files have been applied. Writing one is not
  applying it — say which you did, and verify against the live database rather
  than assuming it matches the repo. This has already bitten once: a committed
  fix sat unapplied while the tab it fixed quietly scored a stale signal set
  (see finding 5 in [references/security.md](references/security.md)).
  `sql/hotfix_premium_cron_key.sql` is the one file currently awaiting
  application, and it needs a credential from the user.
- Secrets live in Cloudflare Secrets only. The only credential that may ever
  appear in client code is a Supabase **publishable** key, and today not even
  that does - the Worker proxy means the browser holds none. Do not reintroduce
  one.
- Avoid pushing `main` between 09:30 and 16:00 ET on weekdays. A bad deploy
  costs a trading day.

## Before finishing any dashboard change

1. **It runs**: `npx wrangler dev` (not a plain static server - `/api/rpc`
   only exists inside the Worker, so tables sit empty without it).
2. **No console errors**, and the build line printed on load is the version you
   expect.
3. **No secrets in the diff**: `git diff --stat` then read it. Watch for
   `.dev.vars`, keys, tokens, and `.wrangler/`.
4. **Version bumped if any asset changed**: `<meta name="build">` plus every
   `?v=` in `index.html` (8 CSS + 12 JS), one find-and-replace.
5. **Charts and colours come from tokens** (`var(--green)`, `var(--dim)`,
   never a literal hex), and the result was checked in **both** themes.
6. **Empty, loading and failed states** all render something honest - an empty
   chart must not read as "no signal today".
7. **Every `${}` touching RPC data is wrapped in `escapeHtml()`**, and nothing
   new was added to the 10s poll path. The fuller bar, including
   accessibility, is in [references/frontend-craft.md](references/frontend-craft.md).

## Open questions

Marked `TO CONFIRM` throughout the references. They are things the code does
not state and that were not safely verifiable read-only - mostly the meaning of
fields produced by the Make.com ingestion, which lives outside this repo.
