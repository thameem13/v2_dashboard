/* premium.js - premium backtest tab
   Split from index.html. These are CLASSIC scripts, not modules:
   top-level let/const share one global lexical scope, so the
   mutable state variables and the inline onclick handlers keep
   working exactly as before. Load order is load-bearing. */
    /* ══════════════════════════════════════════════════════
       PREMIUM BACKTEST TAB

       The Signal Performance tab measures forward movement in UNDERLYING
       points. This one measures the contract: buy the POC-strike next-day
       expiry at the quoted ask on an A/B candle, walk the session forward
       through the 5-minute chain snapshots, exit on the first touch of
       +TP or -SL, and flatten anything still open at the close.

       All of that happens in SQL (v2_premium_backtest_by_strategy), which
       returns one row per trade. This file only aggregates and renders -
       the same division of labour as perf.js, and for the same reason:
       there is exactly one copy of the trade logic and it is not in the
       browser.
       ══════════════════════════════════════════════════════ */

    /* Below this many RESOLVED trades a bucket is marked as too small to read.
       At today's sample (44 trades over 3 sessions) that is every bucket,
       which is the correct and intended result - not a bug to tune away. */
    const PREM_MIN_N = 20;

    /* Shrinkage strength for the win-probability estimate. With k=10 a 2-trade
       bucket is pulled almost all the way to the overall base rate, so a 2/2
       bucket cannot advertise itself as a 100% strategy. */
    const PREM_SHRINK_K = 10;

    /* The first session with option premium snapshots. A fixed historical fact
       - the day collection started - not a value that moves. The signal history
       reaches back to 2026-09-08, so any range before this returns nothing, and
       the empty state has to say why rather than implying no signals fired. */
    const PREM_FIRST_DAY = '2026-10-02';

    function premKeyFor(ctx) {
      return [currentStrategy, ctx.start || '', ctx.end || '',
              premTP, premSL, premGrades.join('')].join('|');
    }

    async function loadPremium(force) {
      const ctx = getDateContext();
      const key = premKeyFor(ctx);
      if (!force && premRows && premKey === key) {
        renderPremium(premRows);
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
           empty table that reads as "no trades won". */
        if (premSources === null) {
          premSources = await rpcWithRetry('v2_premium_sources', null, {}, 2) || [];
        }
        const src = premSources.find(s => s.strategy_id === currentStrategy);
        if (src && src.available === false) {
          /* premRows stays null deliberately. Caching [] here would be truthy
             on the next visit, short-circuit to renderPremium([]) and claim
             "no trades in range" - the right emptiness for the wrong reason.
             premKey IS set, so loadAll's range check sees this range as
             already handled and does not re-enter on every live poll. */
          premRows = null;
          premKey = key;
          if (bodyEl) {
            bodyEl.innerHTML = '<div class="perf-empty"><b>' + escapeHtml(src.reason) + '.</b><br>'
              + 'The backtest prices every trade from an option chain snapshot, so it '
              + 'needs a premium feed for this symbol before it can show anything. '
              + 'Nothing else about this strategy is affected.</div>';
          }
          updateRowCounts();
          return;
        }

        const rows = await rpcWithRetry('v2_premium_backtest_by_strategy', null, {
          p_start: ctx.start, p_end: ctx.end, p_strategy: currentStrategy,
          p_tp: premTP, p_sl: premSL, p_grades: premGrades
        }, 2);
        premRows = rows || [];
        premKey = key;
        renderPremium(premRows);
      } catch (e) {
        if (bodyEl) {
          bodyEl.innerHTML = '<div class="err">Could not run the premium backtest: '
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
      try {
        localStorage.setItem('v2-prem-params', JSON.stringify({ tp: premTP, sl: premSL, g: g }));
      } catch (e) { }
      /* TP/SL decide which bar the trade exits on, so this cannot be re-sliced
         in the browser - the parameters have to reach SQL. */
      loadPremium(true);
    }

    function initPremParams() {
      try {
        const s = JSON.parse(localStorage.getItem('v2-prem-params') || 'null');
        if (s) {
          if (isFinite(s.tp) && s.tp > 0) premTP = s.tp;
          if (isFinite(s.sl) && s.sl > 0) premSL = s.sl;
          if (s.g) {
            premGrades = s.g === 'all' ? ['A', 'B', 'C', 'D'] : (s.g === 'a' ? ['A'] : ['A', 'B']);
            const el = document.getElementById('prem-grades');
            if (el) el.value = s.g;
          }
        }
      } catch (e) { }
      const tpEl = document.getElementById('prem-tp');
      const slEl = document.getElementById('prem-sl');
      if (tpEl) tpEl.value = premTP.toFixed(2);
      if (slEl) slEl.value = premSL.toFixed(2);
    }

    /* ══════════════════════════════════════════════════════
       SMALL-SAMPLE STATISTICS

       At n=44 a fitted model over grade x hour x volume would be pure
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
        pnl: 0, gain: 0, loss: 0,
        pcts: [], maes: [], mfes: [], mins: [], ivs: [], rvols: []
      };
      rows.forEach(r => {
        if (r.outcome === 'TP') a.tp++;
        else if (r.outcome === 'SL') a.sl++;
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
        if (r.rvol != null) a.rvols.push(+r.rvol);
      });
      /* Resolved is the honest win-rate denominator; UNRESOLVED is neither a
         win nor a loss, and folding it into either would be a thumb on the
         scale. It gets its own column instead. */
      a.resolved = a.tp + a.sl;
      a.winRate = a.resolved ? a.tp / a.resolved : null;
      a.ci = wilson(a.tp, a.resolved);
      /* Averaged over ALL trades, unresolved included: those are flattened at
         the close at a real mark, so they belong in the expectancy. */
      a.avgPnl = a.n ? a.pnl / a.n : null;
      a.avgPct = mean(a.pcts);
      a.pf = a.loss > 0 ? a.gain / a.loss : (a.gain > 0 ? Infinity : null);
      a.avgMae = mean(a.maes);
      a.avgMfe = mean(a.mfes);
      a.medMins = median(a.mins);
      a.avgIv = mean(a.ivs);
      a.avgRvol = mean(a.rvols);
      /* Censoring rate: the share that simply ran out of session. Without this
         the late buckets read as "bad" when they are mostly "unfinished". */
      a.censored = a.n ? a.un / a.n : null;
      return a;
    }

    function premPctCell(a) {
      if (!a.resolved) return '<span class="muted">-</span> <span class="muted">(0 resolved)</span>';
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

    function censorCell(a) {
      if (!a.n) return '<span class="muted">-</span>';
      const cls = a.censored >= 0.4 ? 'prem-censor' : 'muted';
      return '<span class="' + cls + '" title="Trades still open at the close - they ran '
        + 'out of session rather than hitting a target">' + a.un + '</span>';
    }

    function premRowHtml(label, rows, base, isTotal) {
      const a = aggPrem(rows);
      return '<tr class="' + (isTotal ? 'perf-total' : '') + '">'
        + '<td>' + escapeHtml(label) + '</td>'
        + '<td>' + a.n + '</td>'
        + '<td>' + premPctCell(a) + '</td>'
        + '<td>' + probCell(a, base) + '</td>'
        + '<td><span class="call">' + a.tp + '</span></td>'
        + '<td><span class="put">' + a.sl + '</span></td>'
        + '<td>' + censorCell(a) + '</td>'
        + '<td>' + signedCell(a.avgPnl) + '</td>'
        + '<td>' + signedCell(a.avgPct, 1) + '</td>'
        + '<td>' + pfCell(a.pf) + '</td>'
        + '<td><span class="put">' + (a.avgMae == null ? '-' : a.avgMae.toFixed(2)) + '</span></td>'
        + '<td><span class="call">' + (a.avgMfe == null ? '-' : a.avgMfe.toFixed(2)) + '</span></td>'
        + '<td>' + (a.medMins == null ? '<span class="muted">-</span>' : a.medMins.toFixed(0)) + '</td>'
        + '<td>' + (a.avgIv == null ? '<span class="muted">-</span>' : (a.avgIv * 100).toFixed(1) + '%') + '</td>'
        + '</tr>';
    }

    const PREM_HEAD =
      '<thead><tr>'
      + '<th>Bucket</th>'
      + '<th title="Trades taken in this bucket">N</th>'
      + '<th title="Wins as a share of RESOLVED trades, with a 95% Wilson interval. '
      + '* marks a bucket with fewer than ' + PREM_MIN_N + ' resolved trades.">Win %</th>'
      + '<th title="Win rate shrunk toward the overall base rate, so a tiny bucket cannot '
      + 'read 0% or 100%. A base rate from history, not a forecast.">P(win)</th>'
      + '<th title="Hit the profit target first">TP</th>'
      + '<th title="Hit the stop first">SL</th>'
      + '<th title="Still open at the close - ran out of session rather than resolving. '
      + 'Highlighted above 40%.">Open</th>'
      + '<th title="Average profit per trade in premium dollars, unresolved marked at the close">Avg $</th>'
      + '<th title="Average return on the premium paid">Avg %</th>'
      + '<th title="Gross profit divided by gross loss. Below 1 loses money.">PF</th>'
      + '<th title="Average max adverse excursion - the heat endured before the exit">MAE</th>'
      + '<th title="Average max favourable excursion reached before the exit">MFE</th>'
      + '<th title="Median minutes from entry to exit">Min</th>'
      + '<th title="Average implied volatility at entry">IV</th>'
      + '</tr></thead>';

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

    function premSection(title, hint, bodyHtml) {
      if (!bodyHtml) return '';
      return '<div class="perf-section-title">' + title
        + (hint ? ' <span class="hint">' + hint + '</span>' : '') + '</div>'
        + '<table class="perf-tbl">' + PREM_HEAD + '<tbody>' + bodyHtml + '</tbody></table>';
    }

    function renderPremium(rows) {
      const el = document.getElementById('prem-body');
      if (!el) return;

      if (!rows || !rows.length) {
        /* Name the range that was actually queried. "No trades" has two very
           different causes - a range with no A/B signals, and a range with no
           premium snapshots at all - and they need different reactions. */
        const c = getDateContext();
        const span = (c.start || c.end)
          ? `<b>${escapeHtml(c.start || '...')}</b> to <b>${escapeHtml(c.end || '...')}</b>`
          : 'all available history';
        const beforeCoverage = c.end && c.end < PREM_FIRST_DAY;
        el.innerHTML = '<div class="perf-empty">No backtested trades for ' + span + '.<br>'
          + (beforeCoverage
              ? 'That range ends before option premium collection started on <b>'
                + PREM_FIRST_DAY + '</b>. The signal history goes back further, but a trade '
                + 'cannot be priced without a chain snapshot, so the backtest cannot reach it.'
              : 'Either there were no ' + premGrades.join('/') + ' candles with a tradeable '
                + 'direction in that range, or premium snapshots are missing for it - '
                + 'collection begins <b>' + PREM_FIRST_DAY + '</b>.')
          + '</div>';
        updateRowCounts();
        return;
      }

      const all = aggPrem(rows);
      const base = all.resolved ? all.tp / all.resolved : 0.5;
      const days = new Set(rows.map(r => r.trade_date)).size;
      const sess = days === 1 ? '' : 's';

      /* ── Summary KPIs ── */
      const ciTxt = all.ci
        ? (all.ci[0] * 100).toFixed(0) + '-' + (all.ci[1] * 100).toFixed(0) + '%'
        : '-';
      const kpiDefs = [
        ['Trades', String(all.n), 'over ' + days + ' session' + sess],
        ['Win rate', all.resolved ? (all.winRate * 100).toFixed(0) + '%' : '-',
          all.tp + '/' + all.resolved + ' resolved - 95% CI ' + ciTxt],
        ['Expectancy', all.avgPnl == null ? '-' : (all.avgPnl > 0 ? '+' : '') + all.avgPnl.toFixed(3),
          'premium $ per trade, per contract'],
        ['Avg return', all.avgPct == null ? '-' : (all.avgPct > 0 ? '+' : '') + all.avgPct.toFixed(1) + '%',
          'on the premium paid'],
        ['Profit factor', all.pf == null ? '-' : (isFinite(all.pf) ? all.pf.toFixed(2) : '∞'),
          'gross profit / gross loss'],
        ['Avg MAE', all.avgMae == null ? '-' : all.avgMae.toFixed(2),
          'heat endured before the exit'],
        ['Still open', String(all.un),
          ((all.censored || 0) * 100).toFixed(0) + '% ran out of session']
      ];
      const kpis = kpiDefs.map(k => {
        const v = k[1];
        const cls = v.charAt(0) === '+' ? 'call' : ((v.charAt(0) === '-' && v.length > 1) ? 'put' : '');
        return '<div class="prem-kpi"><div class="prem-kpi-label">' + k[0] + '</div>'
          + '<div class="prem-kpi-value ' + cls + '">' + v + '</div>'
          + '<div class="prem-kpi-sub">' + k[2] + '</div></div>';
      }).join('');

      /* ── Buckets ── */
      const byGrade = ['A', 'B', 'C', 'D'].map(g => {
        const set = rows.filter(r => r.grade === g);
        return set.length ? premRowHtml('Grade ' + g, set, base, false) : '';
      }).join('') + premRowHtml('All trades', rows, base, true);

      const byAlert = [['Alerted', true], ['Near-miss (never alerted)', false]].map(p => {
        const set = rows.filter(r => !!r.has_signal === p[1]);
        return set.length ? premRowHtml(p[0], set, base, false) : '';
      }).join('');

      const hours = {};
      rows.forEach(r => {
        const h = tsKey(r.candle_time_ny).slice(11, 13);
        (hours[h] = hours[h] || []).push(r);
      });
      const byHour = Object.keys(hours).sort().map(h =>
        premRowHtml(h + ':00 - ' + h + ':59', hours[h], base, false)).join('');

      const rv = {};
      rows.forEach(r => { const b = rvolBucket(r); (rv[b] = rv[b] || []).push(r); });
      const byRvol = PREM_RVOL_ORDER.filter(k => rv[k]).map(k =>
        premRowHtml(k, rv[k], base, false)).join('');

      const byBias = ['CALL-HEAVY', 'BALANCED', 'PUT-HEAVY'].map(b => {
        const set = rows.filter(r => r.side_bias === b);
        return set.length ? premRowHtml(b, set, base, false) : '';
      }).join('');

      const byDir = ['CALL', 'PUT'].map(d => {
        const set = rows.filter(r => r.direction === d);
        return set.length ? premRowHtml(d, set, base, false) : '';
      }).join('');

      /* ── Ledger ── */
      const ledger = rows.slice().reverse().map(r => {
        const oCls = r.outcome === 'TP' ? 'call' : (r.outcome === 'SL' ? 'put' : 'muted');
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
          + '<td><span class="' + oCls + '">' + escapeHtml(r.outcome || '') + '</span></td>'
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

      const warn = all.resolved < PREM_MIN_N
        ? '<div class="prem-warn"><b>Small sample.</b> ' + all.resolved + ' resolved trade'
          + (all.resolved === 1 ? '' : 's') + ' over ' + days + ' session' + sess
          + '. Every bucket below is under the ' + PREM_MIN_N + '-trade threshold and marked '
          + '<span class="prem-small">*</span>. Treat all of it as directional, not '
          + 'conclusive - these numbers become meaningful as premium history accumulates.</div>'
        : '';

      el.innerHTML = warn
        + '<div class="prem-kpis">' + kpis + '</div>'
        + premSection('By Grade',
            'is the score ranking your trades, in actual premium?', byGrade)
        + premSection('Alerted vs Near-miss',
            'is the alert filter adding anything over the grade alone?', byAlert)
        + premSection('By Hour of Day (NY)',
            'read the Open column first - late entries resolve less often because the '
            + 'session ends, not because the hour is bad', byHour)
        + premSection('By Relative Volume (time of day)',
            'does a busier-than-usual tape pay better? chain volume vs the same '
            + 'minute in earlier sessions', byRvol)
        + premSection('By Put/Call Bias at Entry',
            'chain-wide positioning when the trade was taken', byBias)
        + premSection('By Direction', '', byDir)
        + '<div class="perf-section-title">Trade Ledger <span class="hint">newest first - '
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
        + '<th title="Relative volume for this time of day - total chain volume vs the same minute in earlier sessions">RVOL</th>'
        + '<th title="Total premium traded across the chain in this candle">$ traded</th>'
        + '<th title="The POC contract\'s own volume in this candle - the liquidity you would actually have to fill, not the whole chain">POC vol</th>'
        + '<th>IV</th><th title="IV change from entry to exit">&Delta;IV</th>'
        + '<th>Alerted</th>'
        + '</tr></thead><tbody>' + ledger + '</tbody></table></div>';

      updateRowCounts();
    }
