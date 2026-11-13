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
| B — same, terciles rather than 0.80 / 1.10 | −0.9 bp, 47% | +2.2 bp, 54% | 177 |
| C — look-ahead baseline, bad sessions excluded | −1.4 bp, 45% | +2.8 bp, 58% | 195 |
| D — look-ahead baseline, no day filter | −3.7 bp, 38% | **+4.5 bp, 61%** | 228 |

Run `sql/verify_volume_regime.sql` to reproduce. Figures confirmed against the
live objects on 2026-11-09.

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

Defined in `sql/volume_regime.sql`. Four of the five RPCs behind the tab are in
`sql/volume_regime_rpcs.sql`; the fifth, `v2_vol_regime_flow_by_strategy`, is in
`sql/volume_regime_flow.sql`, which also adds `min_n_bucket` to the config
table.

### The flow RPC counts every session

`v2_vol_regime_flow_by_strategy` returns one row per 30-minute bucket with the
volume side and the signal side together. **Both sides span every session**,
and the regime table below it is the only thing here that still filters:

| Side | Sessions counted | Why |
|---|---|---|
| `avg_pct`, `days_n` | **all** | the shape of the day is a different question from the baseline, and it wants all the volume there is: a session that froze at 14:00 or started at 10:55 is still part of how this symbol trades |
| `n`, `win_*`, `avg_bp_*`, `sum_bp_*` | **all** | a frozen *option* feed says nothing about the price log the returns come from, so dropping those signals would discard real outcomes for an unrelated fault |
| regime baselines (`vratio`) | clean only | a feed frozen inside the 30-minute window is exactly what a ratio against a baseline would misread |

`n_bad` is how many of a bucket's signals fell on a session the baselines
exclude, so the tab can disclose the overlap rather than hide it.

**Why zero-fill.** Shares are averaged per session, so every row has to divide
by the same number of sessions. Averaging only the sessions that *reached* a
bucket makes 09:30 an average of 47 and 11:00 an average of 48, and the column
stops being a distribution — measured that way SPY sums to **100.98%** instead
of 100. `grid` crosses every session against every bucket and a missing bar
counts as 0.

That is true of the data and not of the market: on 2026-09-09 the feed's first
bar is 10:55, and the market certainly traded at 09:30. `days_gap` counts the
sessions with no bar in a bucket so the row can say "1 session blank" and the
focus card can call the share a floor rather than a reading. Today that is one
session of 48 on three SPY buckets, and the shift against clean-only is at
most 0.56pp — small, but small in a column that now actually totals 100.

Signals are bucketed on the **same shifted stamp as the bars**: a bar stamped
10:00 covers 09:55–10:00 and belongs to the opening half hour, and so does the
signal that fired off it. Flooring the signal clock instead would put a signal
one row below its own bar's volume, which defeats the point of the table.

`min_n_bucket` (default 10) is separate from `min_n_reliable` (100) because one
splits ~250 signals three ways and the other thirteen; 100 per time bucket is
unreachable. Same rule as every other cutoff here: it lives in the config table
so retuning it is an `UPDATE`, and the page shows the number it is actually
using.

`sum_bp_*` is summed in SQL rather than computed as `n × avg` in the client:
rounding an average to two decimals and multiplying it back up drifts by whole
basis points by the time n reaches the twenties.

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

Reachable at **Volume Regime**, or keyboard `5`. Four panels, in this order:

1. **Current status** — the latest bar and the cutoffs it was judged against.
   The only panel on the tab that reads the live feed, and therefore the only
   one the 15-minute delay touches. Everything below it is measured from the
   historical price log, which is why the delay is a non-issue for backtesting.
2. **Session flow** — one row per 30-minute bucket: share of a session's option
   volume, the signals that fired on those bars, win/loss split, average bp and
   net bp. A horizon switch moves the result columns between +30 min, +60 min
   and the close; clicking a row restates it as a sentence in the focus card
   above the table. This replaced a standalone volume-profile chart, whose
   single column is now the table's first one — the chart answered a third of
   the question and left the reader holding the rest in their head.
3. **Performance by regime** — the same signals read by how busy the tape was
   rather than when, every cell carrying its own n.
4. **Sessions excluded for bad data** — with the reason and how many signals
   each exclusion cost.

The session row at the foot of the flow table is a check on the columns above
it: volume has to add to ~100% of a session and the signal count to the log. A
reader who cannot see that has no way to tell whether a bucket went missing,
which is the class of quiet loss this tab exists to surface.

The client holds no Supabase key, so the views are not reachable from the
browser — only functions are, and only once their names are in `ALLOWED` in
`worker.js`. Four are listed at the foot of `sql/volume_regime_rpcs.sql` and the
fifth at the foot of `sql/volume_regime_flow.sql`. Forgetting one gives a 403,
not an empty panel.

All five RPCs work for both symbols. They did not always: see below.

## The signal set is derived, not logged

Until 2026-11-12 every signal number here came from `v2_signal_log`, whose
columns are `signal_time, direction, grade, atm_strike, logged_at` — **no
symbol**. Two consequences, one known and one not:

1. QQQ could never have signal numbers. The tab said `n/a` and explained why.
2. The log is written by something outside this repo — not `worker.js`, not
   `pg_cron` — and **it stopped on 2026-11-06**. On 2026-11-12 the tab was
   scoring 250 signals while the rule had actually fired 277. Six days and 27
   signals of silent drift, with nothing on the page to show it.

(2) is the real argument. A log kept by an external writer is a dependency that
can die quietly, and a tab built to make quiet losses visible should not rest
on one.

`v2_signal_enriched_by_strategy(p_strategy)` in `sql/volume_regime_signals.sql`
derives the signal set from `v2_dashboard_range_by_strategy` — the same
function the Flow Signal tab reads — rather than duplicating the rule. One
definition of "what is a signal", so the two tabs cannot disagree. It joins the
regime from `v2_volume_regime` and prices from `intraday_all`, both per symbol,
and the three signal-bearing RPCs read it.

### Validation before the switch (2026-11-12)

Derived SPY signals against the log, over the log's whole life:

| | |
|---|---|
| derived | 277 |
| logged | 250 |
| matched on timestamp | 250 |
| direction / grade / `atm_strike` mismatches | 0 / 0 / 0 |
| logged rows **not** in the derived set | 0 |

The derived set reproduces the log exactly and is a strict superset. Day for
day the two agree through 2026-11-06; the extra 27 are that day's last signal
plus every signal on 11-10, 11-11 and 11-12, when the writer was already dead.
Not a change of definition — the same set, brought up to date and extended to
QQQ (153 signals over 29 sessions).

Deriving the whole history costs ~117 ms (277 signals out of 3,798 bars). Three
RPCs call it per tab load, in parallel, so no materialized view is warranted.

`intraday_all` carries four duplicated QQQ timestamps (5,937 rows, 5,933
distinct), exact duplicates to the cent. The price CTE is `DISTINCT ON (ny)`
for that reason: leaving them would double-count any signal landing on one of
those four bars, and a doubled trade is invisible in every column except `n`.

`v2_signal_enriched`, the old log-reading view, is deliberately left in place
and no longer read by this tab. It is the last thing that can still show what
the log itself contains, which is the only way to notice the writer has come
back.

QQQ has 26 sessions of bucket data against SPY's 45, and 855 of its 1,944 bars
fall on bad sessions. Its baselines are correspondingly thin.
