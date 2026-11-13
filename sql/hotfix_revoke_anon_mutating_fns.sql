/* HOTFIX — revoke anon/authenticated EXECUTE on the non-SECURITY-DEFINER
 * trading-logic functions.
 *
 * Applied 2026-11-12.
 *
 * ── Why these were missed ──────────────────────────────────────────────────
 * sql/audit_anon_functions.sql deliberately looks only at SECURITY DEFINER
 * functions, on the correct reasoning that those run as their owner so RLS
 * never applies to them. These twelve run as the CALLER, so RLS does still
 * apply and an anon grant on one is not the same bug.
 *
 * But that exclusion means this class was never looked at, and it is not
 * nothing: eight of the twelve mutate trading tables, three of them are the
 * grading trigger functions, and two (derive_laws_and_trap,
 * derive_laws_and_trap_qqq) are the whole law/trap derivation. "RLS would
 * block the writes" is one layer, and it is the only layer standing between
 * anon and the trading logic.
 *
 * Not exploitable when this was written — the legacy anon key is disabled,
 * there is no active publishable key, and auth.users is empty — which is
 * exactly why it is the right time to close it rather than after a key is
 * issued again.
 *
 * ── Why this is safe for ingestion ─────────────────────────────────────────
 * Two facts, both verified before applying rather than assumed:
 *
 *   1. A TRIGGER does not need EXECUTE on its own trigger function at fire
 *      time. Postgres checks that privilege at CREATE TRIGGER, not per row.
 *      Verified empirically: a temp table whose trigger function had EXECUTE
 *      revoked from the inserting role still fired and still stamped the row.
 *      So revoking here cannot stop trg_derive_laws_and_trap and friends.
 *
 *   2. A NESTED call inside one of these functions DOES check EXECUTE for the
 *      current role — so the role that actually writes has to keep its grant.
 *      Every one of the twelve carries explicit grants to BOTH postgres and
 *      service_role, and those are the roles the Make.com scenarios write as
 *      ("TV to Supabase" and "QQQ OVP Bucket V2" go through the management
 *      API as postgres; the createARow scenarios go through PostgREST with a
 *      new-format secret key, i.e. service_role). Neither is touched below.
 *
 * ── PUBLIC is the grant that actually mattered ─────────────────────────────
 * The first pass of this fix revoked from anon and authenticated only, on the
 * strength of an audit that reported those two as the grantees. It changed
 * nothing: has_function_privilege('anon', ...) still returned true afterwards.
 *
 * The real ACL was {=X/postgres, postgres=X/postgres, service_role=X/postgres},
 * and the leading `=X` with an EMPTY grantee is PUBLIC - the default EXECUTE
 * grant Postgres puts on every new function. anon never needed its own grant;
 * it had PUBLIC's. Revoking from anon and authenticated removed entries that
 * were doing nothing.
 *
 * The audit missed it because of a reporting bug, not a reasoning error - see
 * the note added to sql/audit_anon_functions.sql. Worth stating plainly: an
 * audit that cannot see PUBLIC grants returns "zero rows" on a database where
 * PUBLIC can execute everything.
 *
 * So the revoke below names PUBLIC as well, and that is the line that does the
 * work. Checked after applying: all twelve now read
 * {postgres=X/postgres, service_role=X/postgres}, with
 * has_function_privilege false for anon and authenticated and true for
 * postgres and service_role.
 *
 * Checked at the same time, because the same blind spot would have hidden it:
 * NO SECURITY DEFINER function in public carries a PUBLIC grant. The v2_*
 * dashboard RPCs really are reachable only through the Worker proxy. That was
 * the thing worth being sure about.
 *
 * bs_price and norm_cdf are pure maths and harmless on their own. They are
 * included anyway because they are reachable building blocks and nothing
 * legitimate calls them as anon — leaving two exceptions behind is how a
 * cleanup becomes a thing you have to remember.
 *
 * ── Rollback ───────────────────────────────────────────────────────────────
 * If something turns out to have called one of these as anon or authenticated,
 * the undo is the same statement with GRANT, e.g.
 *     grant execute on function public.derive_laws_and_trap() to service_role;
 * Prefer granting to the specific role that needed it over restoring anon.
 */

revoke execute on function public.apply_law6_qqq()                    from anon, authenticated, public;
revoke execute on function public.apply_law6_time_filter()            from anon, authenticated, public;
revoke execute on function public.derive_laws_and_trap()              from anon, authenticated, public;
revoke execute on function public.derive_laws_and_trap_qqq()          from anon, authenticated, public;
revoke execute on function public.trigger_grade_institutional_cover() from anon, authenticated, public;
revoke execute on function public.trigger_grade_regime_flip()         from anon, authenticated, public;
revoke execute on function public.trigger_grade_retail_capitulation() from anon, authenticated, public;

revoke execute on function public.check_latest_bucket_signal(p_date date, p_time time without time zone, p_polarity text)
  from anon, authenticated, public;

revoke execute on function public.calculate_side_signal_grade(p_trade_date date, p_candle_time_ny text, p_direction text, p_room_to_target numeric, p_signal_magnitude numeric, p_vw_dim numeric, p_volume numeric, p_avg_volume numeric)
  from anon, authenticated, public;

revoke execute on function public.calculate_contract_selection(v_trap_type text, v_price numeric, v_poc numeric, v_val numeric, v_vah numeric, v_call_wall numeric, v_put_wall numeric, v_candle_ts timestamp with time zone)
  from anon, authenticated, public;

revoke execute on function public.bs_price(cp text, s double precision, k double precision, sigma double precision, t_years double precision)
  from anon, authenticated, public;

revoke execute on function public.norm_cdf(x double precision)
  from anon, authenticated, public;


/* VERIFY. Expect zero rows: nothing in public is executable by anon,
   authenticated or PUBLIC. a.grantee = 0 is the PUBLIC test - do NOT go back
   to coalesce(grantee::regrole::text,'PUBLIC'), which is the bug that hid
   this finding in the first place. Keep this as the last statement: the
   Supabase SQL editor shows only the final result set. */
select
  p.proname                                 as still_reachable,
  p.prosecdef                               as security_definer,
  case when a.grantee = 0 then 'PUBLIC'
       else a.grantee::regrole::text end    as granted_to,
  pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     on a.privilege_type = 'EXECUTE'
where n.nspname = 'public'
  and (a.grantee = 0 OR a.grantee::regrole::text in ('anon', 'authenticated'))
order by p.prosecdef desc, p.proname;
