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
  coalesce(a.grantee::regrole::text, 'PUBLIC') as granted_to,
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
  and coalesce(a.grantee::regrole::text, 'PUBLIC')
      in ('anon', 'authenticated', 'PUBLIC')
order by p.proname;
