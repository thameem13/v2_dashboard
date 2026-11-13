# Security rules, and what was actually verified

**The GitHub repo `thameem13/v2_dashboard` is public. The site is not** —
Cloudflare Access gates `dashflow.trade` entirely. So the threat model is
mostly "what leaks through the repo", not "what a visitor can reach".

`SECURITY.md` in the repo root is the operational companion to this file: the
standing rules, the audit queries, and the one-line reason legacy keys must
never be re-enabled.

## Rules

1. **Never commit a secret.** `SUPABASE_SECRET_KEY`, `TELEGRAM_BOT_TOKEN` and
   `TELEGRAM_CHAT_ID` live in Cloudflare Secrets only. The key pg_cron uses
   lives in Supabase Vault as `edge_function_key`.
2. **No Supabase key belongs in client code — not even a publishable one.**
   The Worker proxy means the browser holds none at all. Do not reintroduce
   one as a shortcut: a credential shipped to a browser can never be secret.
3. **Never re-enable the legacy Supabase API keys.** They are disabled, and
   both are readable in this repo's public git history. See `SECURITY.md`.
4. **Adding a file to the repo root publishes it** on the site
   (`assets.directory: "."`). Use `.assetsignore` for anything that should not
   be served.
5. **Keep `read_only=true`** on the Supabase MCP server in `.mcp.json`.
6. **Any new RPC must be added to `ALLOWED` in `worker.js`** — and nothing
   should be added there that the dashboard does not need, because the proxy's
   key bypasses RLS.
7. **`verify_jwt = false` on an edge function means the whole internet can
   call it**, outside Access and outside the WAF rules. Never ship one.

## RLS and grants, as verified

Checked directly against the live database on 2026-11-12:

- **RLS enabled on all 24 base tables** in `public`.
- **No policy anywhere targets `anon`.** All 16 target `authenticated`. With
  RLS on and no `anon` policy, `anon` reads nothing through PostgREST
  regardless of table grants.
- **`auth.users` is empty**, so nothing can currently act as `authenticated`.
- **No function in `public`, of either kind, is executable by `anon`,
  `authenticated` or `PUBLIC`.** True only after the fix below — it was not
  true when first audited.
- **No `SECURITY DEFINER` function carries a `PUBLIC` grant**, so the `v2_*`
  dashboard RPCs really are reachable only through the Worker proxy.
- **The legacy anon key is disabled** (verified live: 401 "Legacy API keys are
  disabled") and there is **no active publishable key**.
- Both surviving edge functions are `verify_jwt = true`.

### The audit query had a blind spot — do not reintroduce it

`aclexplode` reports a PUBLIC grant as `grantee = 0`, and
`0::regrole::text` is `'-'`, **not NULL**. So the idiom

```sql
coalesce(a.grantee::regrole::text, 'PUBLIC') in ('anon','authenticated','PUBLIC')
```

can never match a PUBLIC grant: the coalesce never fires and `'-'` is not in
the list. `sql/audit_anon_functions.sql` used exactly that and had been
returning a clean "zero rows" on a database where PUBLIC could execute twelve
functions. Always test `a.grantee = 0`.

Caveat: **RLS cannot be enabled on a materialized view**, so
`v2_volume_regime` is protected by grants alone (it has none to `anon` or
`authenticated`). Never grant on it.

## Findings — all six addressed

### 1. Public unauthenticated dashboard outside Access — FIXED

Supabase edge function `dashboard` was `ACTIVE` with `verify_jwt: false`,
serving a complete older copy of the dashboard — with the legacy anon key baked
into its source — to anyone, at
`https://<project>.supabase.co/functions/v1/dashboard`. Verified returning
HTTP 200. It bypassed Cloudflare Access, the WAF country rule and Bot Fight
Mode. Only the dead embedded key kept it from leaking live data.

**Deleted** 2026-11-12 (`supabase functions delete dashboard`); the URL now
returns 404 and both premium functions were confirmed unaffected. The served
HTML was backed up before deletion.

### 2. `.dev.vars` not gitignored — FIXED

`.gitignore` covered `.wrangler/`, `node_modules/` and `supabase/.temp/` but
not `.dev.vars` — the file `RELEASE.md` instructs you to create with the
RLS-bypassing secret key in it. One `git add -A` would have published it.

`.dev.vars`, `.dev.vars.*`, `.env` and `.env.*` added and confirmed with
`git check-ignore`. `RELEASE.md`'s warning, which claimed the repo had no
`.gitignore` at all and so read as already-handled, was corrected.

### 3. Supabase keys in public git history — MITIGATED, guarded

The legacy anon JWT and the publishable key are permanently readable in
historical commits. The working tree is clean.

Both credentials are dead, which is the mitigation; history rewriting on a
pushed public repo is its own outage and buys nothing. The live risk is a
**single dashboard toggle** re-enabling legacy keys and retroactively arming a
credential that every cloner already has. That rule, the affected commits and
the two things the disablement already broke are now written down in
`SECURITY.md`.

### 4. `anon` could execute 12 trading-logic functions — FIXED

Twelve non-`SECURITY DEFINER` functions were executable by `anon`, including
`derive_laws_and_trap`, `derive_laws_and_trap_qqq`, `apply_law6_*`, the three
`trigger_grade_*` functions, `calculate_contract_selection` and
`check_latest_bucket_signal`. Eight mutate trading tables. RLS was the only
layer between `anon` and the trading logic.

The grant that mattered was **PUBLIC**, not `anon` — see the blind spot above.
A first pass revoking only `anon, authenticated` changed nothing measurable;
`has_function_privilege('anon', …)` stayed true until PUBLIC was revoked.

Now all twelve read `{postgres=X/postgres, service_role=X/postgres}`, with
`anon`/`authenticated` false and `postgres`/`service_role` true. Applied as
`sql/hotfix_revoke_anon_mutating_fns.sql`; `sql/audit_anon_functions.sql` was
fixed so it can see PUBLIC.

**Why this was safe for ingestion**, both checked rather than assumed:
a trigger does **not** need EXECUTE on its own trigger function at fire time
(proved on a temp table: the trigger fired while the inserting role had no
EXECUTE), and a nested call inside such a function **does** check EXECUTE — so
the writing roles had to keep their grants. Both `postgres` and `service_role`
retain explicit grants, and those are what the Make.com scenarios write as.

### 5. Repo SQL ahead of the database — FIXED

`sql/volume_regime_signals.sql` was committed but never applied, so
`v2_vol_regime_perf_by_strategy` still read `v2_signal_enriched` →
`v2_signal_log`, whose external writer died 2026-11-06. The Volume Regime tab
was scoring 250 signals where the rule had fired 277, and could not show QQQ
at all.

Applied 2026-11-12. The `DROP FUNCTION` in the source file was omitted as
unnecessary — the deployed `v2_vol_regime_flow_by_strategy` already had the
identical return signature, so `CREATE OR REPLACE` sufficed and nothing was
dropped.

Reproduces the file's own documented validation exactly: **SPY 277, QQQ 153**,
current to 2026-11-12 against the log's 2026-11-06. All three browser-facing
RPCs return real numbers for both symbols, and the totals cross-check
(flow sums 277/153; `signals_lost` 42/39 matches the `DATA_BAD` counts).

QQQ now has signal performance for the first time. Note SPY's HIGH regime comes
out at +0.51 bp / 50% win — consistent with the honest finding in
`VOLUME_REGIME.md` that the high-volume edge does not survive a clean baseline.

### 6. Option-premium feed dead since 2026-11-02 — DIAGNOSED, one step left

Root cause confirmed: both pg_cron jobs pass a **legacy `service_role` JWT**,
disabled 2026-10-31, so the `verify_jwt = true` edge functions reject every
invocation. `net._http_response` is **360 responses, 100% HTTP 401**, "Legacy
API keys are disabled". Both SPY and QQQ premium tables are stuck at
2026-11-02, so the Performance tab's backtest has been running on a ten-day-old
feed with nothing on screen saying so.

It looked healthy because `cron.job_run_details` says "succeeded / 1 row" every
tick — **pg_net is asynchronous, so the job succeeds at queue time** and the
HTTP outcome is recorded in a table nothing was reading. Worth remembering
generally: a green scheduler says nothing about the call.

`sql/hotfix_premium_cron_key.sql` is ready and **not applied**. It moves the
key into Supabase Vault (so no credential sits in `cron.job.command`, where the
dead token had been readable in plaintext), repoints both jobs at it, and adds
a guard so they stay silent rather than firing 360 doomed requests a day while
the secret is absent. Its step-4 verify query was run read-only and is known to
parse; it currently prints the "before" state.

**Needs you**: the current `sb_secret_…` key, which only you can read (Supabase
dashboard → API Keys; same value as the Worker's `SUPABASE_SECRET_KEY`). It is
deliberately not in any file. Applying the repoint before the key is stored is
harmless — the guard keeps the jobs quiet, which is what they already are.

## Flagging a violation

If you find a secret in a diff, in the working tree, or about to be committed:
**stop, say so plainly, and do not commit.** If something is already pushed,
rotating the credential comes first — history rewriting on a pushed public repo
is secondary and often not worth it, as finding 3 shows.
