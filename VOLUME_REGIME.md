# Volume regime

How busy the option tape was when a signal fired, and whether that predicted
anything.

Read the section on the earlier finding before you use any number from this
tab. The short version: the high-volume edge that motivated this work does not
survive an honest baseline.

## Definitions

**30-minute volume** at bar `t` is the cumulative total at `t` minus the
cumulative total at `t − 30 min`, for the same symbol on the same NY date.
Both bars must exist exactly 30 minutes apart; where one is missing — there are
22 such intraday gaps — no value is produced rather than a window silently
spanning 35 or 40 minutes and reading as a surge.

**Volume** is all six buckets summed: `calls_otm + puts_otm + calls_itm +
puts_itm + calls_atm + puts_atm`. Not OTM alone.

**Baseline** for a time slot is the average 30-minute volume at that same time
of day over **prior clean sessions only**. Never the current day. In SQL that
is the frame clause

```sql
ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
```

in `baseline_calc`, and it is the single most important line in the build. A
slot with fewer than `min_baseline_days` prior clean sessions gets no baseline
and no vratio.

**vratio** is 30-minute volume divided by the baseline.

**Regime** is `vratio` against the cutoffs: `LOW` below `low_max`, `NORMAL` up
to and including `normal_max`, `HIGH` above it.

Three further values are not regimes but states, and the tab shows them
separately so the signals add up to the whole log:

| State | Meaning |
|---|---|
| `DATA_BAD` | the session failed a data-quality rule |
| `NO_BASELINE` | fewer than `min_baseline_days` prior clean sessions at this slot |
| `NO_WINDOW` | less than 30 minutes into the session, so no window exists yet |

## Cutoffs, and how to change them

Every threshold lives in one row of `v2_vol_regime_config`. Nothing is
hardcoded in the views, the RPCs, or the JavaScript — the tab displays the
cutoffs it actually used, read back from this table.

| Column | Default | Meaning |
|---|---|---|
| `low_max` | 0.80 | vratio below this is `LOW` |
| `normal_max` | 1.10 | at or below this `NORMAL`, above it `HIGH` |
| `frozen_bars_min` | 3 | consecutive zero-increment bars that flag a frozen component |
| `day_start_latest` | 09:45 | first bar later than this ⇒ `BAD_LATE_START` |
| `day_end_earliest` | 15:55 | last bar earlier than this ⇒ `BAD_SHORT_END` |
| `min_baseline_days` | 5 | fewer prior clean sessions ⇒ no vratio |
| `min_n_reliable` | 100 | below this n the tab marks a row as not reliable |

To change one:

```sql
UPDATE v2_vol_regime_config SET normal_max = 1.25;
REFRESH MATERIALIZED VIEW CONCURRENTLY v2_volume_regime;
```

No migration, no deploy. The refresh is what makes it take effect — without it
the change shows up at the next scheduled refresh instead, within five minutes.

Changing `frozen_bars_min`, `day_start_latest` or `day_end_earliest` re-labels
which sessions are clean, which changes every baseline. Expect the whole table
to move, not just the boundary rows.

## Data-quality rules

A session is **BAD** if any of these holds, and a bad session is excluded from
every baseline. Signals on it get `DATA_BAD` instead of a regime.

- **Frozen feed** — a component's incremental volume is 0 for `frozen_bars_min`
  or more consecutive bars while the bar's total is still growing.
- **Short session** — the last bar is before `day_end_earliest`.
- **Late start** — the first bar is after `day_start_latest`.

Two further rules apply at the row level rather than the session level:

- Rows with a null `candle_time_ny` are dropped. SPY carries 150 of them, with
  `candle_time_ts` also null and every increment null — orphans, not bars.
- Deduplication is by `(symbol, candle_time_ts)` keeping the largest cumulative
  total, **but tie-breaking on `candle_time_ny IS NOT NULL` first**. Ordering
  on the cumulative alone could hand the row to an orphan, whose null date then
  drops it downstream, silently losing a real bar. There are no true duplicate
  timestamps in either symbol as of 2026-11-09; the clause keeps that true if
  any return.

Dates always come from `candle_time_ny`, never `CURRENT_DATE`, which rolls to
the next day around 8 PM ET. `candle_time_ny` was verified to equal
`candle_time_ts AT TIME ZONE 'America/New_York'` for all 3,414 non-null SPY
rows.

### Sessions excluded as of 2026-11-09

Ten of 45 SPY sessions, not the three that were known. The tab lists these
live, with what each one cost in signals.

| Session | Reason | Signals lost |
|---|---|---|
| 2026-09-08 | starts 10:00 | 11 |
| 2026-09-09 | starts 10:55 | 3 |
| 2026-09-16 | `calls_itm`, `puts_otm` frozen 4 bars | 7 |
| 2026-10-06 | starts 09:50 | 6 |
| 2026-10-13 | starts 09:55 | 0 |
| 2026-10-16 | `calls_atm`, `calls_itm`, `puts_atm`, `puts_otm` frozen up to 27 bars | 1 |
| 2026-10-30 | `calls_itm`, `puts_otm` frozen 10 bars | 5 |
| 2026-11-05 | `calls_atm`, `calls_itm`, `puts_atm`, `puts_otm` frozen 75 bars | 0 |
| 2026-11-06 | ends 15:15 | 8 |
| 2026-11-09 | `calls_atm`, `calls_otm`, `puts_atm`, `puts_itm` frozen 52 bars | 0 |

That leaves 35 clean sessions and 41 of 250 signals marked `DATA_BAD`.

## The earlier finding, and why it does not reproduce

An earlier hand analysis reported, over roughly 229 signals and 40 sessions:

- low-volume third: about −2 bp at +60 min, about 42% win
- high-volume third: about +4 bp at +60 min, about 63% win

It does not reproduce under the rules above, and the reason is reproducible.
`sql/verify_volume_regime.sql` prints four variants of the same calculation,
changing only the baseline rule and the day filter:

| Variant | Bottom third | Top third | n |
|---|---|---|---|
| A — prior-days baseline, bad sessions excluded | −3.1 bp, 45% | **+0.2 bp, 50%** | 179 |
| B — same, terciles rather than 0.80 / 1.10 | −0.8 bp, 48% | +1.7 bp, 52% | ~194 |
| C — look-ahead baseline, bad sessions excluded | −1.4 bp, 45% | +2.8 bp, 58% | ~195 |
| D — look-ahead baseline, no day filter | −3.7 bp, 38% | **+4.5 bp, 61%** | 228 |

**D is the earlier analysis.** 228 signals against the remembered ~229, +4.5 bp
and 61% against the remembered +4 bp and 63%. So that analysis averaged each
time slot over the whole sample *including the day being scored*, and left the
frozen-feed sessions in.

Removing the look-ahead alone (C) takes the top third from +4.5 bp to +2.8 bp.
Removing the bad sessions as well (A) leaves +0.2 bp. **The high-volume edge
was mostly the two biases.**

The low-volume side is the result that survives: −3.1 bp at 45% win, against a
remembered −2 bp at 42%. That one is worth watching.

Nothing here was tuned to close the gap, and nothing should be. If someone
later widens the baseline window to recover the old number, they will be
recovering the bias.

### The sample is not yet decisive

At roughly 5 classified signals per clean session, and LOW taking about 18% of
them, LOW needs on the order of 75 more clean sessions to reach `min_n_reliable
= 100`; HIGH needs about 40. Until then every row on the tab carries a thin-n
flag, which is correct rather than a defect.

## Objects

| Object | What it is |
|---|---|
| `v2_vol_regime_config` | one-row table, every threshold |
| `v2_volume_regime` | **materialized** view, one row per deduplicated 5-minute bar, both symbols |
| `spy_volume_regime` | `v2_volume_regime` filtered to SPY — the name the brief asked for |
| `v2_signal_enriched` | `v2_signal_log` plus regime and signed forward returns |

Defined in `sql/volume_regime.sql`. The four RPCs behind the tab are in
`sql/volume_regime_rpcs.sql`.

### Why it is materialized

As a plain view this was correct but would not compose. Postgres cannot
estimate through the `row_number() ... rn = 1` dedupe, so it planned the `bars`
CTE at 27 rows against an actual 5,358. Every downstream CTE inherited that
guess, the planner chose nested loops throughout, and

```sql
select count(*) from v2_signal_enriched
```

estimated 72.8 million rows out of a 250-row signal log and ran for over two
minutes — while the same view had answered a `GROUP BY` in 323 ms minutes
earlier. With estimates that bad the plan flips between workable and
catastrophic on trivia, which is worse than being reliably slow.

It refreshes every 5 minutes on weekdays, 13:00–21:00 UTC, via `pg_cron`,
matching the Worker's own cron window. `CONCURRENTLY`, so readers are never
blocked — which is why the unique index on `(symbol, ts)` is not optional.

```sql
-- inspect
SELECT * FROM cron.job WHERE jobname = 'refresh_v2_volume_regime';
-- stop
SELECT cron.unschedule('refresh_v2_volume_regime');
```

Consequence: the current-status box is at most one bar stale. The box reports
its own lag when the last bar is more than 10 minutes old.

## Forward returns

`v2_signal_log` carries no price and no symbol — only `signal_time`,
`direction`, `grade`, `atm_strike`, `logged_at` — so returns are joined from
`spy_intraday_log`. Every signal lands exactly on a 5-minute bar in both logs,
so all joins are equalities with no fuzzy matching.

Returns are **signed**: positive means the signal's direction was right.
`CALL` is `+1`, `PUT` is `−1`.

Coverage is not total — 249/250 at +30 min, 243/250 at +60 min, 250/250 at EOD.
The gaps are mostly 2026-11-05, which has two price bars all day. A missing bar
yields NULL, never 0, so it cannot be averaged in as a flat trade. This is why
the tab reports `n`, `n_30` and `n_60` separately: they are not the same number.

## The tab

Reachable at **Volume Regime**, or keyboard `5`.

The client holds no Supabase key, so the views are not reachable from the
browser — only functions are, and only once their names are in `ALLOWED` in
`worker.js`. The four are listed at the foot of `sql/volume_regime_rpcs.sql`.
Forgetting one gives a 403, not an empty panel.

`v2_vol_regime_perf_by_strategy` and `v2_vol_regime_days_by_strategy` are
SPY-only, because the signal log is. On QQQ the tab shows the profile and
status for QQQ and a banner in place of the regime table, rather than an empty
table that would read as "no trades won".

QQQ has 26 sessions of bucket data against SPY's 45, and 855 of its 1,944 bars
fall on bad sessions. Its baselines are correspondingly thin.
