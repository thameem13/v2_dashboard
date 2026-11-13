# The v2 bucket log model

Everything here is derived from `v2_dashboard_by_strategy` (the live function
body in Supabase), `sql/volume_regime*.sql`, and `VOLUME_REGIME.md`. Where the
code does not state something, it is marked **TO CONFIRM** rather than guessed.

## What a bucket is

A bucket is **one cell of a 2x3 grid**: side (call / put) x moneyness (OTM /
ITM / ATM), measured against the at-the-money strike for the bar. Six buckets:

```
calls_otm   calls_itm   calls_atm
puts_otm    puts_itm    puts_atm
```

Each is logged twice:

- **`<bucket>`** - the cumulative session total for that bucket.
- **`<bucket>_inc`** - the *increment* for this bar, i.e. the change since the
  previous bar. The signal model reads the `_inc` columns; the cumulative ones
  are what the volume-regime baseline sums.

`calls_otm_notional` / `puts_otm_notional` / `calls_itm_notional` /
`puts_itm_notional` carry dollar volume for four of the six buckets. There are
**no ATM notional columns** - this asymmetry is in the schema, not a
documentation gap.

**Volume**, wherever the project says "volume" without qualification, is all
six cumulative buckets summed - not OTM alone.

**TO CONFIRM** - these are set by the Make.com scenario, outside this repo:
- The exact moneyness boundaries. `atm_strike`, `lowest_strike` and
  `highest_strike` are logged per bar, so ATM is presumably the single
  `atm_strike` and OTM/ITM are relative to it, but the strike-count width of
  the grid is not stated anywhere in the repo.
- Whether buckets count contracts or trades.
- `in_grid` (boolean) - presumably "price was inside the logged strike grid",
  which would make it a data-quality flag. Not read by any dashboard RPC.
- `divergence_flow` - logged pre-computed by the ingestion. Its **sign
  convention is confirmed** below from how the model uses it, but its formula
  is not in this repo.

## The bar

5-minute bars across the NY session. Three time columns, which is a recurring
source of bugs:

| Column | Type | Note |
|---|---|---|
| `candle_time` | `text` | raw as received |
| `candle_time_ts` | `timestamptz` | |
| `candle_time_ny` | `timestamp` (no zone) | **what everything reads**; wall-clock NY |

The v2 RPCs disagree about whether the value they return carries a zone
suffix, so the frontend normalises with `tsKey()` (`js/format.js`) and
`worker.js` with `candleKey()` before comparing or sorting. Never compare these
as raw strings.

SPY carries ~150 rows with `candle_time_ny` **and** `candle_time_ts` null and
every increment null. These are orphans, not bars, and are dropped
deliberately in `v2_volume_regime`'s `dedup` CTE.

## Direction

`direction` is **three-valued**: `'CALL'`, `'PUT'`, `'none'`. Treating it as a
two-way CALL/PUT test is a bug that has already shipped once (see the comment
on `dirLabel` in `worker.js`).

```
abs(flow) <  min_flow   -> 'none'
flow      >=  min_flow  -> 'PUT'     <-- positive flow means PUT
flow      <= -min_flow  -> 'CALL'
```

The sign is counter-intuitive and load-bearing: **positive `divergence_flow` is
a PUT signal.**

## The score: five components, 0-10

Computed in SQL per bar. `flow` is `round(divergence_flow, 3)`.

| Component | Column | Values | Rule |
|---|---|---|---|
| Flow strength | `sf` / `s_flow` | 1-3 | `abs(flow) >= 0.9` -> 3; `>= 0.7` -> 2; else 1 |
| Volume | `sv_` / `s_vol` | 0-2 | bar volume vs the session running mean: `>= 1.5x` -> 2; `>= 1x` -> 1; else 0 |
| Institutional | `si` / `s_inst` | 0-2 | signal-side ITM+ATM increments vs the other side's: `>= 3x` -> 2; `>= 2x` -> 1; else 0 |
| Room | `sr` | 1-2 | `room >= 2.0` points -> 2; else 1 |
| Clean | `sc` / `s_clean` | 0-1 | `0` if the ATM strike flipped on this bar, else `1` |

`score = sf + sv_ + si + sr + sc`.

Two details worth knowing:

- **Volume here is the session running mean**, `avg(cvol) OVER (... UNBOUNDED
  PRECEDING AND CURRENT ROW)` - it includes the current bar and only looks
  within the day. That is a different measure from the volume-regime tab's
  rVOL, which is why they get separate objects. Do not treat them as
  interchangeable.
- **Institutional** reads only the ITM and ATM increments
  (`puts_itm_inc + puts_atm_inc` against `calls_itm_inc + calls_atm_inc`), on
  the premise that size sits at and inside the money. OTM is excluded.
- `nullif(x, 0)` in the institutional ratio means a zero on the other side
  yields NULL, so the component scores 0, not 2.

## Grades

Thresholds come from the strategy's `params` JSON, not from literals:

```
score >= grade_a (8) -> 'A'
score >= grade_b (6) -> 'B'
score >= grade_c (4) -> 'C'
else                 -> 'D'
```

A grade exists for every bar with a direction. **A grade is not a signal.**

## has_signal: six gates, all required

```
direction <> 'none'
AND poc, val, vah all present            -- session-view data ready
AND candle_time_ny::time BETWEEN start_t AND end_t     -- 10:00-15:00
AND poc_aligned
AND room >= min_room                     -- 1.5 points
AND score >= signal_min_score            -- 6
```

- **`room`** is headroom to the far edge of the value area, in points:
  `price - val` for a PUT, `vah - price` for a CALL.
- **`poc_aligned`** is `price < poc` for a PUT, `price > poc` for a CALL - the
  signal must be on the far side of the point of control from its target.
- **`reason`** is a human-readable string naming the *first* gate that failed,
  in that order, or `ALERTED - grade <X> <dir> @ <strike>`. It is the most
  useful field on the Flow tab: on a near miss the reason *is* the message.

POC / VAL / VAH come from `session_levels_all`, not from the bucket log. When
that feed lags, `poc` is null and every bar reads
`session-view data not ready` - a feed problem, not a quiet market.

## Strategy parameters

In `public.strategies.params` (jsonb), one row per strategy. Both live
strategies currently carry identical tuning:

| Key | Value | Used for |
|---|---|---|
| `min_flow` | 0.5 | direction threshold |
| `min_room` | 1.5 | room gate (points) |
| `start_t` / `end_t` | 10:00 / 15:00 | time window |
| `grade_a` / `grade_b` / `grade_c` | 8 / 6 / 4 | grade cutoffs |
| `signal_min_score` | 6 | score gate |
| `premium_table` | `spy_option_premium` / `qqq_option_premium` | backtest feed |

Every one of these has a hardcoded fallback in the RPC (`coalesce(..., 0.5)`
etc.) so a missing or half-filled registry row yields the pre-registry
defaults rather than zero rows and a blank dashboard.

Retuning a parameter is an `UPDATE` with no deploy - **and it silently
re-grades the entire history**, because grading is computed at read time, not
stored. Ask before changing one.

## Volume regime (the fifth tab)

A separate, stricter measure. Full detail in `VOLUME_REGIME.md`; the essentials:

- **30-minute volume** at bar `t` = cumulative total at `t` minus cumulative
  total at `t - 30min`, same symbol, same NY date. Both bars must exist exactly
  30 minutes apart or no value is produced (22 such gaps exist).
- **Baseline** = mean 30-minute volume at that time-of-day over **prior clean
  sessions only**, never including the day being scored. In SQL that is
  `ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING` in `baseline_calc`.
  **Do not change this frame clause.**
- **vratio** = 30-minute volume / baseline. `LOW` below `low_max` (0.80),
  `NORMAL` up to `normal_max` (1.10), `HIGH` above.
- Three non-regime states, shown separately so the signals add up:
  `DATA_BAD`, `NO_BASELINE`, `NO_WINDOW`.
- A session is **BAD** (and excluded from every baseline) on a frozen feed
  (a component's increment is 0 for `frozen_bars_min` consecutive bars while
  the bar total still grows), a short session, or a late start.

**Read this before quoting any number from this tab.** An earlier hand analysis
reported a +4 bp / 63% win edge in the top volume third. Reproduced exactly at
+4.5 bp / 61% - then: remove the look-ahead and it falls to +2.8 bp / 58%;
remove the bad days as well and it is **+0.2 bp / 47%**. The edge was mostly
the bias. This is why the tab shows no number without its `n`.

Cutoffs live in one row of `v2_vol_regime_config` and the tab displays the ones
it actually used. To change one: `UPDATE`, then
`REFRESH MATERIALIZED VIEW CONCURRENTLY public.v2_volume_regime`.

## Pin / Chop detector

`v2_pin_series_by_strategy` is the only RPC exposing `call_wall` and `put_wall`
per candle. It answers "did the gamma walls hold still all session", i.e. is
price pinned. `js/pin.js` evaluates it at render time.

One flag is PUT-only by design: a PUT sitting strictly **above** the put wall
and within `PIN_PUT_WALL_BAND` (0.5) is flagged as selling into dealer support.
There is deliberately no call-side equivalent - see the long comment in
`js/pin.js`. The band is duplicated in `worker.js` as `PUT_WALL_BAND`;
**change both together.**

## Legacy logs - do not build on these

| Table | Last row | Status |
|---|---|---|
| `v2_signal_log` | 2026-11-06 | writer dead; superseded |
| `v2_anomaly_log` | 2026-10-19 | not read by any dashboard RPC |

`v2_signal_log` (`signal_time, direction, grade, atm_strike, logged_at`) was
written by the Make.com scenario "V2 A/B Signal Alert", now inactive - the
Worker cron replaced it for alerting, but nothing replaced it as a writer. It
has **no symbol column**, which is why the volume-regime tab could never show
QQQ signal numbers.

`sql/volume_regime_signals.sql` fixes this by deriving the signal set from
`v2_dashboard_range_by_strategy` instead, so there is one definition of "what
is a signal". Its own validation notes record: derived 277 vs logged 250,
matched on timestamp 250, zero direction/grade/strike mismatches - a strict
superset, the extra 27 being the signals since the writer died.

**Applied 2026-11-12.** `v2_signal_enriched_by_strategy` now exists and the
three regime RPCs read it, so both symbols have signal numbers and the set is
current: **SPY 277, QQQ 153**. `v2_signal_enriched` (the log-reading view) is
deliberately left in place and no longer read by the tab — it is the only thing
that can still show what the log itself contains, which is how you would notice
the external writer coming back.

Do not point anything new at `v2_signal_log`.
