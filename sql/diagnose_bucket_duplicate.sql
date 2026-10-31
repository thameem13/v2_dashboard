/* DIAGNOSE the QQQ 2026-10-22 11:55 duplicate — run ON ITS OWN, paste back.
 *
 * Read-only.
 *
 * WHAT THE SCHEMA ALREADY RULED OUT
 *   qqq_bucket_log_v2 carries a UNIQUE index on candle_time_ts
 *   (qqq_bucket_log_v2_candle_ts_key), so two bucket rows cannot share a
 *   candle_time_ts. The duplicate seen through v2_pin_series_by_strategy was
 *   identical in every column, which leaves two possibilities:
 *
 *     A. Two bucket rows with DIFFERENT candle_time_ts that resolve to the
 *        SAME candle_time_ny. The unique index would permit that, because it
 *        guards a different column than the one the RPC reports.
 *     B. No duplicate in the bucket table at all - a join fan-out inside the
 *        RPC. It joins the bucket view to market and flow sources; a second
 *        row for that candle in EITHER of those multiplies the output row
 *        without duplicating anything in the bucket table.
 *
 *   These need opposite fixes. A is a data repair plus a tighter index; B is
 *   a dedupe of the joined source, or a join the RPC must make one-to-one -
 *   and deleting a bucket row for B would destroy good data and leave the
 *   real duplicate in place. Hence no DELETE anywhere in this file.
 *
 * SECTION A answers which one it is. If it reports 1 row, the cause is B and
 * the bucket table is innocent.
 *
 * SECTIONS C and D cover a separate, confirmed gap: spy_bucket_log_v2 has NO
 * unique index beyond its id primary key, while qqq_bucket_log_v2 and the
 * older spy_bucket_log both have one on candle_time_ts. SPY can therefore
 * accept duplicate candles today. Those sections report whether any already
 * landed - which also decides whether a unique index can be added at all, as
 * CREATE UNIQUE INDEX fails against existing duplicates.
 */
with a as (
  select 0 as ord,
         'A. qqq_bucket_log_v2 rows at 2026-10-22 11:55' as section,
         coalesce(count(*)::text || ' row(s)  ' ||
           string_agg('[ts=' || candle_time_ts::text ||
                      ' ny=' || candle_time_ny::text ||
                      ' price=' || coalesce(underlying_price::text,'-') ||
                      ' id=' || left(id::text, 8) || ']', '  '), '0 rows') as detail
  from public.qqq_bucket_log_v2
  where candle_time_ny >= timestamp '2026-10-22 11:55'
    and candle_time_ny <  timestamp '2026-10-22 12:00'
),
b as (
  select 1, 'B. qqq_bucket_log_v2 candle_time_ny values appearing twice',
         coalesce(string_agg(ny::text || ' x' || n::text, ', ' order by ny), 'none')
  from (select candle_time_ny as ny, count(*) as n
        from public.qqq_bucket_log_v2 group by 1 having count(*) > 1) z
),
c as (
  select 2, 'C. spy_bucket_log_v2 candle_time_ts appearing twice (blocks a unique index)',
         coalesce(string_agg(ts::text || ' x' || n::text, ', ' order by ts), 'none')
  from (select candle_time_ts as ts, count(*) as n
        from public.spy_bucket_log_v2 group by 1 having count(*) > 1) z
),
d as (
  select 3, 'D. spy_bucket_log_v2 candle_time_ny appearing twice',
         coalesce(string_agg(ny::text || ' x' || n::text, ', ' order by ny), 'none')
  from (select candle_time_ny as ny, count(*) as n
        from public.spy_bucket_log_v2 group by 1 having count(*) > 1) z
),
e as (
  select 4, 'E. rows where candle_time_ny disagrees with candle_time_ts (NY conversion)',
         'spy=' || (select count(*) from public.spy_bucket_log_v2
                    where candle_time_ny is distinct from
                          (candle_time_ts at time zone 'America/New_York'))::text ||
         '  qqq=' || (select count(*) from public.qqq_bucket_log_v2
                      where candle_time_ny is distinct from
                            (candle_time_ts at time zone 'America/New_York'))::text
)
select section, detail from (
  select * from a union all select * from b union all select * from c
  union all select * from d union all select * from e
) r order by ord;
