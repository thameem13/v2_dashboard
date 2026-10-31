/* INSPECTION — run this ON ITS OWN, then paste the result back.
 *
 * Read-only. Nothing here changes anything.
 *
 * WHY THIS COMES FIRST
 *   The fix for the QQQ 2026-10-22 11:55 duplicate is a dedupe plus a unique
 *   constraint, and a dedupe DELETES rows. Writing one against guessed column
 *   names would be reckless, and two things are already known to be unlike the
 *   obvious assumption:
 *
 *     1. bucket_v2_all is a VIEW, not a table - probing it returned
 *        "permission denied for view bucket_v2_all". A unique constraint
 *        cannot go on a view; it has to go on whatever tables sit under it.
 *     2. The per-symbol tables (spy_bucket_log_v2, qqq_bucket_log_v2, ...)
 *        may not even carry a symbol column - if the symbol is implied by
 *        which table a row is in, then the right key is (candle_time_ny)
 *        alone, and a constraint on (symbol, candle_time_ny) would silently
 *        fail to prevent anything.
 *
 *   One query, so the Supabase editor actually shows the result - it displays
 *   only the final result set, which is how the function audit went unseen
 *   four times.
 *
 * WHAT COMES BACK
 *   VIEWDEF  - what bucket_v2_all actually selects, and from which tables
 *   COLUMNS  - every column of each bucket table, in order, with its type
 *   INDEXES  - existing indexes and unique constraints (an existing unique
 *              index would mean the duplicate arrived another way)
 *   ROWCOUNT - live row count per table
 */
with tbls as (
  select c.oid, c.relname::text as t
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and c.relname like '%bucket%'
),
vw as (
  select 0 as ord, 'VIEWDEF bucket_v2_all' as section,
         coalesce(
           pg_get_viewdef(to_regclass('public.bucket_v2_all'), true),
           '(bucket_v2_all is not a view, or does not exist)'
         ) as detail
),
cols as (
  select 1 as ord, 'COLUMNS ' || c.table_name as section,
         string_agg(c.column_name || ':' || c.data_type, ', '
                    order by c.ordinal_position) as detail
  from information_schema.columns c
  join tbls on tbls.t = c.table_name
  where c.table_schema = 'public'
  group by c.table_name
),
idx as (
  select 2 as ord, 'INDEXES ' || i.tablename as section,
         string_agg(i.indexdef, '  |  ') as detail
  from pg_indexes i
  join tbls on tbls.t = i.tablename
  where i.schemaname = 'public'
  group by i.tablename
),
cnt as (
  select 3 as ord, 'ROWCOUNT ' || t as section,
         coalesce((xpath('/row/c/text()',
           query_to_xml('select count(*) as c from public.' || quote_ident(t),
                        false, true, '')))[1]::text, '?') as detail
  from tbls
)
select section, detail from (
  select * from vw
  union all select * from cols
  union all select * from idx
  union all select * from cnt
) r
order by ord, section;
