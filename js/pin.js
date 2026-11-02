/* pin.js - Pin / Chop Day detector.

   Split out rather than added to render.js because the rule thresholds want to
   be readable in one screen, and because evalPin() is called from three
   places: the live card, the history table and (as the same arithmetic,
   re-expressed) sql/pin_backtest.sql. These are CLASSIC scripts, not modules:
   this file loads after format.js (it uses escapeHtml) and before render.js
   (which calls signalWallFlag). Load order is load-bearing.

   WHY THIS EXISTS. On 2026-10-29 SPY traded a 3.69-point range between a call
   wall at 770 and a put wall at 768. Six alerts fired; the five pointing into
   the nearest wall lost and the one pointing away won. Nothing at the open
   flagged it - the wall gap was 1-3 points on most sessions that month, and
   VIX1D and the implied move looked ordinary. It was only visible once price
   had touched both walls without breaking either.

   WHAT THE BACKTEST SAID, because it decides what ships switched on. Over the
   20 sessions from 2026-10-02 and 129 SPY alerts, INTO WALL won 37.6% against
   AWAY FROM WALL's 46.4% - but INTO WALL's average P&L was the better of the
   two. Win rate and P&L disagreeing is what no edge looks like. Scoring each
   alert by the detector's reading at the moment it fired, the wall flag still
   does not separate P&L: inside PIN CONFIRMED, INTO WALL ran +0.011 over 50
   alerts against AWAY FROM WALL's -0.215 over 13 - the opposite sign to the
   hypothesis. On QQQ there was a single pin day in the month and the two
   flags were indistinguishable. So PIN_BADGES_ENABLED ships false.

   WHAT DID SHOW UP, unasked for and with the sign reversed: the status itself
   sorted the alerts. Fired while the detector read NO PIN, INTO WALL alerts
   won 25.5% of 47; fired while it read PIN CONFIRMED, 46.0% of 50. Pinning
   sessions were the better ones to trade, not the worse ones. Two samples of
   about fifty is worth something, one month is not worth much, and nothing
   here was predicted in advance - so the card reports and does not advise.
   Re-run sql/pin_backtest.sql before drawing a conclusion from it.
   ══════════════════════════════════════════════════════ */

    /* ── TUNABLE CONSTANTS ──
       Every number the detector judges by lives here. sql/pin_backtest.sql
       repeats them in its own preamble; change both together or the backtest
       stops describing the thing on screen. */

    /* Rule 1 - walls stable. Each wall may drift this far from where it stood
       at PIN_STABLE_FROM, and the gap between them may be this wide. This rule
       does nearly all the discriminating work: on the 20 sessions measured it
       alone picked out 10-13, 10-28 and 10-29.

       The drift allowance USED TO BE a flat 1 strike. It is now a share of the
       session's expected move, because a flat count tuned on SPY disqualified
       QQQ on 18 of 19 sessions - see the note below PIN_GAP_MAX, which records
       that QQQ fails on drift and not on gap. PIN_DRIFT_FLOOR keeps the old
       value as a lower bound, so the rule can only ever LOOSEN: a session that
       reads stable today cannot start reading unstable because of this change.
       That makes the SPY regression test a one-way check - pin days may be
       added, never removed. */
    const PIN_GAP_MAX         = 3;      // points, call_wall - put_wall
    const PIN_DRIFT_FLOOR     = 1;      // points, the pre-normalization value

    /* Which volatility reading the allowance scales with. 'vix1d' or 'impl'.
       Both are computed either way and both are returned, so switching this
       changes only which one gates the status - and sql/pin_backtest.sql
       section 8 reports the two side by side over the same sessions.

       'vix1d' WAS MEASURED AND REJECTED - do not switch back without re-running
       section 8. VIX1D is market-wide: only the SPY feed carries it and
       v2_pin_series_by_strategy coalesces that one value onto every symbol's
       rows, so the number is IDENTICAL on SPY and QQQ and the only thing left
       separating them is price level. Over 2026-10-02..10-29 that put the
       expected move at 4.00 on QQQ against 4.26 on SPY - it ranks QQQ as the
       CALMER symbol, while the same sessions' implied move says QQQ is 5.60
       against SPY's 4.24, or 32% more volatile. The two disagree in direction,
       so no choice of PIN_DRIFT_K rescues 'vix1d'; it is not mis-tuned, it is
       measuring the wrong thing. It also floored to PIN_DRIFT_FLOOR on every
       session of both symbols and added exactly zero pin days.

       'impl' is what shipped. On the same sessions it is an exact no-op on SPY
       (3 pin days before and after, none added) and allows 1.40 on QQQ against
       SPY's 1.06, which is the per-symbol separation this change exists for.
       It added one QQQ day, range 4.74 against a pin-day average of 3.27 and
       below QQQ's own implied move - a defensible pin by the standard that
       rejected the mode-share alternative, not a 12-point session.

       Note what that does NOT amount to: QQQ went from 1 pin day to 2 out of
       19. Drift was necessary and nowhere near sufficient. Section 9 is the
       query that asks what QQQ is really failing. */
    const PIN_VOL_ANCHOR      = 'impl';

    /* Expected 1-day move in points, from an annualized vol percentage:
         price * (vix1d / 100) / sqrt(252)
       252 trading days, so sqrt(252) = 15.87. */
    const PIN_TRADING_DAYS_SQRT = 15.87;

    /* Share of the expected move each wall may drift across. Both are set so
       that a typical SPY session reproduces the old flat 1 point, which is
       what makes this a no-op on the sessions the existing result rests on:
         vix1d: SPY 770 at VIX1D 13 -> 770*0.13/15.87 = 6.31 pts, * 0.16 = 1.01
         impl:  SPY implied move averaged 4.01 over October,      * 0.25 = 1.00
       Re-derive both if the median VIX1D or the implied move moves materially;
       they are calibration, not theory. */
    const PIN_DRIFT_K         = 0.16;   // share of expPts, 'vix1d' anchor
    const PIN_DRIFT_K_IMPL    = 0.25;   // share of impl_move, 'impl' anchor

    /* The gap limit is an absolute point count tuned on SPY, and QQQ moves
       wider - 6.03 average implied move against SPY's 4.01 - so it was worth
       asking whether it should be a fraction of the implied move instead.
       Section 6 of sql/pin_backtest.sql says no: judged at the close the
       proportional gap picks exactly the same days, because the gap is not
       what QQQ fails on. QQQ fails on DRIFT, on 18 of 19 sessions - its walls
       move 3.79 / 4.00 strikes on average against SPY's 2.65 / 2.70. The
       obvious loosening, a mode-share test in place of the min-max spread,
       buys QQQ two more pin days whose ranges were 12.54 and 11.41 points,
       which is not what the word pin means. Left alone deliberately. */

    /* Rule 2 - a wall counts as tested when price came this close to it. */
    const PIN_TEST_TOL        = 0.5;    // points

    /* Rule 3 - containment. DIAGNOSTIC ONLY, deliberately not in the status.
       As specified this gated PIN CONFIRMED, and it was false on 19 of the 20
       sessions measured - including 10-29, the day the panel was built for.
       The cause is structural rather than a bad threshold: the wall gap is
       1-3 points while the session's range runs 2-8, so price leaves the band
       almost every day. On 10-29 it reached 766.78 against a put wall of 768.
       The card shows the breach and its size instead of hiding the day. */
    const PIN_CONTAIN_TOL     = 0.75;   // points beyond a wall

    /* Rule 4 - flow chop. DIAGNOSTIC ONLY, and it never was in the status
       formula. Over those same sessions divergence_flow changed sign between
       11 and 33 times after 10:00, never once near this threshold, so it
       separates nothing. Kept because the count itself is worth a glance. */
    const PIN_FLOW_FLIPS_MIN  = 4;

    /* Session cut-offs, NY wall clock. The drift window opens at 09:55 and not
       at the open on purpose: the walls reprice hard in the first few candles,
       and anchoring at 09:35 marks every session unstable. */
    const PIN_STABLE_FROM     = '09:55';
    const PIN_TEST_FROM       = '09:35';
    const PIN_FLOW_FROM       = '10:00';

    /* These anchor the windows at a wall-clock time rather than trailing the
       current candle, which means a session that settles into a pin after
       lunch is disqualified by its morning. Section 7 of pin_backtest.sql
       tried the trailing version and it is worse: as a day classifier it is
       true on 18 of 20 SPY sessions and the days it picks average exactly
       the same range as every other day, and per alert the 60-minute window
       underperforms no rule at all in both halves of the session while the
       90-minute window disagrees with it. Anchored stays. */

    /* How near a wall an alert has to point for INTO WALL. Note this makes
       AWAY FROM WALL mean "not into a wall", so it also covers an alert
       sitting mid-range with neither wall within reach. The backtest used the
       same definition, so the two agree. */
    const PIN_SIGNAL_WALL_TOL = 1.0;    // points

    /* The history table's columns, and how many sessions it reaches back. */
    const PIN_HISTORY_CUTOFFS = ['10:30', '11:30', '13:00'];
    const PIN_HISTORY_DAYS    = 10;

    /* Off until the sample is worth acting on - see the header. Flipping this
       to true is the whole switch: the card does not depend on it. */
    const PIN_BADGES_ENABLED  = false;

    /* ── TIME HELPERS ──
       candle_time_ny arrives as timestamp from some RPCs and timestamptz from
       others - the mismatch that once silently killed the surge pills, see the
       note above tsKey() in format.js. Everything here goes through tsKey()
       first so a zone suffix can never change a comparison. */

    function pinHHMM(ts) {
      const k = tsKey(ts);
      return k.length >= 16 ? k.slice(11, 16) : '';
    }

    function pinDay(ts) {
      const k = tsKey(ts);
      return k.length >= 10 ? k.slice(0, 10) : '';
    }

    const pinNum = v => (v == null || v === '' || isNaN(+v)) ? null : +v;

    /* ══════════════════════════════════════════════════════
       THE DETECTOR

       One pure function over one session's candles, so the live card, each
       history column and the backtest cannot drift apart. rows must be a
       single trade_date's series in time order; cutoff is 'HH:MM' or null for
       the whole session.
       ══════════════════════════════════════════════════════ */
    function evalPin(rows, cutoff) {
      if (!rows || !rows.length) return null;

      const seen = cutoff
        ? rows.filter(r => pinHHMM(r.candle_time_ny) <= cutoff)
        : rows.slice();
      if (!seen.length) return null;

      const latest = seen[seen.length - 1];
      const callWall = pinNum(latest.call_wall);
      const putWall  = pinNum(latest.put_wall);
      const price    = pinNum(latest.price);

      /* Rule 1 - wall drift since PIN_STABLE_FROM, measured as the spread of
         each wall's own values rather than first-versus-last: a wall that
         steps away and back is not stable, and last-minus-first would call it
         so. */
      const stable = seen.filter(r => pinHHMM(r.candle_time_ny) >= PIN_STABLE_FROM);
      const cwVals = stable.map(r => pinNum(r.call_wall)).filter(v => v != null);
      const pwVals = stable.map(r => pinNum(r.put_wall)).filter(v => v != null);
      const cwDrift = cwVals.length ? Math.max(...cwVals) - Math.min(...cwVals) : null;
      const pwDrift = pwVals.length ? Math.max(...pwVals) - Math.min(...pwVals) : null;
      const gap = (callWall != null && putWall != null) ? +(callWall - putWall).toFixed(2) : null;

      /* The drift allowance is read ONCE, off the PIN_STABLE_FROM candle, and
         not off `latest`. Anchoring it to the start of the same window the
         drift is measured over is the whole point: a threshold that tracked
         the current candle would let a status flip because volatility moved
         rather than because the walls did, and the card would contradict
         itself between two polls with identical walls.

         stable[] is already the window, so its first element IS that candle -
         or undefined before 09:55, in which case every drift value is null and
         wallsStable is false regardless. */
      const anchor      = stable.length ? stable[0] : null;
      const anchorPrice = anchor ? pinNum(anchor.price) : null;
      const anchorVix   = anchor ? pinNum(anchor.vix1d) : null;
      const anchorImpl  = anchor ? pinNum(anchor.impl_move) : null;

      /* Null vol falls through to the floor rather than to NaN. That is the
         live case on QQQ whenever the SPY coalesce in the RPC misses, and a
         NaN comparison is false, which would silently mark every session
         unstable instead of degrading to the old flat rule. */
      const expPts = (anchorPrice != null && anchorVix != null)
        ? +(anchorPrice * (anchorVix / 100) / PIN_TRADING_DAYS_SQRT).toFixed(2)
        : null;
      const driftMaxVix  = expPts == null
        ? PIN_DRIFT_FLOOR
        : Math.max(PIN_DRIFT_FLOOR, +(PIN_DRIFT_K * expPts).toFixed(2));
      const driftMaxImpl = anchorImpl == null
        ? PIN_DRIFT_FLOOR
        : Math.max(PIN_DRIFT_FLOOR, +(PIN_DRIFT_K_IMPL * anchorImpl).toFixed(2));
      const driftMax = PIN_VOL_ANCHOR === 'impl' ? driftMaxImpl : driftMaxVix;

      const wallsStable = cwDrift != null && pwDrift != null && gap != null
        && cwDrift <= driftMax
        && pwDrift <= driftMax
        && gap <= PIN_GAP_MAX;

      /* Rules 2 and 3 - both measured against each candle's own walls, as
         specified. With rule 1 holding the walls still the distinction from a
         fixed reference is small, and the per-candle reading is the honest
         one: it asks whether price reached the wall that was there at the
         time. */
      const tested = seen.filter(r => pinHHMM(r.candle_time_ny) >= PIN_TEST_FROM);
      let testedCallAt = null, testedPutAt = null, maxBreach = null;

      tested.forEach(r => {
        const p = pinNum(r.price), cw = pinNum(r.call_wall), pw = pinNum(r.put_wall);
        if (p == null) return;
        if (testedCallAt == null && cw != null && Math.abs(p - cw) <= PIN_TEST_TOL) {
          testedCallAt = pinHHMM(r.candle_time_ny);
        }
        if (testedPutAt == null && pw != null && Math.abs(p - pw) <= PIN_TEST_TOL) {
          testedPutAt = pinHHMM(r.candle_time_ny);
        }
        const breach = Math.max(
          cw == null ? -Infinity : p - cw,
          pw == null ? -Infinity : pw - p
        );
        if (breach > -Infinity && (maxBreach == null || breach > maxBreach)) maxBreach = breach;
      });

      /* Rule 4 - sign changes in divergence_flow. Zero-flow candles are
         skipped rather than counted as a side, so a flat candle between two
         positives is not two flips. */
      let flips = 0, prevSign = 0;
      seen.forEach(r => {
        if (pinHHMM(r.candle_time_ny) < PIN_FLOW_FROM) return;
        const f = pinNum(r.divergence_flow);
        if (f == null || f === 0) return;
        const sg = f > 0 ? 1 : -1;
        if (prevSign !== 0 && sg !== prevSign) flips++;
        prevSign = sg;
      });

      const prices = seen.map(r => pinNum(r.price)).filter(v => v != null);
      const dayRange = prices.length ? +(Math.max(...prices) - Math.min(...prices)).toFixed(2) : null;

      /* Containment and the flip count are reported, not gated on - see the
         PIN_CONTAIN_TOL comment. Status is rule 1 plus how many walls were
         tested. */
      const nTested = (testedCallAt ? 1 : 0) + (testedPutAt ? 1 : 0);
      const status = (wallsStable && nTested === 2) ? 'PIN CONFIRMED'
                   : (wallsStable && nTested === 1) ? 'PIN FORMING'
                   : 'NO PIN';

      return {
        status, tradeDate: pinDay(latest.candle_time_ny), at: pinHHMM(latest.candle_time_ny),
        callWall, putWall, price, gap, cwDrift, pwDrift, wallsStable,
        /* driftMax is the allowance actually applied; the other three are the
           workings, kept so the card can show them and so section 8 of
           pin_backtest.sql can be reconciled against the live reading rather
           than trusted to agree. */
        driftMax, driftMaxVix, driftMaxImpl, expPts,
        testedCallAt, testedPutAt,
        maxBreach: maxBreach == null ? null : +maxBreach.toFixed(2),
        contained: maxBreach != null && maxBreach <= PIN_CONTAIN_TOL,
        flips, choppy: flips >= PIN_FLOW_FLIPS_MIN,
        dayRange, implMove: pinNum(latest.impl_move),
        vix1d: pinNum(latest.vix1d), tick: pinNum(latest.tick),
        candles: seen.length
      };
    }

    /* Group a multi-day series into { 'YYYY-MM-DD': [rows] }, time-ordered.
       The RPC already returns ordered rows; sorted again so a paged fetch
       that stitched two pages out of order cannot shift a status. */
    function pinGroupByDay(series) {
      const by = {};
      (series || []).forEach(r => {
        const d = pinDay(r.candle_time_ny);
        if (!d) return;
        (by[d] = by[d] || []).push(r);
      });
      Object.keys(by).forEach(d => by[d].sort(
        (a, b) => tsKey(a.candle_time_ny) < tsKey(b.candle_time_ny) ? -1 : 1));
      return by;
    }

    /* ══════════════════════════════════════════════════════
       SIGNAL BADGES

       Attached inside the existing status cell by renderFlow(), NOT as a new
       column. Flow-table column order is load-bearing in four places -
       applyFlowFilters() reads cells by index, applySort() reorders by column
       number, the CSV export walks the DOM and updateRowCounts() counts cells
       - so a new <td> would break sorting, filtering and export at once. See
       the warning above the table in index.html.
       ══════════════════════════════════════════════════════ */

    /* candle_time_ny -> that candle's session row, rebuilt whenever the series
       is replaced. A map rather than a scan per row: renderFlow() runs over
       every candle on every 10s poll. */
    let pinByTs = {};

    function pinIndexSeries(series) {
      pinByTs = {};
      (series || []).forEach(r => { pinByTs[tsKey(r.candle_time_ny)] = r; });
    }

    /* Status as of each candle, not as of the close.

       The badge has to answer "was this a pin when the alert fired", and the
       session's closing status cannot answer it: on a day that only pins after
       lunch, classifying the 10:00 alerts by the 16:00 reading would badge
       them with information that did not exist yet. That is lookahead, and it
       would flatter exactly the numbers used to decide whether to trust the
       badge at all. Precomputed per candle because renderFlow() runs over the
       whole session on every 10s poll. */
    let pinStatusByTs = {};

    function pinIndexStatus(series) {
      pinStatusByTs = {};
      const byDay = pinGroupByDay(series);
      Object.keys(byDay).forEach(d => {
        const rows = byDay[d];
        rows.forEach(r => {
          const st = evalPin(rows, pinHHMM(r.candle_time_ny));
          if (st) pinStatusByTs[tsKey(r.candle_time_ny)] = st.status;
        });
      });
    }

    /* The badges for one flow row. Returns '' unless the feature is on, so
       leaving PIN_BADGES_ENABLED false costs renderFlow() one boolean. */
    function signalWallFlag(x) {
      if (!PIN_BADGES_ENABLED) return '';
      if (!x || !x.has_signal) return '';
      if (x.direction !== 'CALL' && x.direction !== 'PUT') return '';

      const row = pinByTs[tsKey(x.candle_time_ny)];
      if (!row) return '';

      const price = pinNum(row.price);
      const wall  = pinNum(x.direction === 'CALL' ? row.call_wall : row.put_wall);
      if (price == null || wall == null) return '';

      const into = Math.abs(price - wall) <= PIN_SIGNAL_WALL_TOL;
      const dist = Math.abs(price - wall).toFixed(2);
      let out = into
        ? `<span class="wall-pill wall-into" title="${escapeHtml(x.direction)} fired ${escapeHtml(dist)} from the ${x.direction === 'CALL' ? 'call' : 'put'} wall">INTO WALL</span>`
        : `<span class="wall-pill wall-away" title="Nearest wall in this direction is ${escapeHtml(dist)} away">AWAY FROM WALL</span>`;

      const st = pinStatusByTs[tsKey(x.candle_time_ny)];
      if (st === 'PIN CONFIRMED' || st === 'PIN FORMING') {
        out += ` <span class="wall-pill pin-pill" title="Detector read ${escapeHtml(st)} when this alert fired">PIN DAY</span>`;
      }
      return ' ' + out;
    }

    /* ══════════════════════════════════════════════════════
       THE CARD
       ══════════════════════════════════════════════════════ */

    const PIN_PILL_CLASS = {
      'PIN CONFIRMED': 'pin-state-confirmed',
      'PIN FORMING':   'pin-state-forming',
      'NO PIN':        'pin-state-none'
    };

    function renderPinCard() {
      const host = document.getElementById('pin-card');
      if (!host) return;

      /* The series is one strategy's. In "Today's Alerts" the table holds
         several symbols at once, so a single pair of wall levels would be
         wrong for most rows - the same reason loadAggregate() empties
         anomalyMap and volMap. The badges stay off there for exactly that
         reason, but the status is per-symbol and perfectly sayable, so that
         view gets a row each instead of nothing. */
      if (isAggregate()) { renderPinAgg(host); return; }

      const byDay = pinGroupByDay(pinSeries);
      const days = Object.keys(byDay).sort();
      if (!days.length) { host.style.display = 'none'; host.innerHTML = ''; return; }

      const day = days[days.length - 1];
      const rows = byDay[day];
      const st = evalPin(rows, null);
      if (!st) { host.style.display = 'none'; host.innerHTML = ''; return; }

      host.style.display = '';

      const pillCls = PIN_PILL_CLASS[st.status] || 'pin-state-none';
      const f2 = v => v == null ? '-' : (+v).toFixed(2);
      const f0 = v => v == null ? '-' : String(+v);

      const testedBits = [];
      testedBits.push(st.testedCallAt
        ? `call wall at ${escapeHtml(st.testedCallAt)}`
        : 'call wall untested');
      testedBits.push(st.testedPutAt
        ? `put wall at ${escapeHtml(st.testedPutAt)}`
        : 'put wall untested');

      /* Range so far against the implied move: the pin case is a session that
         has used up far less of its expected range than the clock suggests. */
      const rangePct = (st.dayRange != null && st.implMove)
        ? Math.round(100 * st.dayRange / st.implMove) : null;

      /* Containment is shown either way. "Held" is the clean case; otherwise
         say how far out price actually closed, because that number is what
         made the rule unusable as a gate. */
      const containTxt = st.maxBreach == null ? '-'
        : st.contained
          ? `held (max ${f2(st.maxBreach)})`
          : `broke by ${f2(st.maxBreach - PIN_CONTAIN_TOL)} (max ${f2(st.maxBreach)})`;

      host.innerHTML = `
      <div class="pin-strip">
        <div class="pin-head">
          <span class="panel-title"><svg class="ico"><use href="#ic-gauge"></use></svg>Pin / Chop</span>
          <span class="pin-state ${pillCls}">${escapeHtml(st.status)}</span>
          <span class="pin-asof">${escapeHtml(day)} · ${escapeHtml(st.at)} NY · ${f0(st.candles)} candles</span>
        </div>

        <div class="pin-levels">
          <div class="pin-lv"><div class="label">Call Wall</div><div class="val pin-cw">${f2(st.callWall)}</div></div>
          <div class="pin-lv"><div class="label">Price</div><div class="val">${f2(st.price)}</div></div>
          <div class="pin-lv"><div class="label">Put Wall</div><div class="val pin-pw">${f2(st.putWall)}</div></div>
          <div class="pin-lv"><div class="label">Gap</div><div class="val">${f2(st.gap)}</div></div>
        </div>

        <div class="pin-chart">${pinChartSvg(rows, st)}</div>

        <div class="pin-facts">
          <div class="pin-fact"><span class="label">Walls since ${escapeHtml(PIN_STABLE_FROM)}</span>
            <span>${st.wallsStable ? 'stable' : 'moved'} · call ${f2(st.cwDrift)}, put ${f2(st.pwDrift)} of ${f2(st.driftMax)} allowed${st.driftMax <= PIN_DRIFT_FLOOR ? ' (floor)' : ''}</span></div>
          <div class="pin-fact"><span class="label">Drift allowance</span>
            <span>${escapeHtml(PIN_VOL_ANCHOR)} · ${st.expPts == null ? 'no vix1d' : `${f2(st.expPts)} pts expected`} · impl would allow ${f2(st.driftMaxImpl)}</span></div>
          <div class="pin-fact"><span class="label">Tested</span>
            <span>${testedBits.join(' · ')}</span></div>
          <div class="pin-fact"><span class="label">Range so far</span>
            <span>${f2(st.dayRange)} vs ${f2(st.implMove)} implied${rangePct == null ? '' : ` · ${f0(rangePct)}%`}</span></div>
          <div class="pin-fact"><span class="label">Contained (${escapeHtml(String(PIN_CONTAIN_TOL))})</span>
            <span>${escapeHtml(containTxt)}</span></div>
          <div class="pin-fact"><span class="label">Flow sign flips</span>
            <span>${f0(st.flips)}${st.choppy ? ' · choppy' : ''}</span></div>
        </div>

        <div class="pin-hist-wrap">
          <button class="pin-hist-toggle" onclick="togglePinHistory()">
            ${pinHistory ? 'Hide' : 'Show'} recent sessions
          </button>
          <div id="pin-hist-body">${pinHistory ? pinHistoryTable() : ''}</div>
        </div>
      </div>`;
    }

    /* ══════════════════════════════════════════════════════
       THE AGGREGATE CARD — one line per strategy

       "Today's Alerts" is the view most of the session is spent on, so the
       detector has to be readable from there too. What it cannot show is the
       single-symbol card: two symbols' walls in one pair of level readouts
       would be wrong for whichever symbol is not SPY. So each strategy gets
       its own line with its own status, and the chart and the history table
       are left to the per-strategy view - five charts stacked above the table
       would cost more height than the alerts they sit on top of.
       ══════════════════════════════════════════════════════ */
    function renderPinAgg(host) {
      const list = (pinAgg || []).map(p => {
        const byDay = pinGroupByDay(p.rows);
        const days = Object.keys(byDay).sort();
        if (!days.length) return null;
        const day = days[days.length - 1];
        return { ...p, day, st: evalPin(byDay[day], null) };
      }).filter(p => p && p.st);

      if (!list.length) { host.style.display = 'none'; host.innerHTML = ''; return; }
      host.style.display = '';

      const f2 = v => v == null ? '-' : (+v).toFixed(2);

      /* Pinning symbols first, then by label, so the one worth knowing about
         is the one at the top rather than wherever the registry put it. */
      const rank = { 'PIN CONFIRMED': 0, 'PIN FORMING': 1, 'NO PIN': 2 };
      list.sort((a, b) => (rank[a.st.status] - rank[b.st.status])
        || String(a.label).localeCompare(String(b.label)));

      const pinning = list.filter(p => p.st.status !== 'NO PIN');
      const head = pinning.length
        ? pinning.map(p => escapeHtml(p.label)).join(', ') + ' pinning'
        : 'no symbol pinning';

      const latest = list[0];

      const rows = list.map(p => {
        const st = p.st;
        const tested = [
          st.testedCallAt ? `call ${escapeHtml(st.testedCallAt)}` : 'call untested',
          st.testedPutAt ? `put ${escapeHtml(st.testedPutAt)}` : 'put untested'
        ].join(' · ');
        return `
        <div class="pin-agg-row">
          <span class="pin-agg-sym">${escapeHtml(p.label)}</span>
          <span class="pin-state ${PIN_PILL_CLASS[st.status] || 'pin-state-none'}">${escapeHtml(st.status)}</span>
          <span class="pin-agg-lv">
            <span class="pin-cw">${f2(st.callWall)}</span> /
            <span class="pin-pw">${f2(st.putWall)}</span>
            <span class="muted">gap ${f2(st.gap)}</span>
          </span>
          <span class="pin-agg-note">${f2(st.price)} now · ${escapeHtml(tested)} · range ${f2(st.dayRange)}</span>
        </div>`;
      }).join('');

      host.innerHTML = `
      <div class="pin-strip pin-strip-agg">
        <div class="pin-head">
          <span class="panel-title"><svg class="ico"><use href="#ic-gauge"></use></svg>Pin / Chop</span>
          <span class="pin-asof">${escapeHtml(latest.day)} · ${escapeHtml(latest.st.at)} NY · ${escapeHtml(head)}</span>
        </div>
        <div class="pin-agg">${rows}</div>
      </div>`;
    }

    /* ══════════════════════════════════════════════════════
       CHART

       Inline SVG inside the same template string, the approach premium.js
       settled on for its equity curve: it composes into the markup, so it
       cannot silently render blank the way a canvas does when the draw call
       lands before the element exists. Colours are var() references, so the
       theme switch needs no redraw - canvas cannot read var() at all, which
       is why charts.js has to resolve tokens by hand.
       ══════════════════════════════════════════════════════ */
    function pinChartSvg(rows, st) {
      const pts = rows.map(r => pinNum(r.price));
      const have = pts.filter(v => v != null);
      if (have.length < 2) return '<div class="pin-nochart muted">Not enough candles to plot</div>';

      const W = 620, H = 120, padT = 8, padB = 8;

      /* The walls are part of the scale, not overlaid on it: a wall just off
         the top of the plot is the one case the card exists to show. */
      const cand = have.concat([st.callWall, st.putWall].filter(v => v != null));
      let lo = Math.min(...cand), hi = Math.max(...cand);
      if (hi - lo < 0.01) { hi += 0.5; lo -= 0.5; }
      const pad = (hi - lo) * 0.08;
      lo -= pad; hi += pad;

      /* Inset by the marker radius at both ends: a wall tested on the first
         or last candle of the session puts its dot exactly on the frame, and
         half of it renders outside the viewBox. */
      const padX = 5;
      const x = i => padX + (i / (rows.length - 1)) * (W - 2 * padX);
      const y = v => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);

      /* Gaps are broken rather than bridged - a straight line across a data
         hole reads as a quiet tape instead of a missing one. */
      const segs = [];
      let cur = [];
      rows.forEach((r, i) => {
        const v = pinNum(r.price);
        if (v == null) { if (cur.length > 1) segs.push(cur); cur = []; return; }
        cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
      });
      if (cur.length > 1) segs.push(cur);

      const line = segs.map(s =>
        `<polyline points="${s.join(' ')}" fill="none" stroke-width="1.6" style="stroke:var(--blue)" />`).join('');

      const wallLine = (v, cls, label) => {
        if (v == null) return '';
        const yy = y(v).toFixed(1);
        return `<line x1="0" y1="${yy}" x2="${W}" y2="${yy}" stroke-width="1.2"
                  stroke-dasharray="5 4" style="stroke:var(${cls})" />
                <text x="4" y="${(+yy - 3).toFixed(1)}" style="fill:var(${cls})"
                  font-size="10">${escapeHtml(label)} ${(+v).toFixed(2)}</text>`;
      };

      /* Markers sit on the candle that first came within PIN_TEST_TOL, which
         is the moment the status could have changed - the timestamps in the
         facts row name the same two candles. */
      const marker = (hhmm, cls) => {
        if (!hhmm) return '';
        const i = rows.findIndex(r => pinHHMM(r.candle_time_ny) === hhmm);
        if (i < 0) return '';
        const v = pinNum(rows[i].price);
        if (v == null) return '';
        return `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.4"
                  style="fill:var(${cls})"><title>Tested ${escapeHtml(hhmm)} at ${v.toFixed(2)}</title></circle>`;
      };

      /* Scaled uniformly, so the SVG keeps the viewBox's 620x120 ratio and the
         CSS gives it width only. preserveAspectRatio="none" would let it fill
         a fixed height, but non-uniform scaling turns the tested-wall dots
         into ellipses, and the dots are the part worth looking at. */
      return `<svg viewBox="0 0 ${W} ${H}"
                role="img" aria-label="Session price against both walls">
        ${wallLine(st.callWall, '--red', 'CW')}
        ${wallLine(st.putWall, '--green', 'PW')}
        ${line}
        ${marker(st.testedCallAt, '--red')}
        ${marker(st.testedPutAt, '--green')}
      </svg>`;
    }

    /* ══════════════════════════════════════════════════════
       HISTORY TABLE

       Fetched on demand and kept, rather than joining the 10s poll: it is the
       same RPC over ten sessions, it does not change during a session, and
       paying for it every tick to render a panel that is collapsed by default
       would be the dashboard's most expensive idle call.
       ══════════════════════════════════════════════════════ */
    async function togglePinHistory() {
      if (pinHistory) { pinHistory = null; renderPinCard(); return; }

      const body = document.getElementById('pin-hist-body');
      if (body) body.innerHTML = '<div class="muted">Loading sessions...</div>';

      try {
        const end = pinSeries && pinSeries.length
          ? pinDay(pinSeries[pinSeries.length - 1].candle_time_ny)
          : todayStr();
        /* Calendar days back, not sessions: the RPC returns only days that
           have candles, so a fortnight of calendar covers ten sessions with
           room for holidays. */
        const start = new Date(end + 'T00:00:00');
        start.setDate(start.getDate() - PIN_HISTORY_DAYS * 2);
        const startStr = start.toISOString().slice(0, 10);

        const rows = await rpcWithRetry('v2_pin_series_by_strategy', null,
          { p_start: startStr, p_end: end, p_strategy: currentStrategy }, 1);

        pinHistory = pinGroupByDay(rows);
        renderPinCard();
      } catch (e) {
        if (body) body.innerHTML = `<div class="muted">Could not load sessions: ${escapeHtml(e.message)}</div>`;
      }
    }

    function pinHistoryTable() {
      const days = Object.keys(pinHistory || {}).sort().reverse().slice(0, PIN_HISTORY_DAYS);
      if (!days.length) return '<div class="muted">No sessions in range</div>';

      const head = PIN_HISTORY_CUTOFFS.map(c => `<th>${escapeHtml(c)}</th>`).join('');

      const body = days.map(d => {
        const rows = pinHistory[d];
        const cells = PIN_HISTORY_CUTOFFS.map(c => {
          const st = evalPin(rows, c);
          if (!st) return '<td class="muted">-</td>';
          const short = st.status === 'PIN CONFIRMED' ? 'CONF'
                      : st.status === 'PIN FORMING' ? 'FORM' : '-';
          return `<td class="${PIN_PILL_CLASS[st.status] || ''}" title="${escapeHtml(st.status)}">${short}</td>`;
        }).join('');

        const full = evalPin(rows, null);
        return `<tr>
          <td class="col-time">${escapeHtml(d)}</td>
          ${cells}
          <td>${full && full.dayRange != null ? full.dayRange.toFixed(2) : '-'}</td>
          <td class="muted">${full && full.implMove != null ? full.implMove.toFixed(2) : '-'}</td>
        </tr>`;
      }).join('');

      return `<table class="pin-hist">
        <thead><tr><th>Session</th>${head}<th>Range</th><th>Implied</th></tr></thead>
        <tbody>${body}</tbody>
      </table>`;
    }
