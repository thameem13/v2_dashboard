/* premium.js - the Performance tab
   Split from index.html. These are CLASSIC scripts, not modules:
   top-level let/const share one global lexical scope, so the
   mutable state variables and the inline onclick handlers keep
   working exactly as before. Load order is load-bearing. */
    /* ══════════════════════════════════════════════════════
       PERFORMANCE TAB

       One tab, two measures of the same signals:

         PREMIUM P&L  what the contract actually paid. Buy the POC strike,
                      next-day expiry, at the ask; walk the session forward
                      through the 5-minute chain snapshots; exit on the first
                      touch of the target or the stop, sold at the bid.
                      Real money - but only as far back as premium collection.

         DIRECTION    whether the underlying went the way the signal called,
                      in SPY points, over the FULL signal history. A much
                      bigger sample, but it does not know about spread,
                      theta, or what you would actually have been filled at.

       They are shown side by side rather than merged into one number,
       because they cover different date ranges and different universes
       (direction is ALERTED-only; premium is every graded candle). Each
       group carries its own N so the two can never be read as one sample.
       ══════════════════════════════════════════════════════ */

    /* Below this many RESOLVED trades a bucket is marked as too small to read.
       At today's sample that is every bucket, which is the correct and
       intended result - not a bug to tune away. */
    const PREM_MIN_N = 20;

    /* Shrinkage strength for the win-probability estimate. With k=10 a 2-trade
       bucket is pulled almost all the way to the overall base rate, so a 2/2
       bucket cannot advertise itself as a 100% strategy. */
    const PREM_SHRINK_K = 10;

    /* The first session with option premium snapshots. A fixed historical fact
       - the day collection started - not a value that moves. The signal history
       reaches back further, so any range before this has direction data but no
       premium, and the empty state has to say which is missing. */
    const PREM_FIRST_DAY = '2026-10-02';

    function premKeyFor(ctx) {
      return [currentStrategy, ctx.start || '', ctx.end || '',
              premTP, premSL, premGrades.join('')].join('|');
    }

    async function loadPremium(force) {
      const ctx = getDateContext();
      const key = premKeyFor(ctx);
      if (!force && premRows && premKey === key) {
        renderPerformance();
        return;
      }
      if (premLoading) return;
      premLoading = true;

      const bodyEl = document.getElementById('prem-body');
      if (bodyEl && !premRows) {
        bodyEl.innerHTML = '<div class="perf-empty">Running backtest...</div>';
      }

      try {
        /* Which strategies have a premium feed is data, not a hardcoded symbol
           check - so a strategy without one says so instead of rendering an
           empty table that reads as "no trades won".

           Re-fetched on an explicit refresh, not just once per page load: a
           feed can be switched on mid-session (QQQ was), and without this an
           already-open tab would keep insisting there is no feed until a full
           page reload. Re-run and the strategy switch are both force=true, so
           either recovers it. */
        if (premSources === null || force) {
          premSources = await rpcWithRetry('v2_premium_sources', null, {}, 2) || [];
        }
        const src = premSources.find(s => s.strategy_id === currentStrategy);
        const hasPremium = !(src && src.available === false);

        /* Both halves in parallel - they are independent RPCs and the tab
           cannot render until it has both. */
        const [pr, pf] = await Promise.all([
          hasPremium
            ? rpcWithRetry('v2_premium_backtest_by_strategy', null, {
                p_start: ctx.start, p_end: ctx.end, p_strategy: currentStrategy,
                p_tp: premTP, p_sl: premSL, p_grades: premGrades
              }, 2)
            : Promise.resolve([]),
          loadPerfRows(ctx, force)
        ]);

        premRows = pr || [];
        premKey = key;
        renderPerformance(hasPremium ? null : (src && src.reason));
      } catch (e) {
        if (bodyEl) {
          bodyEl.innerHTML = '<div class="err">Could not load performance: '
            + escapeHtml(e.message) + '</div>';
        }
      } finally {
        premLoading = false;
      }
    }

    /* ── Controls ── */
    function changePremParams() {
      const tp = parseFloat(document.getElementById('prem-tp').value);
      const sl = parseFloat(document.getElementById('prem-sl').value);
      // A non-positive target would make every trade resolve on the entry bar.
      premTP = (isFinite(tp) && tp > 0) ? tp : 0.50;
      premSL = (isFinite(sl) && sl > 0) ? sl : 0.50;
      const g = document.getElementById('prem-grades').value;
      premGrades = g === 'all' ? ['A', 'B', 'C', 'D'] : (g === 'a' ? ['A'] : ['A', 'B']);
      savePremParams(g);
      /* TP/SL decide which bar the trade exits on, so this cannot be re-sliced
         in the browser - the parameters have to reach SQL. */
      loadPremium(true);
    }

    /* Stored PER STRATEGY. The symbols are not run on the same rules - QQQ at
       $1.00 against SPY at $0.50 - and one shared setting means whichever you
       touched last silently redefines the other's backtest. */
    function premParamStore() {
      let m = null;
      try { m = JSON.parse(localStorage.getItem('v2-prem-params') || 'null'); } catch (e) { }
      if (!m || typeof m !== 'object') return {};
      // Migrate the older flat {tp,sl,g} shape onto whichever strategy is live.
      if ('tp' in m || 'sl' in m || 'g' in m) {
        const one = {};
        one[currentStrategy] = m;
        return one;
      }
      return m;
    }

    function savePremParams(g) {
      try {
        const m = premParamStore();
        m[currentStrategy] = { tp: premTP, sl: premSL, g: g };
        localStorage.setItem('v2-prem-params', JSON.stringify(m));
      } catch (e) { }
    }

    function initPremParams() {
      // Defaults for a strategy that has never been configured.
      premTP = 0.50; premSL = 0.50; premGrades = ['A', 'B'];
      let g = 'ab';
      const s = premParamStore()[currentStrategy];
      if (s) {
        if (isFinite(s.tp) && s.tp > 0) premTP = s.tp;
        if (isFinite(s.sl) && s.sl > 0) premSL = s.sl;
        if (s.g) {
          g = s.g;
          premGrades = g === 'all' ? ['A', 'B', 'C', 'D'] : (g === 'a' ? ['A'] : ['A', 'B']);
        }
      }
      const tpEl = document.getElementById('prem-tp');
      const slEl = document.getElementById('prem-sl');
      const gEl = document.getElementById('prem-grades');
      if (tpEl) tpEl.value = premTP.toFixed(2);
      if (slEl) slEl.value = premSL.toFixed(2);
      if (gEl) gEl.value = g;
    }

    /* ══════════════════════════════════════════════════════
       SMALL-SAMPLE STATISTICS

       At this sample size a fitted model over grade x hour x volume would be
       overfitting, and presenting its output as a probability would be the
       most harmful thing this tab could do. So: empirical base rates, a
       Wilson interval, and shrinkage toward the overall rate.
       ══════════════════════════════════════════════════════ */

    /* Wilson score interval. Used rather than the normal approximation because
       the latter is wrong exactly where this tab lives - small n and rates near
       0 or 1, where it happily returns bounds outside [0,1]. */
    function wilson(wins, n, z) {
      if (!n) return null;
      z = z || 1.96;
      const p = wins / n, z2 = z * z;
      const denom = 1 + z2 / n;
      const centre = p + z2 / (2 * n);
      const spread = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
      return [Math.max(0, (centre - spread) / denom), Math.min(1, (centre + spread) / denom)];
    }

    // Empirical-Bayes shrinkage toward the overall base rate.
    function shrunkRate(wins, n, base) {
      if (!n) return null;
      return (wins + PREM_SHRINK_K * base) / (n + PREM_SHRINK_K);
    }

    function median(arr) {
      if (!arr.length) return null;
      const a = arr.slice().sort((x, y) => x - y);
      const m = Math.floor(a.length / 2);
      return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    }

    function mean(arr) {
      return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
    }

    function aggPrem(rows) {
      const a = {
        n: rows.length, tp: 0, sl: 0, un: 0,
        tpTarget: 0, slStop: 0, tpEod: 0, slEod: 0,
        pnl: 0, gain: 0, loss: 0,
        pcts: [], maes: [], mfes: [], mins: [], ivs: []
      };
      rows.forEach(r => {
        /* Every trade closes: on a target, or flattened at the last snapshot
           of the session and labelled by the sign of that exit. a.un is kept
           at 0 so anything still reading it sees "none open" rather than
           undefined. */
        if (r.outcome === 'TP') { a.tp++; a.tpTarget++; }
        else if (r.outcome === 'TP_EOD') { a.tp++; a.tpEod++; }
        else if (r.outcome === 'SL') { a.sl++; a.slStop++; }
        else if (r.outcome === 'SL_EOD') { a.sl++; a.slEod++; }
        else a.un++;
        const p = r.pnl == null ? null : +r.pnl;
        if (p != null) {
          a.pnl += p;
          if (p > 0) a.gain += p; else a.loss += -p;
        }
        if (r.pnl_pct != null) a.pcts.push(+r.pnl_pct);
        if (r.mae != null) a.maes.push(+r.mae);
        if (r.mfe != null) a.mfes.push(+r.mfe);
        if (r.mins_held != null) a.mins.push(+r.mins_held);
        if (r.entry_iv != null) a.ivs.push(+r.entry_iv);
      });
      /* Every trade resolves now, so the win-rate denominator is simply all
         of them - no bucket is excluded and nothing needs defending. */
      a.resolved = a.tp + a.sl;
      a.winRate = a.resolved ? a.tp / a.resolved : null;
      a.ci = wilson(a.tp, a.resolved);
      /* Exits taken on time rather than on a target. This is what the old
         "open" count used to tell you - which hours run out of session - and
         it is still worth seeing, just no longer as an unfinished trade. */
      a.eod = a.tpEod + a.slEod;
      a.eodShare = a.n ? a.eod / a.n : null;
      a.avgPnl = a.n ? a.pnl / a.n : null;
      a.avgPct = mean(a.pcts);
      a.pf = a.loss > 0 ? a.gain / a.loss : (a.gain > 0 ? Infinity : null);
      a.avgMae = mean(a.maes);
      a.avgMfe = mean(a.mfes);
      a.medMins = median(a.mins);
      a.avgIv = mean(a.ivs);
      return a;
    }

    /* ══════════════════════════════════════════════════════
       CHARTS — inline SVG

       SVG rather than the <canvas> sparklines in charts.js: these are built
       inside an innerHTML string, and a canvas would need a second pass to
       find the element and draw after insertion. SVG composes into the same
       string and needs no follow-up call, so it cannot silently render blank
       if the ordering ever changes. Colours come through style="fill:var(..)"
       so they follow the theme without a redraw.
       ══════════════════════════════════════════════════════ */

    function svgEmpty(h, msg) {
      return `<div class="chart-empty" style="height:${h}px">${escapeHtml(msg)}</div>`;
    }

    /* Cumulative P&L, trade by trade. The one chart that answers "is this
       actually making money" without needing any other number on the page. */
    function svgEquity(rows) {
      if (!rows.length) return svgEmpty(150, 'No trades in range');
      const W = 620, H = 150, PL = 44, PR = 10, PT = 12, PB = 20;
      let cum = 0;
      const pts = rows.map(r => (cum += (+r.pnl || 0)));
      const lo = Math.min(0, ...pts), hi = Math.max(0, ...pts);
      const range = (hi - lo) || 1;
      const x = i => PL + (pts.length === 1 ? (W - PL - PR) / 2
                     : (i / (pts.length - 1)) * (W - PL - PR));
      const y = v => PT + (1 - (v - lo) / range) * (H - PT - PB);
      const zeroY = y(0);
      const line = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      const area = `${x(0).toFixed(1)},${zeroY.toFixed(1)} ${line} ${x(pts.length - 1).toFixed(1)},${zeroY.toFixed(1)}`;
      const end = pts[pts.length - 1];
      const up = end >= 0;
      const col = up ? 'var(--green)' : 'var(--red)';
      // y-axis labels: just the extremes and zero - three numbers, not a grid
      const ticks = [hi, 0, lo].filter((v, i, arr) => arr.indexOf(v) === i);
      return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Cumulative profit and loss across ${rows.length} trades, ending ${end.toFixed(2)} dollars">
        ${ticks.map(t => `<line x1="${PL}" x2="${W - PR}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"
            style="stroke:var(--line)" stroke-width="1" ${t === 0 ? '' : 'stroke-dasharray="2 3"'}/>
          <text x="${PL - 6}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end"
            style="fill:var(--dim)" font-size="9">${t > 0 ? '+' : ''}${t.toFixed(2)}</text>`).join('')}
        <polygon points="${area}" style="fill:${col}" opacity="0.12"/>
        <polyline points="${line}" fill="none" style="stroke:${col}" stroke-width="2"
          stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(end).toFixed(1)}" r="3" style="fill:${col}"/>
        <text x="${PL}" y="${H - 6}" style="fill:var(--dim)" font-size="9">trade 1</text>
        <text x="${W - PR}" y="${H - 6}" text-anchor="end" style="fill:var(--dim)" font-size="9">trade ${pts.length}</text>
      </svg>`;
    }

    /* Stacked proportion bar: won / lost. */
    function svgOutcomeBar(a) {
      if (!a.n) return '';
      /* Won / lost only - every trade closes. The split between a target
         exit and a time exit is carried in the key line underneath rather
         than as extra segments, which at four colours stopped being readable. */
      const seg = [
        [a.tp, 'var(--green)', 'Won'],
        [a.sl, 'var(--red)', 'Lost']
      ].filter(s => s[0] > 0);
      let off = 0;
      const bars = seg.map(s => {
        const wpc = (s[0] / a.n) * 100;
        const r = `<div class="ob-seg" style="width:${wpc}%;background:${s[1]}"
          title="${s[2]}: ${s[0]} of ${a.n}"></div>`;
        off += wpc;
        return r;
      }).join('');
      const key = seg.map(s =>
        `<span class="ob-key"><i style="background:${s[1]}"></i>${s[2]} ${s[0]}</span>`).join('')
        + (a.eod
            ? `<span class="ob-key muted">${a.eod} closed at the EOD mark`
              + ` (${a.tpEod} up, ${a.slEod} down)</span>`
            : '');
      return `<div class="ob-wrap"><div class="ob-bar">${bars}</div><div class="ob-keys">${key}</div></div>`;
    }

    /* Vertical bars with a zero baseline - used for average P&L per hour,
       where the sign is the whole point. */
    function svgSignedBars(items, unit) {
      const vals = items.filter(i => i.v != null);
      if (!vals.length) return svgEmpty(140, 'Not enough data');
      const W = 620, H = 140, PL = 40, PR = 8, PT = 10, PB = 26;
      const lo = Math.min(0, ...vals.map(i => i.v));
      const hi = Math.max(0, ...vals.map(i => i.v));
      const range = (hi - lo) || 1;
      const y = v => PT + (1 - (v - lo) / range) * (H - PT - PB);
      const zeroY = y(0);
      const slot = (W - PL - PR) / items.length;
      const bw = Math.min(42, slot * 0.62);
      return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Average ${escapeHtml(unit)} by bucket">
        <line x1="${PL}" x2="${W - PR}" y1="${zeroY.toFixed(1)}" y2="${zeroY.toFixed(1)}"
          style="stroke:var(--line)" stroke-width="1"/>
        <text x="${PL - 6}" y="${(y(hi) + 3.5).toFixed(1)}" text-anchor="end"
          style="fill:var(--dim)" font-size="9">${hi > 0 ? '+' : ''}${hi.toFixed(2)}</text>
        <text x="${PL - 6}" y="${(y(lo) + 3.5).toFixed(1)}" text-anchor="end"
          style="fill:var(--dim)" font-size="9">${lo.toFixed(2)}</text>
        ${items.map((it, i) => {
          const cx = PL + slot * i + slot / 2;
          if (it.v == null) {
            return `<text x="${cx.toFixed(1)}" y="${H - 14}" text-anchor="middle"
              style="fill:var(--dim)" font-size="9">${escapeHtml(it.label)}</text>`;
          }
          const yv = y(it.v);
          const top = Math.min(yv, zeroY), hgt = Math.max(1, Math.abs(zeroY - yv));
          const col = it.v >= 0 ? 'var(--green)' : 'var(--red)';
          return `<rect x="${(cx - bw / 2).toFixed(1)}" y="${top.toFixed(1)}"
              width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}" rx="2" style="fill:${col}"
              opacity="0.85"><title>${escapeHtml(it.label)}: ${it.v > 0 ? '+' : ''}${it.v.toFixed(2)}${
              it.n != null ? ' over ' + it.n + ' trades' : ''}</title></rect>
            <text x="${cx.toFixed(1)}" y="${H - 14}" text-anchor="middle"
              style="fill:var(--dim)" font-size="9">${escapeHtml(it.label)}</text>
            <text x="${cx.toFixed(1)}" y="${H - 4}" text-anchor="middle"
              style="fill:var(--dim)" font-size="8">${it.n == null ? '' : 'n=' + it.n}</text>`;
        }).join('')}
      </svg>`;
    }

    /* ══════════════════════════════════════════════════════
       CELLS
       ══════════════════════════════════════════════════════ */

    function premPctCell(a) {
      if (!a.resolved) return '<span class="muted">-</span>';
      const pct = a.winRate * 100;
      const cls = pct >= 55 ? 'call' : (pct >= 45 ? '' : 'put');
      const ci = a.ci
        ? ' <span class="muted">[' + (a.ci[0] * 100).toFixed(0) + '-' + (a.ci[1] * 100).toFixed(0) + ']</span>'
        : '';
      const small = a.resolved < PREM_MIN_N
        ? '<span class="prem-small" title="Fewer than ' + PREM_MIN_N
          + ' resolved trades - too small to draw a conclusion from">*</span>'
        : '';
      return '<span class="' + cls + '">' + pct.toFixed(0) + '%</span>'
        + ' <span class="muted">(' + a.tp + '/' + a.resolved + ')</span>'
        + ci + small + hitBar(pct);
    }

    function probCell(a, base) {
      const s = shrunkRate(a.tp, a.resolved, base);
      if (s == null) return '<span class="muted">-</span>';
      const pct = s * 100;
      const cls = pct >= 55 ? 'call' : (pct >= 45 ? '' : 'put');
      return '<span class="' + cls + '">' + pct.toFixed(0) + '%</span>';
    }

    function pfCell(pf) {
      if (pf == null) return '<span class="muted">-</span>';
      if (!isFinite(pf)) return '<span class="call">&infin;</span>';
      const cls = pf >= 1.5 ? 'call' : (pf >= 1 ? '' : 'put');
      return '<span class="' + cls + '">' + pf.toFixed(2) + '</span>';
    }

    /* Exits taken on time rather than on a target. Highlighted past 40%,
       because a bucket where most trades ran out of session is describing the
       clock as much as the signal. */
    function eodCell(a) {
      if (!a.n) return '<span class="muted">-</span>';
      const cls = a.eodShare >= 0.4 ? 'prem-censor' : 'muted';
      return '<span class="' + cls + '" title="Closed at the end-of-day mark rather than on '
        + 'the target or the stop - ' + a.tpEod + ' in profit, ' + a.slEod + ' at a loss">'
        + a.eod + '</span>';
    }

    /* One bucket row, in one of three modes:

         'both'  premium group + a condensed direction group
         'prem'  premium only   - buckets that only exist on premium rows
                                  (RVOL, put/call bias)
         'dir'   direction only - a strategy with no premium feed

       'dir' is a real layout, not the 'both' layout with the premium half
       blanked: seven dashes under a "Premium P&L" heading reads as "premium
       data exists and it is zero", which is the opposite of the truth. With
       the premium columns gone there is also room for the full direction
       detail - 30m/60m/EOD and both excursions - which is what the old
       Signal Performance tab showed. */
    function bucketRow(label, pRows, dRows, base, isTotal, mode) {
      const tr = '<tr class="' + (isTotal ? 'perf-total' : '') + '">'
        + '<td>' + escapeHtml(label) + '</td>';

      if (mode === 'dir') {
        const d = aggPerf(dRows || []);
        const edgeCls = d.edge == null ? 'muted' : (d.edge >= 1.5 ? 'call' : (d.edge >= 1 ? '' : 'put'));
        return tr
          + '<td>' + d.n + '</td>'
          + '<td>' + pctCell(d.w30, d.n30) + '</td>'
          + '<td>' + pctCell(d.w60, d.n60) + '</td>'
          + '<td>' + pctCell(d.weod, d.neod) + '</td>'
          + '<td>' + signedCell(d.avg30) + '</td>'
          + '<td>' + signedCell(d.avg60) + '</td>'
          + '<td>' + signedCell(d.avgEod) + '</td>'
          + '<td><span class="call">' + (d.avgMfe == null ? '-' : d.avgMfe.toFixed(2)) + '</span></td>'
          + '<td><span class="put">' + (d.avgMae == null ? '-' : d.avgMae.toFixed(2)) + '</span></td>'
          + '<td><span class="' + edgeCls + '">' + (d.edge == null ? '-' : d.edge.toFixed(2)) + '</span></td>'
          + '</tr>';
      }

      const a = aggPrem(pRows);
      let dir = '';
      if (mode === 'both') {
        const d = aggPerf(dRows || []);
        dir = '<td class="grp-start">' + (d.n || '<span class="muted">0</span>') + '</td>'
          + '<td>' + (d.n60 ? pctCell(d.w60, d.n60) : '<span class="muted">-</span>') + '</td>'
          + '<td>' + signedCell(d.avg60) + '</td>'
          + '<td>' + (d.edge == null ? '<span class="muted">-</span>'
                      : '<span class="' + (d.edge >= 1.5 ? 'call' : (d.edge >= 1 ? '' : 'put'))
                        + '">' + d.edge.toFixed(2) + '</span>') + '</td>';
      }
      return tr
        + '<td>' + a.n + '</td>'
        + '<td>' + premPctCell(a) + '</td>'
        + '<td>' + probCell(a, base) + '</td>'
        + '<td>' + eodCell(a) + '</td>'
        + '<td>' + signedCell(a.avgPnl) + '</td>'
        + '<td>' + pfCell(a.pf) + '</td>'
        + '<td><span class="put">' + (a.avgMae == null ? '-' : a.avgMae.toFixed(2)) + '</span></td>'
        + dir
        + '</tr>';
    }

    function tableHead(mode) {
      if (mode === 'dir') {
        return '<thead><tr>'
          + '<th>Bucket</th>'
          + '<th title="ALERTED signals in this bucket">Signals</th>'
          + '<th title="Share where price was on the signal\'s side 30 minutes later">Hit 30m</th>'
          + '<th title="Share where price was on the signal\'s side 60 minutes later">Hit 60m</th>'
          + '<th title="Share where price closed on the signal\'s side">Hit EOD</th>'
          + '<th title="Average direction-adjusted move in points at +30m">Avg 30m</th>'
          + '<th title="Average direction-adjusted move in points at +60m">Avg 60m</th>'
          + '<th title="Average direction-adjusted move in points at the close">Avg EOD</th>'
          + '<th title="Max favourable excursion within 60m - the realistic best exit, in points">MFE</th>'
          + '<th title="Max adverse excursion within 60m - the heat you had to survive">MAE</th>'
          + '<th title="MFE / MAE. Above 1.5 means the move paid for the drawdown; under 1 means it did not.">MFE:MAE</th>'
          + '</tr></thead>';
      }
      const prem =
          '<th title="Trades taken in this bucket">N</th>'
        + '<th title="Wins as a share of RESOLVED trades, with a 95% Wilson interval. '
        + '* marks a bucket with fewer than ' + PREM_MIN_N + ' resolved trades.">Win %</th>'
        + '<th title="Win rate shrunk toward the overall base rate, so a tiny bucket cannot '
        + 'read 0% or 100%. A base rate from history, not a forecast.">P(win)</th>'
        + '<th title="Closed at the end-of-day mark rather than on a target. A bucket that is mostly EOD exits is describing the clock as much as the signal.">EOD</th>'
        + '<th title="Average profit per trade, in premium dollars per contract">Avg $</th>'
        + '<th title="Gross profit divided by gross loss. Below 1 loses money.">PF</th>'
        + '<th title="Average max adverse excursion - the heat endured before the exit">MAE</th>';
      const dir = mode === 'both'
        ? '<th class="grp-start" title="ALERTED signals in this bucket over the full signal history">N</th>'
          + '<th title="Share where the underlying was on the signal\'s side 60 minutes later">Hit 60m</th>'
          + '<th title="Average direction-adjusted move in points at +60m">Avg move</th>'
          + '<th title="Max favourable over max adverse excursion. Above 1.5 means the move paid for the drawdown.">MFE:MAE</th>'
        : '';
      const groups = '<tr class="grp-row"><th></th>'
        + '<th colspan="7">Premium P&amp;L <span class="grp-sub">what the contract paid</span></th>'
        + (mode === 'both'
            ? '<th colspan="4" class="grp-start">Direction <span class="grp-sub">where the underlying went</span></th>'
            : '')
        + '</tr>';
      return '<thead>' + groups + '<tr><th>Bucket</th>' + prem + dir + '</tr></thead>';
    }

    function section(title, hint, body, mode) {
      if (!body) return '';
      return '<div class="perf-section-title">' + title
        + (hint ? ' <span class="hint">' + hint + '</span>' : '') + '</div>'
        + '<table class="perf-tbl">' + tableHead(mode) + '<tbody>' + body + '</tbody></table>';
    }

    /* Buckets rvol_tod - chain volume against the same minute in earlier
       sessions, which is the dashboard's one definition of RVOL. */
    function rvolBucket(r) {
      if (r.rvol == null) return 'Unknown';
      const v = +r.rvol;
      if (v < 0.75) return 'Quiet (RVOL < 0.75)';
      if (v < 1.25) return 'Normal (0.75 - 1.25)';
      if (v < 2) return 'Elevated (1.25 - 2)';
      return 'Surge (RVOL 2+)';
    }

    const PREM_RVOL_ORDER = ['Quiet (RVOL < 0.75)', 'Normal (0.75 - 1.25)',
                             'Elevated (1.25 - 2)', 'Surge (RVOL 2+)', 'Unknown'];

    function hourOf(r) { return tsKey(r.candle_time_ny).slice(11, 13); }

    /* ══════════════════════════════════════════════════════
       RENDER
       ══════════════════════════════════════════════════════ */

    function renderPerformance(noFeedReason) {
      const el = document.getElementById('prem-body');
      if (!el) return;
      const rows = premRows || [];
      const dRows = perfRows || [];

      if (noFeedReason) {
        el.innerHTML = '<div class="perf-empty"><b>' + escapeHtml(noFeedReason) + '.</b><br>'
          + 'Premium P&amp;L prices every trade from an option chain snapshot, so it needs a '
          + 'premium feed for this symbol. Direction stats below still work.</div>'
          + (dRows.length ? directionOnlyBlock(dRows) : '');
        updateRowCounts();
        return;
      }

      if (!rows.length && !dRows.length) {
        const c = getDateContext();
        const span = (c.start || c.end)
          ? `<b>${escapeHtml(c.start || '...')}</b> to <b>${escapeHtml(c.end || '...')}</b>`
          : 'all available history';
        const before = c.end && c.end < PREM_FIRST_DAY;
        el.innerHTML = '<div class="perf-empty">Nothing to show for ' + span + '.<br>'
          + (before
              ? 'That range ends before option premium collection started on <b>'
                + PREM_FIRST_DAY + '</b>.'
              : 'No ' + premGrades.join('/') + ' candles with a tradeable direction in that range.')
          + '</div>';
        updateRowCounts();
        return;
      }

      const all = aggPrem(rows);
      const base = all.resolved ? all.tp / all.resolved : 0.5;
      const dAll = aggPerf(dRows);
      const days = new Set(rows.map(r => r.trade_date)).size;
      const dDays = new Set(dRows.map(r => r.trade_date)).size;

      /* ── Hero: four plain-language numbers, then the equity curve ── */
      const money = v => (v == null ? '-' : (v > 0 ? '+' : '') + '$' + Math.abs(v).toFixed(2).replace('-', ''));
      const net = all.pnl;
      const kpis = [
        ['Net P&L', (net > 0 ? '+' : net < 0 ? '-' : '') + '$' + Math.abs(net).toFixed(2),
         `across ${all.n} trade${all.n === 1 ? '' : 's'}, holding 1 contract each`],
        ['Win rate', all.resolved ? Math.round(all.winRate * 100) + '%' : '-',
         `${all.tp} won, ${all.sl} lost`
         + (all.eod ? ` - ${all.eod} of them closed at the EOD mark` : '')],
        ['Average trade', (all.avgPnl == null ? '-'
            : (all.avgPnl > 0 ? '+' : all.avgPnl < 0 ? '-' : '') + '$' + Math.abs(all.avgPnl).toFixed(2)),
         'what one trade is worth on average'],
        ['Profit factor', all.pf == null ? '-' : (isFinite(all.pf) ? all.pf.toFixed(2) : '∞'),
         all.pf == null ? 'no resolved trades yet'
           : (isFinite(all.pf) ? '$' + all.pf.toFixed(2) + ' won for every $1.00 lost'
                               : 'no losing trades yet')]
      ].map(k => {
        const v = k[1];
        const cls = v.indexOf('+') === 0 ? 'call' : (v.indexOf('-') === 0 ? 'put' : '');
        return '<div class="kpi"><div class="kpi-label">' + k[0] + '</div>'
          + '<div class="kpi-value ' + cls + '">' + v + '</div>'
          + '<div class="kpi-sub">' + k[2] + '</div></div>';
      }).join('');

      /* ── Charts ── */
      const hours = {};
      rows.forEach(r => { (hours[hourOf(r)] = hours[hourOf(r)] || []).push(r); });
      const hourItems = Object.keys(hours).sort().map(h => {
        const a = aggPrem(hours[h]);
        return { label: h + ':00', v: a.avgPnl, n: a.n };
      });

      const gradeItems = ['A', 'B', 'C', 'D'].map(g => {
        const set = rows.filter(r => r.grade === g);
        if (!set.length) return null;
        const a = aggPrem(set);
        return { label: 'Grade ' + g, v: a.avgPnl, n: a.n };
      }).filter(Boolean);

      const smallAll = all.resolved < PREM_MIN_N;

      /* ── Bucket tables ── */
      const byGrade = ['A', 'B', 'C', 'D'].map(g => {
        const set = rows.filter(r => r.grade === g);
        const dset = dRows.filter(r => r.grade === g);
        return (set.length || dset.length)
          ? bucketRow('Grade ' + g, set, dset, base, false, 'both') : '';
      }).join('') + bucketRow('All', rows, dRows, base, true, 'both');

      const byDir = ['CALL', 'PUT'].map(d => {
        const set = rows.filter(r => r.direction === d);
        const dset = dRows.filter(r => r.direction === d);
        return (set.length || dset.length)
          ? bucketRow(d, set, dset, base, false, 'both') : '';
      }).join('');

      const hourKeys = Array.from(new Set(
        Object.keys(hours).concat(dRows.map(hourOf)))).sort();
      const byHour = hourKeys.map(h =>
        bucketRow(h + ':00 - ' + h + ':59', hours[h] || [],
                  dRows.filter(r => hourOf(r) === h), base, false, 'both')).join('');

      const byAlert = [['Alerted', true], ['Near-miss (never alerted)', false]].map(p => {
        const set = rows.filter(r => !!r.has_signal === p[1]);
        // every row in the direction set is by definition an alerted signal
        const dset = p[1] ? dRows : [];
        return set.length ? bucketRow(p[0], set, dset, base, false, 'both') : '';
      }).join('');

      const rv = {};
      rows.forEach(r => { const b = rvolBucket(r); (rv[b] = rv[b] || []).push(r); });
      const byRvol = PREM_RVOL_ORDER.filter(k => rv[k]).map(k =>
        bucketRow(k, rv[k], null, base, false, 'prem')).join('');

      const byBias = ['CALL-HEAVY', 'BALANCED', 'PUT-HEAVY'].map(b => {
        const set = rows.filter(r => r.side_bias === b);
        return set.length ? bucketRow(b, set, null, base, false, 'prem') : '';
      }).join('');

      el.innerHTML =
        (smallAll
          ? '<div class="prem-warn"><b>Small sample.</b> ' + all.resolved + ' resolved trade'
            + (all.resolved === 1 ? '' : 's') + ' over ' + days + ' session' + (days === 1 ? '' : 's')
            + '. Every bucket is under the ' + PREM_MIN_N + '-trade threshold and marked '
            + '<span class="prem-small">*</span>. Directional, not conclusive.</div>'
          : '')

        + '<div class="hero">'
        +   '<div class="hero-kpis">' + kpis + '</div>'
        +   '<div class="hero-chart">'
        +     '<div class="chart-title">Cumulative P&amp;L'
        +       '<span class="hint">every trade in order, 1 contract each</span></div>'
        +     svgEquity(rows)
        +     svgOutcomeBar(all)
        +   '</div>'
        + '</div>'

        + '<div class="chart-grid">'
        +   '<div class="chart-card"><div class="chart-title">Average P&amp;L by hour'
        +     '<span class="hint">when the signal fired (NY)</span></div>'
        +     svgSignedBars(hourItems, 'dollars') + '</div>'
        +   '<div class="chart-card"><div class="chart-title">Average P&amp;L by grade'
        +     '<span class="hint">is the score ranking your trades?</span></div>'
        +     svgSignedBars(gradeItems, 'dollars') + '</div>'
        + '</div>'

        + '<div class="perf-note">'
        +   '<b>Two measures, two sample sizes.</b> <b>Premium P&amp;L</b> is what the contract '
        +   'paid - real money, over ' + days + ' session' + (days === 1 ? '' : 's') + ' of premium '
        +   'history (from ' + PREM_FIRST_DAY + '). <b>Direction</b> is whether the underlying went '
        +   'the way the signal called, in points, over ' + dDays + ' session' + (dDays === 1 ? '' : 's')
        +   ' of ALERTED signals. The direction sample is bigger; only the premium side knows about '
        +   'spread, theta and what you would actually have been filled at. Each group carries its '
        +   'own N - do not read them as one sample.'
        + '</div>'

        + section('By Grade', 'does a higher score earn more?', byGrade, 'both')
        + section('Alerted vs Near-miss', 'is the alert filter adding anything over the grade alone?',
                  byAlert, 'both')
        + section('By Hour of Day (NY)',
                  'read EOD first - late entries run out of session and exit on the clock '
                  + 'rather than on a target', byHour, 'both')
        + section('By Direction', '', byDir, 'both')
        + section('By Relative Volume (time of day)',
                  'chain volume vs the same minute in earlier sessions', byRvol, 'prem')
        + section('By Put/Call Bias at Entry', 'chain-wide positioning when the trade was taken',
                  byBias, 'prem')
        + ledgerHtml(rows);

      updateRowCounts();
    }

    /* The whole tab for a strategy with no premium feed. Not a degraded
       version of the combined view - the premium columns are absent rather
       than blank, and the direction detail expands into the space, which is
       everything the old Signal Performance tab showed. */
    function directionOnlyBlock(dRows) {
      const d = aggPerf(dRows);
      const days = new Set(dRows.map(r => r.trade_date)).size;
      const sess = days === 1 ? '' : 's';

      const kpis = [
        ['Signals', String(d.n), 'alerted, over ' + days + ' session' + sess],
        ['Hit 60m', d.n60 ? Math.round((d.w60 / d.n60) * 100) + '%' : '-',
         d.n60 ? d.w60 + ' of ' + d.n60 + ' went the way the signal called' : 'no data yet'],
        ['Avg move 60m', d.avg60 == null ? '-'
          : (d.avg60 > 0 ? '+' : '') + d.avg60.toFixed(2),
         'points, direction-adjusted'],
        ['MFE:MAE', d.edge == null ? '-' : d.edge.toFixed(2),
         d.edge == null ? 'no data yet' : 'reach per unit of heat taken']
      ].map(k => {
        const v = k[1];
        const cls = v.indexOf('+') === 0 ? 'call' : (v.indexOf('-') === 0 && v.length > 1 ? 'put' : '');
        return '<div class="kpi"><div class="kpi-label">' + k[0] + '</div>'
          + '<div class="kpi-value ' + cls + '">' + v + '</div>'
          + '<div class="kpi-sub">' + k[2] + '</div></div>';
      }).join('');

      const hours = {};
      dRows.forEach(r => { (hours[hourOf(r)] = hours[hourOf(r)] || []).push(r); });
      const hourKeys = Object.keys(hours).sort();
      const hourItems = hourKeys.map(h => {
        const a = aggPerf(hours[h]);
        return { label: h + ':00', v: a.avg60, n: a.n };
      });
      const gradeItems = ['A', 'B', 'C', 'D'].map(g => {
        const set = dRows.filter(r => r.grade === g);
        if (!set.length) return null;
        const a = aggPerf(set);
        return { label: 'Grade ' + g, v: a.avg60, n: a.n };
      }).filter(Boolean);

      const byGradeDir = [];
      ['A', 'B', 'C', 'D'].forEach(g => ['CALL', 'PUT'].forEach(dir => {
        const set = dRows.filter(r => r.grade === g && r.direction === dir);
        if (set.length) byGradeDir.push(bucketRow('Grade ' + g + ' · ' + dir, [], set, 0.5, false, 'dir'));
      }));

      const byGrade = ['A', 'B', 'C', 'D'].map(g => {
        const set = dRows.filter(r => r.grade === g);
        return set.length ? bucketRow('Grade ' + g, [], set, 0.5, false, 'dir') : '';
      }).join('') + bucketRow('All signals', [], dRows, 0.5, true, 'dir');

      const byDir = ['CALL', 'PUT'].map(dir => {
        const set = dRows.filter(r => r.direction === dir);
        return set.length ? bucketRow(dir, [], set, 0.5, false, 'dir') : '';
      }).join('');

      const byHour = hourKeys.map(h =>
        bucketRow(h + ':00 - ' + h + ':59', [], hours[h], 0.5, false, 'dir')).join('');

      return '<div class="hero">'
        +   '<div class="hero-kpis">' + kpis + '</div>'
        +   '<div class="hero-chart">'
        +     '<div class="chart-title">Average 60m move by hour'
        +       '<span class="hint">points, direction-adjusted (NY)</span></div>'
        +     svgSignedBars(hourItems, 'points')
        +   '</div>'
        + '</div>'
        + (gradeItems.length > 1
            ? '<div class="chart-grid"><div class="chart-card">'
              + '<div class="chart-title">Average 60m move by grade'
              + '<span class="hint">is the score ranking your signals?</span></div>'
              + svgSignedBars(gradeItems, 'points') + '</div></div>'
            : '')
        + section('By Grade', 'is the score ranking your signals?', byGrade, 'dir')
        + section('By Grade &amp; Direction', '', byGradeDir.join(''), 'dir')
        + section('By Direction', '', byDir, 'dir')
        + section('By Hour of Day (NY)', 'which part of the session is worth trading',
                  byHour, 'dir');
    }

    function ledgerHtml(rows) {
      if (!rows.length) return '';
      const body = rows.slice().reverse().map(r => {
        const won = r.outcome === 'TP' || r.outcome === 'TP_EOD';
        const oCls = won ? 'call' : 'put';
        // TP_EOD/SL_EOD read as "TP (EOD)" - same colour as a target exit,
        // since it is still a win or a loss, with the reason in the suffix.
        const oTxt = String(r.outcome || '').replace('_EOD', ' (EOD)');
        /* C/P, not P/C: the signal modal and the Option Volume tab both show
           call/put, and the same number under an inverted label in a third
           place is how you end up comparing 2.21 against 0.45. */
        const cp = r.cp_ratio == null ? '-' : (+r.cp_ratio).toFixed(2);
        return '<tr>'
          + '<td>' + fmtTime(r.candle_time_ny) + '</td>'
          + '<td>' + gradePill(r.grade) + '</td>'
          + '<td><span class="' + (r.direction === 'CALL' ? 'call' : 'put') + '">'
            + escapeHtml(r.direction || '') + '</span></td>'
          + '<td>' + (r.strike == null ? '-' : (+r.strike).toFixed(0)) + '</td>'
          + '<td>' + (r.entry_px == null ? '-' : (+r.entry_px).toFixed(2)) + '</td>'
          + '<td>' + (r.exit_px == null ? '-' : (+r.exit_px).toFixed(2)) + '</td>'
          + '<td><span class="' + oCls + '">' + escapeHtml(oTxt) + '</span></td>'
          + '<td>' + signedCell(r.pnl, 2) + '</td>'
          + '<td>' + signedCell(r.pnl_pct, 1) + '</td>'
          + '<td>' + (r.mins_held == null ? '-' : r.mins_held) + '</td>'
          + '<td><span class="put">' + (r.mae == null ? '-' : (+r.mae).toFixed(2)) + '</span></td>'
          + '<td><span class="call">' + (r.mfe == null ? '-' : (+r.mfe).toFixed(2)) + '</span></td>'
          + '<td>' + fmtCompact(r.call_volume) + '</td>'
          + '<td>' + fmtCompact(r.put_volume) + '</td>'
          + '<td>' + cp + '</td>'
          + '<td>' + (r.rvol == null ? '<span class="muted">-</span>' : (+r.rvol).toFixed(2) + 'x') + '</td>'
          + '<td>' + fmtDollar(r.dollar_traded) + '</td>'
          + '<td>' + fmtCompact(r.contract_vol_candle) + '</td>'
          + '<td>' + (r.entry_iv == null ? '-' : (+r.entry_iv * 100).toFixed(1) + '%') + '</td>'
          + '<td>' + signedCell(r.iv_change == null ? null : +r.iv_change * 100, 1) + '</td>'
          + '<td>' + (r.has_signal ? '<span class="call">yes</span>'
                                   : '<span class="muted">near-miss</span>') + '</td>'
          + '</tr>';
      }).join('');
      return '<div class="perf-section-title">Trade Ledger <span class="hint">newest first - '
        + 'every signal candle priced at the POC strike</span></div>'
        + '<div class="prem-ledger-wrap"><table class="perf-tbl prem-ledger"><thead><tr>'
        + '<th>Time</th><th>Gr</th><th>Dir</th><th>Strike</th>'
        + '<th title="Paid at the quoted ask">Entry</th>'
        + '<th title="Sold at the quoted bid">Exit</th>'
        + '<th>Outcome</th><th>P&amp;L $</th><th>P&amp;L %</th><th>Min</th>'
        + '<th>MAE</th><th>MFE</th>'
        + '<th title="Call volume across the whole chain in this candle - the same figure the signal modal and the Option Volume tab show">Call vol</th>'
        + '<th title="Put volume across the whole chain in this candle">Put vol</th>'
        + '<th title="Call/put ratio across the chain. Above 1 is call-heavy. Same orientation as the signal modal.">C/P</th>'
        + '<th title="Relative volume for this time of day - chain volume vs the same minute in earlier sessions">RVOL</th>'
        + '<th title="Total premium traded across the chain in this candle">$ traded</th>'
        + '<th title="The POC contract\'s own volume in this candle - the liquidity you would actually have to fill">POC vol</th>'
        + '<th>IV</th><th title="IV change from entry to exit">&Delta;IV</th>'
        + '<th>Alerted</th>'
        + '</tr></thead><tbody>' + body + '</tbody></table></div>';
    }
