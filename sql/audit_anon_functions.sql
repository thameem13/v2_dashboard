/* STANDALONE function audit — run this file ON ITS OWN.
 *
 * Why it is its own file: hotfix_revoke_anon_grants.sql ends with three
 * SELECTs, and the Supabase SQL editor shows only the LAST result set. The
 * function audit ran every time, but the table audit below it overwrote the
 * output, so the one query that mattered was never actually seen. Nothing
 * follows this statement, so what you get back is this result.
 *
 * WHAT IT ANSWERS
 *   Is there another function shaped like the bug already fixed - running as
 *   its owner (SECURITY DEFINER, so RLS never applies) while anon is allowed
 *   to call it? Probing from outside could only ever test the twenty RPC
 *   names listed in worker.js. A function that is not in that list is
 *   invisible from outside and would not have shown up in any check so far.
 *
 * HOW TO READ IT
 *   ZERO ROWS          -> nothing to do. No SECURITY DEFINER function is
 *                         reachable by anon, authenticated or PUBLIC.
 *
 * ⚠ FIXED 2026-11-12 - THIS QUERY COULD NOT SEE PUBLIC GRANTS.
 *   It tested coalesce(a.grantee::regrole::text, 'PUBLIC'). For a PUBLIC
 *   grant aclexplode sets grantee = 0, and 0::regrole::text is '-', NOT
 *   NULL - so the coalesce never fired, '-' never matched the IN list, and a
 *   PUBLIC grant was reported as nothing at all.
 *
 *   That is not hypothetical. Every function Postgres creates gets a default
 *   EXECUTE grant to PUBLIC, written '=X/owner'. On 2026-11-12 twelve
 *   functions in this schema still carried it, anon could execute all of
 *   them through it, and this audit had been returning zero rows throughout.
 *   See sql/hotfix_revoke_anon_mutating_fns.sql.
 *
 *   The test is now `a.grantee = 0`. Do not "simplify" it back.
 *
 *   The good news from the same re-run: no SECURITY DEFINER function carried
 *   a PUBLIC grant, so the specific bug this file hunts was genuinely absent -
 *   it was the non-definer functions that were open.
 *   ANY ROW            -> each one is a potential open door. Same fix as
 *                         before:
 *                           revoke execute on function public.<name>(<args>)
 *                             from anon, authenticated, public;
 *                         Use the args column verbatim - overloads differ
 *                         only by signature, and revoking the wrong one
 *                         silently leaves the real one open.
 *
 *   risk is ordered worst-first. Functions that are NOT security definer are
 *   deliberately excluded: they run as the caller, so RLS still applies and
 *   an anon grant on one is not the same bug.
 */
select
  p.proname                                    as function_name,
  case when a.grantee = 0 then 'PUBLIC'
       else a.grantee::regrole::text end       as granted_to,
  pg_get_function_identity_arguments(p.oid)    as args,
  pg_get_userbyid(p.proowner)                  as runs_as,
  'revoke execute on function public.' || p.proname
    || '(' || pg_get_function_identity_arguments(p.oid) || ')'
    || ' from anon, authenticated, public;'    as fix
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     on a.privilege_type = 'EXECUTE'
where n.nspname = 'public'
  and p.prosecdef                                     -- SECURITY DEFINER only
  and (a.grantee = 0                                  -- 0 = PUBLIC; see above
       or a.grantee::regrole::text in ('anon', 'authenticated'))
order by p.proname;
