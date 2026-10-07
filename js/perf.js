/* perf.js - signal-performance data + shared cell helpers
   Split from index.html. These are CLASSIC scripts, not modules:
   top-level let/const share one global lexical scope, so the
   mutable state variables and the inline onclick handlers keep
   working exactly as before. Load order is load-bearing. */
    /* ══════════════════════════════════════════════════════
       SIGNAL PERFORMANCE — DATA LAYER

       This used to be its own tab. It is now one half of the Performance
       tab, which renders it beside the premium backtest: these rows measure
       the UNDERLYING move after a signal (direction accuracy, over the full
       signal history) while the backtest measures what the CONTRACT paid
       (real money, over the shorter premium history). Two measures of the
       same signals, each with its own sample size.

       What remains here is the fetch plus the cell helpers that both halves
       render through, so the two never format the same quantity differently.
       ══════════════════════════════════════════════════════ */

    /* Fetches ALERTED signal history for the range. Returns rows; does not
       render. perfRows/perfKey cache it so switching range re-fetches but a
       10s live poll does not. */
    async function loadPerfRows(ctx, force) {
      const key = `${currentStrategy}|${ctx.start || ''}|${ctx.end || ''}`;
      if (!force && perfRows && perfKey === key) return perfRows;
      if (perfLoading) return perfRows || [];
      perfLoading = true;
      try {
        // Null start/end makes the RPC span all available history.
        const rows = await rpcWithRetry('v2_signal_performance_by_strategy', null,
          { p_start: ctx.start, p_end: ctx.end, p_strategy: currentStrategy }, 2);
        perfRows = rows || [];
        perfKey = key;
        return perfRows;
      } catch (e) {
        /* Direction stats are the secondary half of the tab. If they fail the
           premium P&L is still worth showing, so this returns empty rather
           than throwing and taking the whole tab down with it. */
        console.warn('Signal performance load failed:', e);
        perfRows = [];
        perfKey = key;
        return perfRows;
      } finally {
        perfLoading = false;
      }
    }

    function hitBar(pct) {
      if (pct == null) return '';
      const col = pct >= 55 ? 'var(--green)' : (pct >= 45 ? 'var(--amber)' : 'var(--red)');
      return `<span class="hitbar"><i style="width:${Math.max(0, Math.min(100, pct))}%;background:${col}"></i><span class="hitbar-50"></span></span>`;
    }

    function pctCell(wins, n) {
      if (!n) return '<span class="muted">-</span>';
      const pct = (wins / n) * 100;
      const cls = pct >= 55 ? 'call' : (pct >= 45 ? '' : 'put');
      return `<span class="${cls}">${pct.toFixed(0)}%</span> <span class="muted">(${wins}/${n})</span>${hitBar(pct)}`;
    }

    function signedCell(v, dp) {
      if (v == null) return '<span class="muted">-</span>';
      const n = +v;
      const cls = n > 0 ? 'call' : (n < 0 ? 'put' : 'muted');
      return `<span class="${cls}">${n > 0 ? '+' : ''}${n.toFixed(dp == null ? 2 : dp)}</span>`;
    }

    // Aggregate a set of signal rows into one summary record.
    function aggPerf(rows) {
      const a = {
        n: rows.length,
        w30: 0, n30: 0, w60: 0, n60: 0, weod: 0, neod: 0,
        sum30: 0, c30: 0, sum60: 0, c60: 0, sumEod: 0, cEod: 0,
        sumMfe: 0, cMfe: 0, sumMae: 0, cMae: 0
      };
      rows.forEach(r => {
        if (r.win_30m !== null && r.win_30m !== undefined) { a.n30++; if (r.win_30m) a.w30++; }
        if (r.win_60m !== null && r.win_60m !== undefined) { a.n60++; if (r.win_60m) a.w60++; }
        if (r.win_eod !== null && r.win_eod !== undefined) { a.neod++; if (r.win_eod) a.weod++; }
        if (r.move_30m != null) { a.sum30 += +r.move_30m; a.c30++; }
        if (r.move_60m != null) { a.sum60 += +r.move_60m; a.c60++; }
        if (r.move_eod != null) { a.sumEod += +r.move_eod; a.cEod++; }
        if (r.mfe_60m != null) { a.sumMfe += +r.mfe_60m; a.cMfe++; }
        if (r.mae_60m != null) { a.sumMae += +r.mae_60m; a.cMae++; }
      });
      a.avg30 = a.c30 ? a.sum30 / a.c30 : null;
      a.avg60 = a.c60 ? a.sum60 / a.c60 : null;
      a.avgEod = a.cEod ? a.sumEod / a.cEod : null;
      a.avgMfe = a.cMfe ? a.sumMfe / a.cMfe : null;
      a.avgMae = a.cMae ? a.sumMae / a.cMae : null;
      // Expectancy proxy: average best-case reach per unit of heat taken.
      a.edge = (a.avgMae && a.avgMae > 0 && a.avgMfe != null) ? a.avgMfe / a.avgMae : null;
      return a;
    }
