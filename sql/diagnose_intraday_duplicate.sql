/* LOCATE the fan-out source — run ON ITS OWN, paste back. Read-only.
 *
 * WHERE THIS CAME FROM
 *   qqq_bucket_log_v2 holds exactly ONE row at 2026-10-22 11:55, and no
 *   duplicate candle_time_ny anywhere. So the extra row in
 *   v2_pin_series_by_strategy is a join fan-out, not duplicated bucket data.
 *
 *   That function builds three CTEs and joins them:
 *     i    = intraday_all for the strategy's symbol      (QQQ here)
 *     mkt  = intraday_all for SPY ALWAYS (TICK and VIX1D are market-wide)
 *     flow = bucket_v2_all for the symbol
 *     ... from i left join mkt on m.ny = i.ny left join flow on f.ny = i.ny
 *
 *   flow is excluded by the bucket diagnostic. mkt is excluded by arithmetic:
 *   a duplicate SPY row at 11:55 would also duplicate i in the SPY query and
 *   fan out against itself, so SPY would have returned about 81 rows for
 *   2026-10-22 - it returned exactly 78. That leaves i: two QQQ intraday rows
 *   at that minute, times one SPY mkt row, gives the 79 observed.
 *
 *   Sections A and B test that directly. B is the one that matters: if it
 *   reports 2 rows, the cause is found.
 *
 * WHY THE WHOLE TABLE IS SWEPT TOO
 *   One known duplicate was only noticed because a session had 79 candles
 *   instead of 78. A duplicate on a day that was already short would have
 *   cancelled out in the count and gone unseen, so C and D sweep every
 *   candle rather than only the one being chased.
 *
 * E and F report the indexes. qqq_bucket_log_v2 has a unique index on
 * candle_time_ts and the intraday tables may not - which would be the reason
 * duplicates can land there and not in the buckets.
 */
with a as (
  select 0 as ord, 'A. intraday_all SPY rows at 2026-10-22 11:55 (mkt side)' as section,
         count(*)::text || ' row(s)' as detail
  from public.intraday_all l
  where l.symbol = 'SPY'
    and (l.candle_time_ts at time zone 'America/New_York')
        >= timestamp '2026-10-22 11:55'
    and (l.candle_time_ts at time zone 'America/New_York')
        <  timestamp '2026-10-22 12:00'
),
b as (
  select 1, 'B. intraday_all QQQ rows at 2026-10-22 11:55 (i side - the suspect)',
         count(*)::text || ' row(s)  ' ||
         coalesce(string_agg('[ts=' || l.candle_time_ts::text ||
                  ' price=' || coalesce(l.price::text,'-') ||
                  ' vol=' || coalesce(l.volume::text,'-') || ']', '  '), '')
  from public.intraday_all l
  where l.symbol = 'QQQ'
    and (l.candle_time_ts at time zone 'America/New_York')
        >= timestamp '2026-10-22 11:55'
    and (l.candle_time_ts at time zone 'America/New_York')
        <  timestamp '2026-10-22 12:00'
),
c as (
  select 2, 'C. ALL duplicate (symbol, candle_time_ts) in intraday_all',
         coalesce(string_agg(sym || ' ' || ts::text || ' x' || n::text,
                             ', ' order by ts), 'none')
  from (select symbol as sym, candle_time_ts as ts, count(*) as n
        from public.intraday_all group by 1,2 having count(*) > 1) z
),
d as (
  select 3, 'D. ALL duplicate (symbol, NY minute) in intraday_all',
         coalesce(string_agg(sym || ' ' || ny::text || ' x' || n::text,
                             ', ' order by ny), 'none')
  from (select symbol as sym,
               (candle_time_ts at time zone 'America/New_York') as ny,
               count(*) as n
        from public.intraday_all group by 1,2 having count(*) > 1) z
),
e as (
  select 4, 'E. intraday_all definition',
         coalesce(pg_get_viewdef(to_regclass('public.intraday_all'), true),
                  '(not a view - it is a table)')
),
f as (
  select 5, 'F. indexes on the intraday tables',
         coalesce(string_agg(i.tablename || ': ' || i.indexdef, '  |  '), 'none')
  from pg_indexes i
  where i.schemaname = 'public' and i.tablename like '%intraday%'
)
select section, detail from (
  select * from a union all select * from b union all select * from c
  union all select * from d union all select * from e union all select * from f
) r order by ord;
