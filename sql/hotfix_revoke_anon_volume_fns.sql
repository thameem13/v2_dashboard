/* HOTFIX 2026-10-31 — three more SECURITY DEFINER functions open to anon.
 *
 * RUN THIS NOW. These are live, not theoretical. Probed from outside with the
 * leaked publishable key on 2026-10-31, all three answered HTTP 200 with real
 * data:
 *
 *   v2_volume_today(p_date)          24 KB - a full session, per candle:
 *                                    price, atm_strike, calls_otm, puts_otm,
 *                                    calls_itm_atm, puts_itm_atm, totals
 *   v2_volume_range(p_start,p_end)   312 KB in one page, back to 2026-09-08,
 *                                    and it pages further with limit/offset
 *   check_volume_anomaly(p_date,p_time)  anomaly flag, price, volume vs average
 *
 * This is MORE detail than the pin series that started all this - that one
 * carried walls and a price; these carry the option volume split by side and
 * by moneyness.
 *
 * WHY NOTHING FOUND THESE EARLIER
 *   Probing from outside can only test names it knows, and the only list of
 *   names available was ALLOWED in worker.js - twenty entries, none of them
 *   these three. They were invisible to every external check run so far. The
 *   pg_proc audit is what surfaced them, which is the whole reason it exists:
 *   a door is not safe because nobody outside knew its name.
 *
 * WHY THIS DOES NOT BREAK THE DASHBOARD
 *   None of the three is in ALLOWED, so the proxy already refuses them with
 *   403. None appears anywhere in js/ or index.html - checked, zero hits. The
 *   app's volume tab uses the _enriched_ variants instead
 *   (v2_volume_enriched_today / _range / _by_strategy), which are untouched
 *   here. These three are superseded leftovers.
 *
 *   Revoking from anon/authenticated/public does not affect postgres or
 *   service_role, so anything calling them inside the database - a trigger,
 *   another function - keeps working.
 *
 * BEFORE RUNNING: as with the views, confirm no automation outside this repo
 * calls them with the anon key - a Make.com scenario is the likely candidate.
 * Such a caller would start getting 401 rather than silently empty results,
 * so a break would at least be loud.
 */

begin;

revoke execute on function public.v2_volume_today(p_date date)
  from anon, authenticated, public;

revoke execute on function public.v2_volume_range(p_start date, p_end date)
  from anon, authenticated, public;

revoke execute on function public.check_volume_anomaly(p_date date, p_time time without time zone)
  from anon, authenticated, public;

commit;

/* ─── VERIFY: expect ZERO rows ────────────────────────────────────────────
   This is the same audit as audit_anon_functions.sql. It is the only SELECT
   in this file, so the editor will actually show its result. */
select
  p.proname                                    as function_name,
  coalesce(a.grantee::regrole::text, 'PUBLIC') as granted_to,
  pg_get_function_identity_arguments(p.oid)    as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     on a.privilege_type = 'EXECUTE'
where n.nspname = 'public'
  and p.prosecdef
  and coalesce(a.grantee::regrole::text, 'PUBLIC')
      in ('anon', 'authenticated', 'PUBLIC')
order by p.proname;
