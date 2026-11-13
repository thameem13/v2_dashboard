# Frontend quality bar

[frontend.md](frontend.md) says how this codebase does things. This says what
*good* looks like, and where the code currently falls short of it.

The distinction matters because much of this dashboard is carefully built and
worth imitating, and a few parts are not. Copying the nearest existing pattern
is usually right here — but not always, and the last section names the
exceptions so they do not spread.

## What this app actually is

A single-page, no-framework, no-build dashboard that **polls every 10 seconds**
and re-renders tables of up to ~1,500 rows, watched for hours at a time, by one
person, often on a phone, while money is at stake. That shapes every judgement
below:

- **Wrong data on screen is worse than no data on screen.** An empty chart that
  reads as "no signal today" is the failure mode this project fears most. Every
  empty state must say *why* it is empty.
- **Staleness must be visible.** The sync-age indicator, the "Showing last
  session" banner and the build-staleness check all exist because a confident
  wrong number costs a trading day.
- **The 10s poll is a hard budget.** Anything on the poll path runs ~360 times
  an hour, forever.

## Accessibility

The bar: **keyboard-operable, screen-reader-truthful, and legible at phone
width in both themes.** The codebase is roughly half-way there — 37 `<label>`s,
14 `aria-pressed`, `role="group"` on the grade chips, `role="status"` on the
build notice, `aria-busy` toggled on the refresh button, and `aria-label` on
every icon button and chart. That is real work; keep it up.

Rules for new work:

- **Anything clickable must be focusable and keyboard-operable.** A `<div
  onclick>` is not. Use `<button>`, or if the element must stay a div, give it
  `role`, `tabindex="0"` and an Enter/Space handler. New interactive markup
  should not add to the tab debt below.
- **Interactive state goes in ARIA, not only in a CSS class.** A `.active`
  class tells a sighted user; `aria-selected` / `aria-pressed` /
  `aria-expanded` tells everyone else. Follow `syncGradeChips()` — one writer
  setting both.
- **No `aria-pressed` on a mode toggle.** The theme button deliberately omits
  it: it is a mode, not an on/off, so "pressed" would have no honest value.
  That reasoning is correct — do not "fix" it.
- **Anything that appears on its own must announce itself.** A new signal, a
  sticky alert, a load failure — if it arrives without a click, it needs
  `aria-live="polite"` (or `assertive` for an alert). See the gap below.
- **A modal must trap focus**, carry `role="dialog"` and `aria-modal="true"`,
  move focus in on open and restore it on close. Esc already closes.
- **Charts** keep `role="img"` plus an `aria-label` that reads as a sentence
  and states the actual end value — not "line chart".
- **Never signal by colour alone.** Direction already pairs colour with a
  `CALL`/`PUT` word and grades with a letter. Keep that pairing.
- **Respect `prefers-reduced-motion`** for anything new that moves. The block
  in `base.css` currently covers only 2 of ~17 animations, so you cannot assume
  a new animation is covered — add it.

Light theme was rebuilt specifically because the dark accents failed contrast
on white. Any new accent needs a value in **both** blocks and a contrast check
in both.

## Performance

The poll path is the budget. `loadAll()` already does the hard parts: it
aborts in-flight requests, preserves scroll position, pages past PostgREST's
1000-row cap, and keys the premium reload so the backtest does not re-run on
every tick.

- **Do not add work to the poll.** Tab data loads on arrival
  (`switchTab`), not on the tick. The build check runs every 5 minutes, not
  every 10 seconds, and that gap is deliberate.
- **Cache on-demand data by strategy** and refetch on switch — the
  `loadVolRegime()` pattern. Never show SPY numbers under a QQQ heading.
- **Rebuilding a table is one `innerHTML` write, not N.** Build the whole row
  set as a string and assign once; a loop of appends forces layout repeatedly.
  This is what the code already does — match it.
- **Anything per-row must be cheap.** A row body runs up to 1,500 times per
  poll. No `getComputedStyle`, no `getBoundingClientRect`, no date parsing you
  could hoist, inside a row builder.
- **Read layout before you write it.** `syncStickyHeaderOffsets()` and
  `syncNewsPanelHeight()` run on resize; batch measurement and mutation rather
  than interleaving.
- **Debounce user input** — filters go through `debounceFilter()` at 120ms.
- **Filtering hides rows, it does not refetch.** `applyFlowFilters()` toggles a
  class. Keep filtering client-side; a filter that hits the network on every
  keystroke is 360 requests an hour of someone typing.

Reach for `requestAnimationFrame` for visual work and `DocumentFragment` only
where the single-write rule genuinely cannot apply.

## XSS discipline

Everything renders as template strings into `innerHTML`, and the **only** thing
standing between the database and script execution is remembering
`escapeHtml()` on every interpolated value. There are 68 `innerHTML`
assignments. The discipline is not optional:

- **Escape every interpolated value that did not originate as a number you
  just computed.** Database strings — `reason`, `grade`, `direction`,
  `anomaly_type`, strategy labels, error messages — always.
- `escapeHtml()` from `format.js` for HTML; `tgEscape()` in `worker.js` for
  Telegram.
- **Never interpolate into an attribute without quotes**, and prefer building
  attribute values from known-safe tokens rather than raw data.
- An error message is not safe because it is an error:
  `escapeHtml(e.message)` is already the pattern in `loadAll()` — keep it.
- If a value is genuinely numeric, coerce it (`+v`) rather than trusting it.

A reviewer should be able to scan a diff and see an `escapeHtml()` around every
`${}` that touches RPC data.

## State

There are ~29 mutable globals in one shared lexical scope. That is the
architecture and it is not changing — but it is also the thing most likely to
produce a subtle bug.

- **One writer per piece of state.** `setSymFilter()` and `toggleGradeChip()`
  are the model: the variable is the truth, and both the desktop and phone
  views repaint from it, never from each other.
- **Clear what no longer applies.** The aggregate view explicitly nulls
  `volMap`, `anomalyMap`, `pinSeries` and `regimeCtx` because their keys carry
  no strategy — left populated they hang one symbol's data on another's candle.
  Any new map that can span strategies needs the strategy in its key.
- **Keep "failed" distinct from "empty."** `volRegimeFailed` exists so the UI
  never says "no signal data for this strategy" when what happened was a failed
  request. Reproduce that distinction in any new tab.
- **Set the cache key only after success**, so a failure retries.

## Review checklist

Beyond the functional one in SKILL.md:

- [ ] New interactive elements are keyboard-operable and expose their state
- [ ] Anything that appears unprompted is announced (`aria-live`)
- [ ] Every `${}` touching RPC data is wrapped in `escapeHtml()`
- [ ] Nothing new added to the 10s poll path
- [ ] Per-row code does no layout reads
- [ ] Empty, loading and failed states are distinct and each says why
- [ ] Checked at phone width and in both themes
- [ ] Colours come from tokens; new accents defined in both theme blocks
- [ ] New animation respects `prefers-reduced-motion`
- [ ] No console errors, and no new globals that two views could both write

## Known gaps — debt, not precedent

Verified 2026-11-12. Do not copy these; fixing them is welcome but is its own
change, not a drive-by.

**The tab bar is inaccessible.** Five `<div class="tab" onclick=...>` in
`index.html` with **zero** `role="tab"`, `aria-selected` or `tabindex` anywhere
in the file. Not focusable, not keyboard-operable, and a screen reader is told
nothing about which panel is showing. The `1`–`5` shortcuts are a workaround
for sighted keyboard users, not an accessibility fix. Proper fix:
`role="tablist"` / `role="tab"` / `role="tabpanel"`, `aria-selected` driven by
the existing `switchTab()` loop, roving `tabindex`, arrow-key navigation.

**Sticky alerts are silent to assistive tech.** `#alert-stack` has no
`aria-live`, and there are **zero** `aria-live` regions in the whole page. For
a dashboard whose core purpose is announcing signals, that is the most
consequential gap here. `aria-live="assertive"` on the alert stack and
`polite` on the sync-age line would cover most of it.

**The journal modal is not a dialog.** No `role="dialog"`, no
`aria-modal="true"`, no focus trap, no focus restore. Esc closes it and the
overlay click works, so the behaviour is right and only the semantics and focus
handling are missing.

**Three uses of the implicit global `event`** — `js/main.js:78`,
`js/filters.js:205`, `js/signal.js:11`. The latter two at least guard with
`window.event &&`. `main.js:78` is bare:

```js
event.target.classList.add('active-preset');
```

This works only because `setDatePreset()` happens to be called synchronously
from an inline handler. It throws the moment anyone calls it programmatically —
which `main.js`'s own `D` shortcut narrowly avoids by synthesising a `.click()`
instead. Pass the element (or `this`) as a parameter.

**`prefers-reduced-motion` is partial** — 2 rules against ~17 animations and
transitions.

**There are no tests of any kind**, and no build step to add them to. In
practice verification is `npx wrangler dev` plus the checklist. Be
correspondingly careful with pure functions that are easy to get wrong —
`tsKey()`, `candleKey()`, `prevSessionDate()`, the score and grade formatting —
since nothing will catch a regression in them.
