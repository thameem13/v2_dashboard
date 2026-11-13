# Security notes

Internal. Listed in `.assetsignore` so it is not served from the site, though
it is in a public repo — so it names no credential values, only which ones are
dead and must stay that way.

## The one rule that is easy to break by accident

**Never re-enable the legacy API keys on the Supabase project.**

They were disabled on **2026-10-31**, and two Supabase keys are permanently
readable in this repo's public git history:

| Credential | Where | State |
|---|---|---|
| Legacy anon JWT (`eyJhbGci…`) | commits `92cff88`, `5f24e83`, the deleted `index_old_main.html` | **disabled** |
| the `sb_publishable_…` key | commits `c468b8e`, `e6be306`, `7f8fad3` | **not an active key on the project** |

Nothing in the working tree carries a key. History rewriting is not worth it —
both credentials are dead, and rewriting a pushed public repo is its own
outage. Their being dead is the mitigation, which is exactly why re-enabling
legacy keys would retroactively hand out a working credential to anyone who has
ever cloned this repo.

Re-enabling is a single toggle in the Supabase dashboard, it is the kind of
thing done while debugging something unrelated, and nothing in the codebase
would complain. Hence this note.

If a legacy key ever has to come back on temporarily: rotate it immediately
afterwards, and treat every historical commit as exposing the new value too.

### What the disablement already broke once

Disabling the legacy keys was correct, but two things were quietly depending on
them, and neither announced itself:

1. **The option-premium pg_cron jobs**, which passed a legacy `service_role`
   JWT to the edge functions. Every tick returned 401 while
   `cron.job_run_details` reported "succeeded", because pg_net is asynchronous
   and the job succeeds at queue time. The premium feed stopped on 2026-11-02
   and nobody noticed for ten days. See `sql/hotfix_premium_cron_key.sql`.
2. **The `dashboard` edge function** (deleted 2026-11-12), which served a
   public, unauthenticated copy of the dashboard with the legacy anon key baked
   in. The dead key is the only reason it leaked a UI shell rather than live
   trading data.

The lesson both share: a credential's death is visible at the caller, not at
the scheduler. When rotating anything, grep for who was using it.

## Where secrets are allowed to live

| Secret | Home |
|---|---|
| `SUPABASE_SECRET_KEY` | Cloudflare Worker **Secrets** only |
| `TELEGRAM_BOT_TOKEN` | Cloudflare Worker **Secrets** only |
| `TELEGRAM_CHAT_ID` | Cloudflare Worker **Secrets** only |
| Edge-function key for pg_cron | Supabase **Vault**, as `edge_function_key` |
| Local dev copy | `.dev.vars`, which `.gitignore` covers — keep it there |

Plain Cloudflare **Variables do not survive deploys; Secrets do.**

**No Supabase key belongs in client code — not even a publishable one.** The
Worker proxy means the browser holds none at all, which is strictly better.
Do not reintroduce one as a shortcut.

`assets.directory` is `"."`, so **any file added to the repo root is served by
the site.** Use `.assetsignore` for anything that should not be.

## Audit commands

Run these after any grant, function or key change.

```sql
-- Functions reachable by anon / authenticated / PUBLIC. Expect zero rows.
-- a.grantee = 0 IS the PUBLIC test; see the note in audit_anon_functions.sql
-- for why coalesce(grantee::regrole::text,'PUBLIC') silently never matches.
select p.proname, p.prosecdef,
       case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     on a.privilege_type = 'EXECUTE'
where n.nspname = 'public'
  and (a.grantee = 0 or a.grantee::regrole::text in ('anon','authenticated'));
```

```sql
-- RLS off, or on with no policy, on anything the dashboard reads.
select c.relname, c.relrowsecurity,
       (select count(*) from pg_policies p
         where p.schemaname='public' and p.tablename=c.relname) as policies
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind in ('r','p')
order by c.relrowsecurity, c.relname;
```

```sql
-- Did the async HTTP calls actually work? cron.job_run_details cannot tell you.
select status_code, count(*), max(created) from net._http_response
group by status_code order by 2 desc;
```

```
# Edge functions. Anything with verify_jwt = false is callable by the whole
# internet, outside Cloudflare Access and outside the WAF rules.
npx supabase functions list --project-ref egsgycizhssexstjrsqi
```

## State as of 2026-11-12

Verified directly against the live project:

- RLS enabled on all 24 base tables in `public`.
- No policy anywhere targets `anon`; all 16 target `authenticated`.
- `auth.users` is empty, so nothing can act as `authenticated`.
- No function in `public` — of either kind — is executable by `anon`,
  `authenticated` or `PUBLIC`.
- No `SECURITY DEFINER` function carries a PUBLIC grant, so the `v2_*`
  dashboard RPCs are reachable only through the Worker proxy.
- No active publishable key; the legacy anon key is disabled.
- The two surviving edge functions are both `verify_jwt = true`.

`v2_volume_regime` is a materialized view, and **RLS cannot be enabled on a
matview** — it is protected by grants alone (it has none to `anon` or
`authenticated`). Never grant on it.
