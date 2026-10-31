/* FOLLOW-UP to hotfix_revoke_anon_grants.sql — the five views the audit found.
 *
 * The table audit returned five views with rowsecurity = false, granted to
 * anon and authenticated:
 *
 *   qqq_session_view        spy_session_view        spy_side_signals_view
 *   spy_strike_chain_incremental_vwdim              spy_trade_grades_summary
 *
 * WHY THIS IS NOT ALREADY SAFE
 *   A view has no RLS of its own - rowsecurity is false on every view, so that
 *   column says nothing either way. What decides it is who the view runs AS.
 *   By default a view executes with its OWNER's rights, and the owner is
 *   normally RLS-exempt, so a view can hand anon exactly the rows the base
 *   table's RLS was written to withhold. That is the same shape as the bug we
 *   just closed: a privileged object reachable by anon.
 *
 *   Probed on 2026-10-31 with the leaked publishable key, all five answered
 *   HTTP 200 with a zero-row Content-Range: granted, reachable, no rows. That
 *   is consistent with these being security_invoker views (so anon's own RLS
 *   applies and filters everything out), but it is ALSO what an empty view
 *   looks like. From outside the database the two are indistinguishable, so
 *   this is not something to conclude from a 200 and an empty array.
 *
 * STEP 1 tells you which it is. STEP 2 makes it not matter.
 */

/* ─── STEP 1: which mode are these views in? ───────────────────────────────
   security_invoker = true  -> anon's RLS applied; the empty result was real
                               protection, and step 2 is defence in depth.
   security_invoker = false -> the view runs as its owner and RLS was NEVER
                               applied. They were empty for some other reason,
                               and step 2 is urgent, not optional. */
select
  c.relname,
  coalesce(
    (select option_value
       from pg_options_to_table(c.reloptions)
      where option_name = 'security_invoker'),
    'false'
  ) as security_invoker,
  pg_get_userbyid(c.relowner) as view_owner
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'v'
  and c.relname in ('qqq_session_view','spy_session_view','spy_side_signals_view',
                    'spy_strike_chain_incremental_vwdim','spy_trade_grades_summary')
order by security_invoker, c.relname;


/* ─── STEP 2: take the grants away ────────────────────────────────────────
   Safe for the dashboard: worker.js authenticates as service_role, and the
   browser has held no Supabase key since the proxy was introduced - it only
   ever calls /api/rpc/<fn> same-origin. Nothing in this repo reads these
   views as anon.

   BEFORE RUNNING: confirm nothing OUTSIDE this repo uses the anon key against
   these views - a Make.com scenario, a notebook, a second app. Those would
   break, and they would break silently with an empty result rather than an
   error, which is the worst way to find out. */
begin;

revoke select on public.qqq_session_view                   from anon, authenticated;
revoke select on public.spy_session_view                   from anon, authenticated;
revoke select on public.spy_side_signals_view              from anon, authenticated;
revoke select on public.spy_strike_chain_incremental_vwdim from anon, authenticated;
revoke select on public.spy_trade_grades_summary           from anon, authenticated;

commit;


/* ─── VERIFY: expect ZERO rows ────────────────────────────────────────────
   Re-run the table audit from hotfix_revoke_anon_grants.sql and confirm no
   view with rls_enabled = false is left granted to anon or authenticated. */
select
  c.relname,
  c.relrowsecurity as rls_enabled,
  coalesce(a.grantee::regrole::text, 'PUBLIC') as grantee
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
     on a.privilege_type = 'SELECT'
where n.nspname = 'public'
  and c.relkind = 'v'
  and c.relrowsecurity = false
  and coalesce(a.grantee::regrole::text, 'PUBLIC') in ('anon', 'authenticated', 'PUBLIC')
order by c.relname;
