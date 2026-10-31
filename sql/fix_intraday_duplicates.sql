/* FIX the QQQ intraday duplicates, and close both missing guards.
 *
 * Run ON ITS OWN. Everything is in one transaction: if any part fails,
 * nothing is applied.
 *
 * ROOT CAUSE
 *   spy_intraday_log has a unique index on candle_time_ts
 *   (spy_intraday_log_candle_time_ts_unique). qqq_intraday_log has only its
 *   id primary key. That is the whole explanation for why all four duplicates
 *   are QQQ and none are SPY - a re-run of the QQQ feed inserts a second row
 *   where the SPY feed would be rejected.
 *
 *     QQQ 2026-06-17 10:30 NY     QQQ 2026-09-10 14:00 NY
 *     QQQ 2026-07-30 11:35 NY     QQQ 2026-10-22 11:55 NY
 *
 *   Only 2026-10-22 was ever noticed, because it pushed that session to 79
 *   candles. The other three landed on sessions that were already short, so
 *   the count still looked ordinary. The bucket tables were never at fault.
 *
 * WHY THE DELETE IS SAFE
 *   It does not delete "the second row at that timestamp". It partitions on
 *   the ENTIRE row with id and created_at removed, so a row is only ever
 *   dropped when another row is identical in every data column. If two rows
 *   share a timestamp but differ in any reading, NOTHING is deleted for that
 *   pair - and the CREATE UNIQUE INDEX below then fails, the transaction
 *   rolls back, and you are told. That is the correct outcome: it would mean
 *   two genuinely different readings for one candle, and which one is right
 *   is not a decision this script should make silently.
 *
 *   to_jsonb(t) - 'id' - 'created_at' is harmless if created_at does not
 *   exist; removing an absent key from jsonb leaves it unchanged.
 *
 * SECOND GUARD
 *   spy_bucket_log_v2 is missing the unique index that qqq_bucket_log_v2
 *   already has - the same gap, mirrored. The bucket diagnostic confirmed it
 *   currently holds no duplicate candle_time_ts and no duplicate
 *   candle_time_ny, so the index can be created without any cleanup.
 *
 * Index names follow each table's existing partner, so the pairs read the
 * same in \d output.
 */

begin;

/* 1. Collapse fully identical QQQ intraday rows, keeping the earliest id. */
with ranked as (
  select t.id,
         row_number() over (
           partition by (to_jsonb(t) - 'id' - 'created_at')
           order by t.id
         ) as rn
  from public.qqq_intraday_log t
)
delete from public.qqq_intraday_log v
using ranked r
where v.id = r.id
  and r.rn > 1;

/* 2. The guard QQQ was missing. Fails loudly if any non-identical duplicate
      survives step 1, taking the whole transaction with it. */
create unique index qqq_intraday_log_candle_time_ts_unique
  on public.qqq_intraday_log (candle_time_ts);

/* 3. The mirrored gap on the bucket side. No cleanup needed - verified clean. */
create unique index spy_bucket_log_v2_candle_ts_key
  on public.spy_bucket_log_v2 (candle_time_ts);

commit;


/* ─── VERIFY — expect "none" and four unique indexes ─────────────────────── */
select section, detail from (
  select 0 as ord, 'A. remaining duplicates in intraday_all' as section,
         coalesce(string_agg(sym || ' ' || ts::text || ' x' || n::text, ', '), 'none') as detail
  from (select symbol as sym, candle_time_ts as ts, count(*) as n
        from public.intraday_all group by 1,2 having count(*) > 1) z
  union all
  select 1, 'B. remaining duplicates in bucket_v2_all',
         coalesce(string_agg(sym || ' ' || ny::text || ' x' || n::text, ', '), 'none')
  from (select symbol as sym, candle_time_ny as ny, count(*) as n
        from public.bucket_v2_all group by 1,2 having count(*) > 1) z
  union all
  select 2, 'C. unique indexes on candle time (expect all four tables)',
         coalesce(string_agg(tablename || '.' || indexname, '  |  ' order by tablename), 'none')
  from pg_indexes
  where schemaname = 'public'
    and (tablename like '%intraday_log' or tablename like '%bucket_log_v2')
    and indexdef like '%UNIQUE%'
    and indexdef like '%candle_time_ts%'
  union all
  select 3, 'D. QQQ row counts per affected session',
         coalesce(string_agg(d::text || '=' || n::text, ', ' order by d), 'none')
  from (select (candle_time_ts at time zone 'America/New_York')::date as d,
               count(*) as n
        from public.intraday_all where symbol = 'QQQ'
          and (candle_time_ts at time zone 'America/New_York')::date
              in (date '2026-06-17', date '2026-07-30',
                  date '2026-09-10', date '2026-10-22')
        group by 1) z
) r order by ord;
