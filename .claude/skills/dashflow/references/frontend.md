# Frontend conventions and design system

No framework, no build step, no bundler, **no external requests at all** - zero
CDN scripts, zero webfonts. Everything is served from the Worker's own origin.
Keep it that way: the page sits behind Cloudflare Access and a third-party
request would be the only thing on it that isn't gated.

There is deliberately **no service worker**. On a live trading dashboard a
cached shell is a hazard - it would render hour-old prices with no sign they
are stale, and paint happily while `/api/*` is being redirected to login.

## Files

`index.html` holds all markup (797 lines), an inline SVG `<symbol>` sprite for
icons, and **THE version number**.

### CSS - load order is load-bearing

```
tokens.css    palette, theme overrides, non-colour tokens   <-- always first
base.css      element defaults, typography base
cards.css     KPI cards
tables.css    the three data tables
layout.css    page chrome, header, tabs, responsive
panels.css    side panels (news, keyboard help)
overlays.css  modals, menus, sticky alerts
widgets.css   everything tab-specific (largest file)
```

These are contiguous slices of one former 2,261-line inline `<style>`, in its
original order. **Media queries are not collected into a trailing
"responsive" file** - 14 selectors (`.news-col`, `.modal-card`,
`.alert-stack`, `.pin-btn`, `#foot` and others) are declared inside a media
block and then again plainly further down. Media queries add no specificity,
so today the later plain rule wins; hoisting the media blocks would flip all
14.

### JS - load order is load-bearing

```
config.js     BUILD stamp, ~29 shared mutable state variables, sortConfig
alerts.js     in-page + push alerting
chrome.js     theme, header collapse, pinning, build-staleness check
news.js       news panel
signal.js     signal modal / journal
format.js     escapeHtml, fmtTime, fmtNum, fmtCompact, fmtDollar, gate,
              gradePill, surgePill, tsKey, iconMarkup
filters.js    switchTab, filtering, sorting, presets, CSV export
charts.js     canvas sparklines, the regime strip
perf.js       performance helpers
pin.js        pin/chop detector
rpc.js        Access recovery, the proxy calls, loadAll, loadAggregate
render.js     KPI cards, the three tables
premium.js    Performance tab (inline SVG charts)
volregime.js  Volume Regime tab
main.js       polling, date range, keyboard shortcuts, startup   <-- always last
```

**These are classic scripts, not modules.** Top-level `function` and `let`
share one global lexical scope, and `index.html` uses inline `onclick`
handlers that depend on it. Do not add `import`, `export`, or
`type="module"`. A new file goes in this list at the point where its
dependencies are already defined, and `main.js` stays last because it calls
the init functions.

## Adding a tab

Five places, and three of them fail *silently* if you miss them.

1. **`index.html`** - a `<div class="tab" onclick="switchTab('x')">Label</div>`
   in `.tabs`, and a `<div id="tab-x" class="tab-content">` body.
2. **`js/filters.js`, `switchTab()`** - add `'x'` to the `order` array. It is
   matched against the `.tab` elements **by index**, so a tab added to the
   markup and not here highlights the wrong heading with no error.
3. **`js/filters.js`, `switchTab()`** - if the tab loads its own data, add
   `if (name === 'x') loadX();`. Tab data is loaded on arrival, not on the
   poll.
4. **`js/main.js`** - a number key in the `keydown` switch (1-5 are taken).
5. **`js/filters.js`, `updateRowCounts()`** - so the row-count badge knows
   about it.

Then add `js/x.js` to the script list in `index.html` **with the `?v=`** and
bump the version.

If the tab needs a new RPC, add its name to `ALLOWED` in `worker.js` too, or
the proxy returns 403.

### The on-demand load pattern

Copy `loadVolRegime()` in `js/volregime.js`. It is the reference
implementation:

```js
let xRows = null, xKey = null, xLoading = false, xFailed = false;

async function loadX(force) {
  const key = currentStrategy;
  if (xLoading) return;                                  // no double-fetch
  if (!force && xKey === key && xRows) return;            // cached per strategy
  xLoading = true; xFailed = false;
  renderXLoading();                                       // a real loading state
  try {
    const [a, b] = await Promise.all([ ... ]);            // fetch together
    xKey = key;                                           // key AFTER success
    renderX();
  } catch (e) {
    if (e.name === 'AbortError') return;
    xFailed = true;                                       // distinct from "no data"
    /* show the error in the tab */
  } finally {
    xLoading = false;
  }
}
```

Three things that matter: fetch the tab's result sets **together** (rendering
half a tab reads as broken, not loading); key the cache on `currentStrategy`
so a switch refetches rather than showing SPY numbers under a QQQ heading; and
keep "failed" distinct from "empty" so the UI never asserts a fact about the
data when what happened was a failed request.

If the tab keeps a selected-row index, clamp it on reload -
`if (xSel >= xRows.length) xSel = 0;`.

## Adding a chart

There is **no chart library**. Three techniques, picked by what the chart sits
in:

| Technique | Use when | Example |
|---|---|---|
| **Inline SVG** from a template string | a standalone chart with its own box | `svgEquity()` in `js/premium.js` |
| **Styled divs** | the bar sits in a table cell that stretches with its column | the Session Flow volume column, `js/volregime.js` |
| **Canvas** | tiny, dense, redrawn often | `drawSparkline()` in `js/charts.js` |

A fixed `viewBox` inside a fluid table cell either clips or letterboxes at
every width - that is why `volregime.js` holds no SVG.

### The SVG recipe

```js
function svgThing(rows) {
  if (!rows.length) return svgEmpty(150, 'No trades in range');
  const W = 620, H = 150, PL = 44, PR = 10, PT = 12, PB = 20;
  const x = i => PL + (i / (n - 1)) * (W - PL - PR);
  const y = v => PT + (1 - (v - lo) / range) * (H - PT - PB);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
    aria-label="...a sentence stating what the chart shows and its end value...">
    ...
  </svg>`;
}
```

- `viewBox` only - **no `width`/`height` attributes**; CSS sizes it.
- `role="img"` plus an `aria-label` that reads as a sentence and names the
  actual end value, not just the chart type.
- Colours via `style="fill:var(--green)"` / `stroke:var(--line)` - **never a
  literal hex**, or the chart will not follow the theme.
- Axis labels: the extremes and zero. Three numbers, not a grid.
- `font-size="9"` for axis text, `stroke-width="2"` for the series,
  `stroke-width="1"` + `stroke-dasharray="2 3"` for gridlines, solid for zero.
- `opacity="0.12"` for an area fill under a line.
- Always return an empty-state box of the **same height**, with a message
  saying why it is empty. An empty chart that reads as "no signal today" is
  the failure mode this project cares about most.

For canvas, scale by `devicePixelRatio` and read colours through
`themeColor('--green')` (`js/charts.js`), which falls back rather than drawing
nothing when a token is missing mid-deploy.

## The token system

All in `css/tokens.css`. Light is `:root`; dark is `[data-theme="dark"]`.

### Colour

| Token | Light | Dark |
|---|---|---|
| `--bg` | `#f7f7f5` | `#0b0e11` |
| `--panel` | `#ffffff` | `#151a21` |
| `--panel2` | `#f0f0ed` | `#1b222b` |
| `--line` | `#e3e3de` | `#2a333f` |
| `--txt` | `#16181d` | `#e6edf3` |
| `--dim` | `#6a6f7a` | `#8b98a8` |
| `--green` | `#0f7a43` | `#3fb950` |
| `--red` | `#c0352b` | `#f85149` |
| `--amber` | `#8a6400` | `#d29922` |
| `--blue` | `#2563a8` | `#58a6ff` |
| `--a` / `--b` | grade A / B pill fills | |

**Accents are not shared between themes.** The dark hues fail contrast on
white, which is why an earlier light theme that overrode only the 7 surface
tokens never really worked. If you add an accent, give it a value in **both**
blocks.

Derived surface tokens exist so a theme states its surfaces once instead of
patching every rule that paints one: `--btn-hover-bg`, `--track-bg`,
`--sig-cell-bg`, `--sig-row-bg`, `--sig-hover-bg`, `--pill-fg`,
`--pill-muted-bg`, `--ov-hover`, `--ov-hover-weak`, `--date-icon-filter`,
`--pulse-green`.

Elevation: `--sh-card`, `--sh-float`, `--sh-menu`, `--sh-modal`. Light uses two
layers (a tight edge plus a wide soft lift) and no border; dark keeps a
hairline and uses elevation only to separate, because shadows read weakly on
a dark background.

### Semantic classes

`.call` / `.put` for direction, `.up` / `.dn` / `.flat` for change,
`.flowpos` / `.flowneg` for flow sign, `.muted` for de-emphasis,
`.gate-y` / `.gate-n` for pass/fail, `.pill.pA`-`.pD` for grades. Prefer these
over reaching for `--green` directly - they already carry the right token and
the right meaning.

### Type

```
--font-ui    -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif
--font-data  ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace
```

Scale: `--fs-micro` 9 / `--fs-xs` 10 / `--fs-sm` 11 / `--fs-base` 12 /
`--fs-md` 13 / `--fs-lg` 14 / `--fs-xl` 16 / `--fs-2xl` 17 /
`--fs-3xl` 20 / `--fs-4xl` 20 / `--fs-title` 22.

`--fs-cell` (12px) is **separate on purpose**: lifting the general scale makes
the chrome readable, but applying it to 21 table columns would widen every
table and cost the density that makes them scannable. A KPI is a big value over
a small label - that contrast is the whole shape of the look.

### Radii and spacing

`--r-xs` 4 / `--r-sm` 6 / `--r-md` 8 / `--r-lg` 10 / `--r-xl` 12 /
`--r-2xl` 14 / `--r-3xl` 16 / `--r-full` 50%. An irregular scale because it
grew by hand.

`--pin-w` (26px) is **load-bearing, not cosmetic**: `#tbl-vol`'s sticky Time
column is offset by exactly this value, so the two must never drift.

There is no spacing scale. Padding is literal, typically 5-8px in cells and
8-12px in cards.

## Theming

- **Light is the default.** `initTheme()` reads `localStorage['v2-theme']` and
  applies dark only on an explicit `'dark'`.
- Dark is `data-theme="dark"` on `<html>`; light is the **absence** of the
  attribute, not `data-theme="light"`.
- There is **no `prefers-color-scheme` handling** anywhere. The OS preference
  is ignored by design - the toggle (`T`) is the only input.
- `applyTheme()` also updates the `<meta name="theme-color">` tag and swaps the
  toggle's icon to name the theme you would switch **to**.

Because colours are tokens, a theme switch needs no redraw - which is why
`js/pin.js` and the aggregate card keep RPC rows raw and evaluate at render
time rather than caching computed colours.

## Patterns worth copying

**Render guard.** Every top-level render function is a thin wrapper:

```js
function renderThing(rows) {
  try { _renderThingInner(rows); }
  catch (e) {
    console.error('renderThing error:', e);
    document.getElementById('err').innerHTML +=
      `<div class="err">Thing render error: ${escapeHtml(e.message)}</div>`;
  }
}
```

One broken card must not take the page down. Follow the `renderX` /
`_renderXInner` naming.

**Escape everything.** All rendering is template strings into `innerHTML`.
`escapeHtml()` from `format.js` goes around every interpolated value that came
from the database. `worker.js` has its own `tgEscape()` for Telegram HTML - a
stray `&` in a reason string would make the whole message fail to send.

**One writer per piece of state.** The phone renders a second set of chips for
the grade and symbol filters (the desktop filter row is `display:none` under
700px), so both views are repainted from the variable, never from each other -
see `syncGradeChips()` / `syncSymChips()`.

**Sessions, not calendar days.** `prevSessionDate()` in `main.js` steps back
over weekends: "Yesterday" on a Monday must not resolve to Sunday. Market
holidays are deliberately not guessed - an honest empty state beats a wrong
date.

**localStorage keys** are all `v2-`prefixed (`v2-theme`, `v2-pinned-flow`,
`v2-pinned-vol`, `v2-sticky-alerts`, ...) and every read and write is wrapped
in `try {} catch (e) {}`.

**Keyboard shortcuts**: `R` refresh, `1`-`5` tabs, `T` theme, `H` header,
`S` sound, `D` cycle date preset, `Esc` dismiss/clear, `?` help panel.
Suppressed while typing in an input and while the modal is open.

## Accessibility

Keep up what is already there: `role="img"` + `aria-label` on charts,
`aria-busy` on the refresh button during load, `aria-pressed` on filter chips
(and deliberately **not** on the theme toggle - it is a mode, not an on/off,
so "pressed" would have no honest value), icon buttons carrying a text label,
`env(safe-area-inset-*)` padding for the notch.
