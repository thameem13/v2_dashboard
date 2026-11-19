# Today's Regime

One advisory read, before the first trade of the day, on whether today's
opening conditions have historically suited the strategy.

It gates nothing. The signal table, the grades, the alerts and the Telegram
cron behave identically whether this card says FAVOURABLE or CAUTION, and
nothing in the signal path reads `v2_regime_day`. If that ever stops being
true, it has stopped being this feature.

Read the section on what the sample does and does not support before acting on
any verdict it gives. The short version: one of the three bands is a merge of
two the data could not separate, and the red band rests on a single session.

## The verdict

Classification is on the **opening** VIX1D, frozen.

| open VIX1D | verdict | colour |
|---|---|---|
| `< 10` | THIN | amber |
| `10 – 17` | FAVOURABLE | green |
| `>= 17` | CAUTION | red |
| null | NO DATA | grey |

`POST_EVENT` downgrades any verdict to CAUTION, reason "priced off resolved
uncertainty". The downgrade is applied **at read time**, not stored, so tagging
a day after the open never rewrites a frozen verdict.

### Why the open, and why frozen

VIX1D climbs through the session as the front expiry decays and the measure
rolls toward the next day's. Over all 81 logged sessions it rose more than 15%
from its first reading to its session high on **71**, and the mean rise to high
is **40.1%**. The open was the session high on 3. It is a sawtooth, not a
trend, so the latest value — which is what the Regime strip above the card
shows — cannot be compared across days. The verdict uses the first non-null
`vix1d` of the `trade_date` and never moves.

The card shows the open and the live value side by side, with the drift between
them, so that this is visible rather than asserted.

## What the sample supports

48 complete sessions (2026-09-08 .. 2026-11-18), deduplicated, `candles >= 70`.
`realized_vs_implied` = (session high − low) / (opening `impl_move` × 2).

By raw VIX1D band:

| band | n | median r/i | avg net | efficiency | hit rate |
|---|---|---|---|---|---|
| `< 10` | 30 | 0.664 | $2.46 | 11.0% | 23% |
| `10–13` | 10 | 0.678 | $3.11 | 10.4% | 50% |
| `13–17` | 7 | 0.780 | $8.48 | 17.2% | 43% |
| `>= 17` | 1 | 0.389 | $3.18 | 6.0% | 0% |

**The 13–17 band is one day.** Its seven r/i values are 0.871, 2.132, 0.916,
0.493, 0.646, 0.779, 0.780. Remove the 2.132 — 2026-11-05, a real 29-point
liquidation on 77 clean candles, not a logging artifact — and the band averages
0.748 against 0.713 for `< 10`. The whole apparent edge is that one session.

**Hit rate cannot separate 10–13 from 13–17.** The ordering flips at every
cutoff tried:

| band | ≥0.7 | ≥0.8 | ≥0.9 | ≥1.0 |
|---|---|---|---|---|
| `< 10` | 40% | 23% | 17% | 13% |
| `10–13` | 50% | **50%** | 20% | **20%** |
| `13–17` | **71%** | 43% | **29%** | 14% |

So "10–13 beats 13–17", which is true at 0.8, is a property of the threshold
and not of the market. `hit_threshold` is a named config value for exactly this
reason.

What *is* stable across every cutoff is that **`< 10` is the worst band**, and
that median r/i and net move rank monotonically with the opening level
(efficiency nearly does: 10–13 sits marginally below `< 10`). That is the only
cut these 48 days earn, and it is why 10–17 is one band on the card.

The merge is also what makes the green band scoreable at all:

| verdict | n | median r/i | avg net | efficiency | hit rate |
|---|---|---|---|---|---|
| THIN | 30 | 0.664 | $2.46 | 11.0% | 23% |
| FAVOURABLE | 17 | 0.780 | $5.32 | 13.2% | **47%** |
| CAUTION | 1 | 0.389 | $3.18 | 6.0% | 0% |

47% against 23% is a separation the fine bands never showed, and n = 17 reads
as "provisional" rather than "hypothesis - 7 days only".

The fine bands are still **stored** (`regime_band_fine`) and tallied behind a
disclosure on the card. Merging the display is reversible; discarding the
resolution would have cost a backfill the day the split becomes real.

### The 17 line is the weakest number here

It rests on one session. 2026-11-16 opened 15.90 and 2026-11-17 opened 15.92,
both green; 2026-11-18 opened 18.73, red. Three near-adjacent observations
straddling a boundary that one of them defines. It is kept because the costs
are asymmetric — a wrong CAUTION costs a skipped trade, a wrong FAVOURABLE
costs a loss — not because one day is evidence. The card labels it
"untested - no prior session in this band" and should keep doing so.

## The event calendar

The event context is now **derived from a calendar**, not typed in each
morning. `v2_market_event` holds the handful of dates that plausibly matter;
`v2_regime_event_derive()` turns them into PRE/POST/CLEAN per session. The
dropdown on the card is an **override**, not a daily chore - it reads "Auto
(calendar)" unless a human has overruled it.

Why hand-seeded rather than an API: the hard part was never fetching dates.
An economic calendar pulled wholesale marks nearly every session as an event
day, which carries the same information as marking none. The shortlist is the
judgement, and it lives in rows so that revising it is an INSERT, not a
deploy.

Windows run against the session clock, so an 08:30 CPI is POST for its own
day and PRE for the day before, and NVDA at 16:20 on the 17th is PRE for the
17th and POST for the 18th. That pair now reproduces itself with nobody
tagging anything.

**FOMC is the awkward case.** It lands 14:00 ET - intraday, neither after a
close nor before an open. It is treated as PRE for its own day, because what
matters to a verdict frozen at 09:35 is whether the catalyst is still ahead.
That widens the original definition and is the one rule here worth arguing
with.

**CLEAN is never inferred from silence.** A date the calendar does not know
about derives to UNSET and renders as "no calendar entry", not as a quiet day.
CLEAN is only asserted inside a window declared complete in
`v2_market_event_coverage`, and no window is declared yet, because the seeded
calendar has CPI, FOMC, the jobs report and NVDA but not the other mega-cap
earnings or PCE.

### First read, on a sample far too small to mean anything

| context | n | median r/i | avg net | efficiency | hit rate |
|---|---|---|---|---|---|
| Pre-event | 7 | 0.780 | $7.27 | 14.5% | 43% |
| Post-event | 3 | 0.493 | $3.18 | 9.1% | 33% |
| No calendar entry | 38 | 0.667 | $2.81 | 11.3% | 29% |

Directionally this is the hypothesis: days with the catalyst still ahead
deliver, days priced off resolved news do not. On 7 and 3 sessions it is
nothing more than a direction, and the 38-day bucket is not a control group -
it is the days nobody has checked.

### The event hypothesis this was built to test

2026-11-17 opened 15.92 and delivered $11.81, 0.78 of implied. 2026-11-18
opened **higher** at 18.73 and delivered $6.23, 0.39. NVDA reported after
Tuesday's close, so Tuesday was the pre-event positioning day and Wednesday was
priced off uncertainty that had already resolved. A vol threshold cannot see
that difference.

Two of the seven days in the original 13–17 band were pre-NVDA. The band may
be reading event proximity rather than volatility level, which is what the
event calendar above exists to find out.

## Where things live

| Thing | Where |
|---|---|
| Every threshold | `v2_regime_config`, one row. Retuning is an `UPDATE`, no deploy |
| Per-session rows | `v2_regime_day`, keyed `trade_date` |
| The inputs | `v2_regime_source` view |
| DDL and the reasoning | `sql/regime_verdict.sql` |
| The card | `js/regimeverdict.js`, rendered into `#regime-verdict` |
| Styles | `css/widgets.css`, `.rv-*` |
| Proxy allowlist | `worker.js` |

`js/regimeverdict.js` holds **no thresholds** — only a verdict-to-colour map.
To re-split the green band: `UPDATE v2_regime_config SET caution_min = 13`
moves 13–17 into CAUTION, or add a fourth verdict and extend
`v2_regime_band()`. Either way the JS does not change.

## Data caveats that are not fixable here

**The verdict's two inputs come from the lossy table.** `vix1d` and
`impl_move` exist only in `spy_intraday_log`, which suffers candle loss —
2026-11-05 logged 2 rows for the whole session, 2026-11-09 logged 22. Every
price-derived figure comes from `spy_bucket_log_v2` instead, but the open
cannot. `intraday_rows` is stored and the card warns below 40 rows.

**The "open" is sometimes not the open.** The first non-null `vix1d` arrives
after 09:45 ET on 5 of 48 sessions — 10:55 on 09-09, 10:25 on 09-15, 10:00 on
09-08, plus 09:50 and 09:55. Given the upward drift, a late first reading is an
inflated open and can place the day in the wrong band.
`open_vix1d_captured_ny` is stored and the card flags it.

**VIX1D comes from TradingView, not Cboe.** It enters through the Make.com
scenario "TV to Supabase" (team 1174049) as a field in the alert webhook
payload — a `request.security()` read on `CBOE:VIX1D` inside the Pine script,
captured on SPY's 5-minute bar close. Three consequences: the read is delayed
if the TradingView plan lacks real-time Cboe index data; `request.security`
holds the last available bar rather than erroring; and the insert is
`ON CONFLICT (candle_time_ts) DO NOTHING`, so the first value to land for a
candle wins permanently and a retry cannot repair it.

A trustworthy open would need a separate 09:35 ET fetch from a source with a
known delay, written once per `trade_date`. That is a new ingestion path
outside this repo, and it has not been built.

**`realized_range` is not the true range.** It is high minus low of a 5-minute
snapshot series, so it understates the real session range — consistently across
every day, so it compares day to day, but it is not a high/low.

**Deduplication matters and changes numbers.** Raw bucket candle counts run
28–142 against 78 real bars, so a raw `>= 70` filter admits duplicate-inflated
sessions. Collapsing on `(trade_date, candle_time_ts)` leaves n and median r/i
untouched but moves the path-derived figures: the 10–13 band's average net move
falls from $4.36 to $3.11 and its efficiency from 14.1% to 10.4%, because a
duplicate final timestamp changes which candle counts as the session's last.
Every figure in this document is the deduplicated one.

## The one write

`v2_regime_set_event_by_strategy` is the first mutating call ever added to the
proxy allowlist. Before it, the dashboard wrote nothing at all, and an
allowlist of pure reads could not be turned into a write primitive by anything
that got past Cloudflare Access.

What keeps it narrow is in SQL: one date, one of four literal values, `22023`
on anything else, cannot create a row for a date with no logged session, and
can touch no column but `event_context`. It cannot reach a verdict, an open, an
outcome, or any table the signal path reads.

## Status

**observe & log — unconfirmed.** Same state as the model itself. This is a
hypothesis being scored in public: the strip and the tally exist so that the
feature can be shown not to work. A verdict nobody scores is a horoscope.

What would change the thresholds: the running tally separating 10–13 from
13–17 over a materially larger sample, or the `POST_EVENT` days turning out to
explain more of the variance than the vol level does.
