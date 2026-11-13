# Adding strategies and new models

The dashboard will eventually cover strategies beyond the v2 bucket log. The
architecture already anticipates this, and the seam is deliberate - preserve it.

## The design already in place

The whole point of the `_by_strategy` refactor is that **the browser never
learns which table a strategy reads**. A strategy id goes down, SQL resolves it
to a symbol and a source, rows come back. Consequences:

- Adding a strategy that fits the existing shape needs **a registry row and
  nothing else** - no frontend change, no Worker change, no deploy.
- `worker.js` fetches the live list via `list_strategies` and alerts on all of
  it, so a new strategy gets Telegram alerts automatically.
- `FALLBACK_STRATEGIES` in `worker.js` exists only so losing the registry read
  costs one symbol's alerts instead of all of them.

`status = 'retired'` is filtered out everywhere rather than deleted - history
stays readable.

## Case 1: another symbol, same model

Entirely data. Insert a row in `public.strategies`:

```sql
insert into public.strategies (id, name, symbol, status, sort_order, params)
values ('two_tier_divergence_iwm', 'Two-Tier Divergence', 'IWM', 'live', 3,
        '{"min_flow":0.5,"min_room":1.5,"start_t":"10:00","end_t":"15:00",
          "grade_a":8,"grade_b":6,"grade_c":4,"signal_min_score":6,
          "premium_table":"iwm_option_premium"}'::jsonb);
```

Then the data has to exist for it, which is the actual work and is **outside
this repo**:

1. A Make.com scenario writing `iwm_bucket_log_v2` (clone "QQQ OVP Bucket V2").
2. `bucket_v2_all` extended with another `UNION ALL` branch adding the literal
   symbol.
3. `session_levels_all` and `intraday_all` likewise, or POC/VAL/VAH come back
   null and every bar reads `session-view data not ready`.
4. A premium feed and edge function if the Performance tab should work;
   otherwise leave `premium_table` out - `v2_premium_sources` exists precisely
   so the tab can say "no feed yet" instead of rendering an empty table that
   reads as "no trades won".
5. Enough prior clean sessions before the Volume Regime tab shows anything -
   `min_baseline_days` is 5.

Ask before any of steps 2-4: they are production schema changes.

## Case 2: a genuinely different model

A model with its own fields, gates or score does **not** fit `params`. Do not
widen `v2_dashboard_by_strategy` to accommodate it - that function is the
definition of what a v2 bucket-log signal is, and bending it would make one
model's gates leak into another's history.

Instead, mirror the structure:

```
New model "foo":
  sql/foo_model.sql              its own RPCs, named v2_foo_* or foo_*
  worker.js                      add those RPC names to ALLOWED
  index.html                     a new tab + its content div
  js/foo.js                      loadFoo() + renderFoo(), added to the script
                                 list in load order
  js/filters.js                  switchTab(): add to `order`, add the
                                 `if (name === 'foo') loadFoo()` branch
  public.strategies              rows with the new ids
```

See [frontend.md](frontend.md) for the five-place tab checklist and the
`loadVolRegime()` pattern to copy. The Volume Regime tab is the most recent
worked example of exactly this, including its own config table.

### What to keep

- **One RPC per question, `SECURITY DEFINER`, `search_path` pinned, no
  `anon`/`authenticated` grant.** Reachable only through the proxy.
- **`p_strategy` as the first-class parameter**, resolved to a symbol in SQL.
  Never pass a table name or a symbol from the browser.
- **The registry as the only list of what exists.** Anything that hardcodes a
  strategy id in JS is a bug waiting for the third strategy - the one
  acceptable exception is `DEFAULT_STRATEGY` in `config.js`, which seeds the
  first render before `list_strategies()` returns.
- **A config table rather than inlined constants** when a model has tunable
  cutoffs, so retuning is an `UPDATE` and the UI can display the cutoffs it
  actually used instead of a drifting copy. `v2_vol_regime_config` is the
  pattern: one row, `CHECK (id)` to enforce it.
- **Fallbacks for every registry-sourced value** (`coalesce(..., <literal>)`),
  so a half-filled row yields the old defaults rather than zero rows and a
  blank page with no error.
- **Tokens for colour**, so the new tab follows the theme for free.

### What not to do

- Don't add a chart library for a new model. Three techniques already cover it
  (inline SVG / styled divs / canvas) and the no-external-requests property is
  worth more than the convenience.
- Don't convert `js/` to ES modules to make a new file tidier. One global scope
  and inline `onclick` are load-bearing across 15 files and 797 lines of HTML.
- Don't reuse `volMap` / `anomalyMap`-style bare-candle-time keys across
  symbols. Both are keyed by candle time with **no strategy in the key**, which
  is why the aggregate view has to clear them explicitly - left populated they
  hang one symbol's volume on another's candle of the same minute. A new map
  that can span strategies needs the strategy in its key (see `pinWallKey()`).
- Don't let a new model write anything. This dashboard reads.

## The aggregate view

`currentStrategy === '__all__'` ("Today's Alerts") fans the flow RPC out over
the registry and merges graded candles from every strategy into one table. A
new strategy joins it automatically.

Things that cannot work in that view, and are deliberately disabled rather than
approximated: volume, anomalies, regime context, and the pin INTO/AWAY badges -
all are per-symbol, and one symbol's levels against another's candles would be
a confident wrong answer. The put-wall flag *does* survive, because `pinAgg`
keeps each strategy's rows separate and the key carries the id.

If you add a per-symbol card, decide explicitly which of those two categories
it is in, and make the aggregate path clear it if it is the first.
