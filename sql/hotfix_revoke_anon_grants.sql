/* HOTFIX 2026-10-29 — close the anon read path into the signal series.
 *
 * Paste this into the Supabase SQL editor and run it. It needs no CLI auth,
 * and it is safe to run more than once.
 *
 * WHAT WAS WRONG
 *   v2_pin_series_by_strategy is SECURITY DEFINER - it runs as its owner, so
 *   RLS never applies - and it was granted to anon. A publishable key was
 *   committed to index_old_main.html in a public repo, so any reader of that
 *   repo could call it directly against the Supabase REST API and page the
 *   entire per-candle series for every strategy. Cloudflare Access did not
 *   help: it gates dashflow.trade, not egsgycizhssexstjrsqi.supabase.co.
 *
 * WHY THIS DOES NOT BREAK THE DASHBOARD
 *   worker.js calls Supabase with SUPABASE_SECRET_KEY (service_role). Every
 *   other RPC the dashboard uses is already service_role-only and answers anon
 *   with 42501; this just brings the pin series into line with them.
 *
 * STEP 1 of 3. Rotating the keys is step 2 and purging the file is step 3 -
 * neither is optional. Until the keys are rotated the leaked ones still work
 * on anything else they can reach, and the one in git history never expires
 * on its own (the legacy anon JWT is dated 2026-04-29 and runs to 2036-04-28).
 */

begin;

revoke execute on function public.v2_pin_series_by_strategy(date, date, text) from anon, authenticated;
revoke execute on function public.v2_pin_series_by_strategy(date, date, text) from public;
grant  execute on function public.v2_pin_series_by_strategy(date, date, text) to service_role;

commit;


/* ─── VERIFY ───────────────────────────────────────────────────────────────
   Expect exactly one row, service_role. Any anon/authenticated/PUBLIC row
   means the revoke did not take. */
select
  p.proname,
  pg_get_userbyid(p.proowner)                as owner,
  p.prosecdef                                as security_definer,
  coalesce(a.grantee::regrole::text, 'PUBLIC') as grantee
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
left join aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       on a.privilege_type = 'EXECUTE'
where n.nspname = 'public'
  and p.proname = 'v2_pin_series_by_strategy';


/* ─── AUDIT: every other way anon can read through a SECURITY DEFINER ──────
   Only one function's source lives in this repo, so the revoke above is
   scoped to the one hole that was found by probing known RPC names. This
   lists ALL public functions that anon or PUBLIC can execute, worst first -
   a SECURITY DEFINER row here is the same class of bug and should be revoked
   the same way. Expect zero rows with security_definer = true. */
select
  p.proname,
  p.prosecdef as security_definer,
  coalesce(a.grantee::regrole::text, 'PUBLIC') as grantee,
  pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     on a.privilege_type = 'EXECUTE'
where n.nspname = 'public'
  and coalesce(a.grantee::regrole::text, 'PUBLIC') in ('anon', 'authenticated', 'PUBLIC')
order by p.prosecdef desc, p.proname;


/* ─── AUDIT: tables and views anon can read directly ──────────────────────
   These were all permission-denied when probed on 2026-10-29. Expect zero
   rows; anything listed is readable with a publishable key unless RLS covers
   it, so check rowsecurity on anything that appears. */
select
  c.relname,
  c.relrowsecurity as rls_enabled,
  coalesce(a.grantee::regrole::text, 'PUBLIC') as grantee
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
     on a.privilege_type = 'SELECT'
where n.nspname = 'public'
  and c.relkind in ('r', 'v', 'm', 'p', 'f')
  and coalesce(a.grantee::regrole::text, 'PUBLIC') in ('anon', 'authenticated', 'PUBLIC')
order by c.relrowsecurity, c.relname;
