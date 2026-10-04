/* perf.js - signal performance tab
   Split from index.html. These are CLASSIC scripts, not modules:
   top-level let/const share one global lexical scope, so the 29
   mutable state variables and the inline onclick handlers keep
   working exactly as before. Load order is load-bearing. */
    /* ══════════════════════════════════════════════════════
       SIGNAL PERFORMANCE TAB
       ══════════════════════════════════════════════════════ */
    async function loadPerf(force) {
      const ctx = getDateContext();
      // strategy is part of the key, or a switch would reuse the other
      // symbol's rows for the same date range
      const key = `${currentStrategy}|${ctx.start || ''}|${ctx.end || ''}`;
      if (!force && perfRows && perfKey === key) {
        renderPerf(perfRows);
        return;
      }
      if (perfLoading) return;
      perfLoading = true;

      const bodyEl = document.getElementById('perf-body');
      if (bodyEl && !perfRows) bodyEl.innerHTML = '<div class="perf-empty">Loading signal history...</div>';

      try {
        // Null start/end makes the RPC span all available history.
        const rows = await rpcWithRetry('v2_signal_performance_by_strategy', null,
          { p_start: ctx.start, p_end: ctx.end, p_strategy: currentStrategy }, 2);
        perfRows = rows || [];
        perfKey = key;
        renderPerf(perfRows);
      } catch (e) {
        if (bodyEl) {
          bodyEl.innerHTML = `<div class="err">Could not load signal performance: ${escapeHtml(e.message)}</div>`;
        }
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

    function perfRowHtml(label, rows, isTotal) {
      const a = aggPerf(rows);
      const edgeCls = a.edge == null ? 'muted' : (a.edge >= 1.5 ? 'call' : (a.edge >= 1 ? '' : 'put'));
      return `<tr class="${isTotal ? 'perf-total' : ''}">
        <td>${label}</td>
        <td>${a.n}</td>
        <td>${pctCell(a.w30, a.n30)}</td>
        <td>${pctCell(a.w60, a.n60)}</td>
        <td>${pctCell(a.weod, a.neod)}</td>
        <td>${signedCell(a.avg30)}</td>
        <td>${signedCell(a.avg60)}</td>
        <td>${signedCell(a.avgEod)}</td>
        <td><span class="call">${a.avgMfe == null ? '-' : a.avgMfe.toFixed(2)}</span></td>
        <td><span class="put">${a.avgMae == null ? '-' : a.avgMae.toFixed(2)}</span></td>
        <td><span class="${edgeCls}">${a.edge == null ? '-' : a.edge.toFixed(2)}</span></td>
      </tr>`;
    }

    function renderPerf(rows) {
      const el = document.getElementById('perf-body');
      if (!el) return;

      if (!rows || !rows.length) {
        el.innerHTML = '<div class="perf-empty">No ALERTED signals in the selected date range. Widen the range with the date presets above — signal history begins 2026-09-08.</div>';
        return;
      }

      const head = `
        <thead>
          <tr>
            <th>Bucket</th><th>Signals</th>
            <th title="Share of signals where price was on the signal's side 30 minutes later">Hit 30m</th>
            <th title="Share of signals where price was on the signal's side 60 minutes later">Hit 60m</th>
            <th title="Share of signals where price closed on the signal's side">Hit EOD</th>
            <th title="Average direction-adjusted move in SPY points at +30m">Avg 30m</th>
            <th title="Average direction-adjusted move in SPY points at +60m">Avg 60m</th>
            <th title="Average direction-adjusted move in SPY points at the close">Avg EOD</th>
            <th title="Max favourable excursion within 60m — your realistic best exit, in points">MFE</th>
            <th title="Max adverse excursion within 60m — the heat you had to survive, in points">MAE</th>
            <th title="MFE / MAE. Above 1.5 means the move paid for the drawdown; under 1 means it did not.">MFE:MAE</th>
          </tr>
        </thead>`;

      // ── By grade × direction ──
      const buckets = [];
      ['A', 'B', 'C', 'D'].forEach(g => {
        ['CALL', 'PUT'].forEach(d => {
          const set = rows.filter(r => r.grade === g && r.direction === d);
          if (set.length) buckets.push([`Grade ${g} · ${d}`, set]);
        });
      });
      const byGrade = buckets.map(b => perfRowHtml(b[0], b[1], false)).join('')
        + perfRowHtml('All signals', rows, true);

      // ── By grade only ──
      const gradeOnly = ['A', 'B', 'C', 'D'].map(g => {
        const set = rows.filter(r => r.grade === g);
        return set.length ? perfRowHtml(`Grade ${g}`, set, false) : '';
      }).join('');

      // ── By hour of day (NY) ──
      const hours = {};
      rows.forEach(r => {
        const h = tsKey(r.candle_time_ny).slice(11, 13);
        (hours[h] = hours[h] || []).push(r);
      });
      const byHour = Object.keys(hours).sort().map(h =>
        perfRowHtml(`${h}:00 – ${h}:59`, hours[h], false)).join('');

      const days = new Set(rows.map(r => r.trade_date)).size;

      el.innerHTML = `
        <div class="perf-section-title">By Grade &amp; Direction
          <span class="hint">${rows.length} signals over ${days} session${days === 1 ? '' : 's'}</span></div>
        <table class="perf-tbl">${head}<tbody>${byGrade}</tbody></table>

        <div class="perf-section-title">By Grade
          <span class="hint">is the score actually ranking your signals?</span></div>
        <table class="perf-tbl">${head}<tbody>${gradeOnly}</tbody></table>

        <div class="perf-section-title">By Hour of Day (NY)
          <span class="hint">which part of the session is worth trading</span></div>
        <table class="perf-tbl">${head}<tbody>${byHour}</tbody></table>
      `;
      updateRowCounts();
    }

