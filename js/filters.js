/* filters.js - tabs, filtering, volume presets, sorting, CSV export
   Split from index.html. These are CLASSIC scripts, not modules:
   top-level let/const share one global lexical scope, so the 29
   mutable state variables and the inline onclick handlers keep
   working exactly as before. Load order is load-bearing. */
    /* ══════════════════════════════════════════════════════
       TAB SWITCHING
       ══════════════════════════════════════════════════════ */
    function switchTab(name) {
      activeTab = name;
      /* This array is matched against the .tab elements BY INDEX, so it has to
         stay in the same order as the markup in index.html. A tab added to one
         and not the other highlights the wrong heading, silently. */
      const order = ['flow', 'vol', 'anomaly', 'prem'];
      document.querySelectorAll('.tab').forEach((t, i) => {
        t.classList.toggle('active', order[i] === name);
      });
      order.forEach(id => {
        const el = document.getElementById('tab-' + id);
        if (el) el.classList.toggle('active', id === name);
      });
      // The Columns menu is per-tab, so close whichever one is open.
      closeColumnMenus();
      if (name === 'prem') loadPremium();
      updateRowCounts();
    }

    /* ══════════════════════════════════════════════════════
       DEBOUNCED FILTERING
       ══════════════════════════════════════════════════════ */
    let debounceTimeout = null;
    function debounceFilter() {
      clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(() => {
        applyFlowFilters();
        applyVolFilters();
        updateRowCounts();
      }, 120);
    }

    function applyFlowFilters() {
      const ft = (document.getElementById('f-time').value || '').trim();
      const fp = (document.getElementById('f-price').value || '').trim();
      const fst = (document.getElementById('f-strike').value || '').trim();
      const ff = (document.getElementById('f-flow').value || '').trim();
      const fd = (document.getElementById('f-dir').value || '').toLowerCase();
      const fpc = (document.getElementById('f-poc').value || '').trim();
      const fr = (document.getElementById('f-room').value || '').trim();
      const fsc = (document.getElementById('f-score').value || '').trim();
      const fg = (document.getElementById('f-grade').value || '').toLowerCase();
      const frs = (document.getElementById('f-status').value || '').toLowerCase();

      document.querySelectorAll('#tbody-flow tr').forEach(row => {
        const c = row.querySelectorAll('td');
        if (!c.length) return;
        let show = true;

        if (ft && c[1].textContent.toLowerCase().indexOf(ft.toLowerCase()) < 0) show = false;
        if (fp && !matchNumericOrText(fp, c[2].textContent)) show = false;
        if (fst && !matchNumericOrText(fst, c[3].textContent)) show = false;
        if (ff && !matchNumericOrText(ff, c[4].textContent)) show = false;

        if (fd) {
          const d = c[5].textContent.toLowerCase().trim();
          if (fd === '-' && d !== '-') show = false;
          else if (fd !== '-' && d.indexOf(fd) < 0) show = false;
        }

        if (fpc && !matchNumericOrText(fpc, c[6].textContent)) show = false;
        if (fr && !matchNumericOrText(fr, c[7].textContent)) show = false;
        if (fsc && !matchNumericOrText(fsc, c[13].textContent)) show = false;
        if (fg && c[14].textContent.toLowerCase().indexOf(fg) < 0) show = false;
        if (frs && c[15].textContent.toLowerCase().indexOf(frs) < 0) show = false;

        row.classList.toggle('hidden', !show);
      });
    }

    function applyVolFilters() {
      const gv = (id) => { const el = document.getElementById(id); return el ? (el.value || '') : ''; };
      const vt  = gv('v-time').trim().toLowerCase();
      const vv  = gv('v-vol').trim();
      const vrv = gv('v-rvol').trim();
      const vtr = gv('v-trend').toLowerCase();
      const vcc = gv('v-callchg').toLowerCase();
      const vpc = gv('v-putchg').toLowerCase();
      const vn  = gv('v-notional').trim();
      const vr  = gv('v-ratio').toLowerCase();
      const vd  = gv('v-dcp').toLowerCase();
      const vg  = gv('v-grid').toLowerCase();
      const va  = gv('v-anomaly').toLowerCase();

      document.querySelectorAll('#tbody-vol tr').forEach(row => {
        const c = row.querySelectorAll('td');
        if (!c.length) return;
        const d = row.dataset;
        let show = true;

        if (vt && c[1].textContent.toLowerCase().indexOf(vt) < 0) show = false;
        // Numeric filters read the dataset rather than cell text, so they keep
        // working when a column is hidden or abbreviated (e.g. "4.5M").
        if (vv  && !matchNumericOrText(vv,  d.tvol || '')) show = false;
        if (vrv && !matchNumericOrText(vrv, d.rvol || '')) show = false;
        if (vn  && !matchNumericOrText(vn,  d.notional || '')) show = false;

        if (vtr) {
          if (vtr === 'up' && d.trend !== 'up') show = false;
          if (vtr === 'dn' && d.trend !== 'dn') show = false;
        }
        if (vcc) {
          if (vcc === 'up' && d.callchg !== 'up') show = false;
          if (vcc === 'dn' && d.callchg !== 'dn') show = false;
        }
        if (vpc) {
          if (vpc === 'up' && d.putchg !== 'up') show = false;
          if (vpc === 'dn' && d.putchg !== 'dn') show = false;
        }
        if (vr) {
          const ratio = parseFloat(d.ratio || '');
          if (isNaN(ratio)) show = false;
          else {
            if (vr === 'call-heavy' && ratio <= 1.0) show = false;
            if (vr === 'put-heavy'  && ratio >= 1.0) show = false;
          }
        }
        if (vd) {
          const dr = parseFloat(d.dratio || '');
          if (vd === 'divergent') {
            if (d.diverge !== '1') show = false;
          } else if (isNaN(dr)) {
            show = false;
          } else {
            if (vd === 'call-heavy' && dr <= 1.0) show = false;
            if (vd === 'put-heavy'  && dr >= 1.0) show = false;
          }
        }
        if (vg) {
          if (vg === 'edge' && d.gridedge !== '1') show = false;
          if (vg === 'ok'   && d.gridedge !== '0') show = false;
        }
        if (va && (d.anomaly || '').toLowerCase().indexOf(va) < 0) show = false;
        if (volSurgeOnly && !(d.anomaly || '')) show = false;

        row.classList.toggle('hidden', !show);
      });
    }

    /* Quick-filter presets for the volume tab. */
    function applyVolPreset(preset) {
      document.querySelectorAll('.preset-btn.vpreset').forEach(b => b.classList.remove('active'));
      if (window.event && window.event.target) window.event.target.classList.add('active');

      ['v-time', 'v-vol', 'v-rvol', 'v-notional'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
      });
      ['v-trend', 'v-callchg', 'v-putchg', 'v-ratio', 'v-dcp', 'v-grid', 'v-anomaly'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
      });
      // "Surge Only" spans three anomaly types, so it is a flag rather than a
      // value in the anomaly dropdown.
      volSurgeOnly = (preset === 'surge');

      switch (preset) {
        case 'rvol2':
          document.getElementById('v-rvol').value = '>=2';
          break;
        case 'divergence':
          document.getElementById('v-dcp').value = 'divergent';
          break;
        case 'gridedge':
          document.getElementById('v-grid').value = 'edge';
          break;
      }
      applyVolFilters();
      updateRowCounts();
    }

    /* Session cumulative strip, driven by the candles of the visible session. */
    function renderVolSession(rows) {
      const strip = document.getElementById('vol-session-strip');
      const body = document.getElementById('vol-session-body');
      if (!strip || !body) return;
      if (!rows || !rows.length) { strip.style.display = 'none'; return; }

      const last = rows[rows.length - 1];
      const cpc = last.session_cp_ratio == null ? null : +last.session_cp_ratio;

      // Per-side session dollars are summed client-side; the RPC exposes
      // per-candle notional plus a combined cumulative.
      let cumCall = 0, cumPut = 0, edgeCandles = 0, divergent = 0;
      rows.forEach(r => {
        cumCall += +(r.call_notional || 0);
        cumPut += +(r.put_notional || 0);
        if (r.near_grid_edge) edgeCandles++;
        if (r.cp_divergence) divergent++;
      });
      const dcp = cumPut > 0 ? cumCall / cumPut : null;
      const disagrees = (dcp != null && cpc != null && ((dcp > 1) !== (cpc > 1)));

      const items = [
        '<div class="rg-item" title="Session contracts traded, calls / puts">' +
          '<div class="rg-label">Contracts</div>' +
          '<div class="rg-val"><span class="call">' + fmtCompact(last.cum_calls) + '</span>' +
          '<span class="muted"> / </span><span class="put">' + fmtCompact(last.cum_puts) + '</span></div>' +
          '<div class="rg-sub">total ' + fmtCompact(last.cum_vol) + '</div></div>',

        '<div class="rg-item" title="Session call/put ratio by contract count">' +
          '<div class="rg-label">Session C/P</div>' +
          '<div class="rg-val ' + (cpc == null ? 'muted' : (cpc > 1 ? 'call' : 'put')) + '">' +
          (cpc == null ? '-' : cpc.toFixed(2)) + '</div>' +
          '<div class="rg-sub">' + (cpc == null ? '' : (cpc > 1 ? 'call heavy' : 'put heavy')) + '</div></div>',

        '<div class="rg-item" title="Session premium traded in dollars (OTM+ITM; ATM has no notional in the source data)">' +
          '<div class="rg-label">$ Traded</div>' +
          '<div class="rg-val">' + fmtDollar(cumCall + cumPut) + '</div>' +
          '<div class="rg-sub"><span class="call">' + fmtDollar(cumCall) + '</span> / <span class="put">' +
          fmtDollar(cumPut) + '</span></div></div>',

        '<div class="rg-item" title="Session dollar-weighted call/put ratio. Compare with Session C/P: a gap means contract count and money disagree.">' +
          '<div class="rg-label">Session $ C/P</div>' +
          '<div class="rg-val ' + (dcp == null ? 'muted' : (dcp > 1 ? 'call' : 'put')) + '">' +
          (dcp == null ? '-' : dcp.toFixed(2)) + '</div>' +
          '<div class="rg-sub">' + (disagrees ? '<span class="dcp-diverge">disagrees with count</span>' : 'agrees with count') +
          '</div></div>',

        '<div class="rg-item" title="Candles where the dollar ratio and the contract ratio pointed to opposite sides of parity">' +
          '<div class="rg-label">Divergent</div>' +
          '<div class="rg-val ' + (divergent ? 'dcp-diverge' : 'muted') + '">' + divergent + '</div>' +
          '<div class="rg-sub">of ' + rows.length + ' candles</div></div>',

        '<div class="rg-item" title="Candles where price sat within 2 strikes of the captured grid edge, so the OTM buckets were truncated and totals understate">' +
          '<div class="rg-label">Grid Edge</div>' +
          '<div class="rg-val ' + (edgeCandles ? 'rvol-warm' : 'muted') + '">' + edgeCandles + '</div>' +
          '<div class="rg-sub">' + (edgeCandles ? 'totals understated' : 'fully inside') + '</div></div>'
      ];

      strip.style.display = 'flex';
      body.innerHTML = items.join('');
    }

    function updateRowCounts() {
      if (activeTab === 'prem') {
        const n = premRows ? premRows.length : 0;
        const d = premRows ? new Set(premRows.map(r => r.trade_date)).size : 0;
        const sn = perfRows ? perfRows.length : 0;
        document.getElementById('row-counts').textContent =
          `${n} priced trade${n === 1 ? '' : 's'} over ${d} session${d === 1 ? '' : 's'}`
          + ` - ${sn} alerted signal${sn === 1 ? '' : 's'} for direction`;
        return;
      }
      const tbodyId = activeTab === 'flow' ? '#tbody-flow' : (activeTab === 'vol' ? '#tbody-vol' : '#tbody-anomaly');
      const total = document.querySelectorAll(`${tbodyId} tr`).length;
      const visible = document.querySelectorAll(`${tbodyId} tr:not(.hidden)`).length;
      document.getElementById('row-counts').textContent = `Showing ${visible} of ${total} records`;
    }

    function clearFilters() {
      document.querySelectorAll('.filter-row input').forEach(el => el.value = '');
      document.querySelectorAll('.filter-row select').forEach(el => el.value = '');
      // Reset both preset bars back to "All" so the highlight matches reality.
      volSurgeOnly = false;
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.preset-bar').forEach(bar => {
        const first = bar.querySelector('.preset-btn');
        if (first) first.classList.add('active');
      });
      applyFlowFilters();
      applyVolFilters();
      updateRowCounts();
    }

    /* ══════════════════════════════════════════════════════
       COLUMN SORT ENGINE (#17 — re-applies after render)
       ══════════════════════════════════════════════════════ */
    function handleSort(tabName, colIndex, isNumeric) {
      const cfg = sortConfig[tabName];
      if (cfg.col === colIndex) {
        cfg.asc = !cfg.asc;
      } else {
        cfg.col = colIndex;
        cfg.asc = true;
      }
      applySort(tabName);
    }

    function applySort(tabName) {
      const cfg = sortConfig[tabName];
      if (cfg.col === null) return;

      const table = document.getElementById(tabName === 'flow' ? 'tbl-flow' : 'tbl-vol');
      table.querySelectorAll('th.sortable').forEach(th => {
        th.classList.remove('sorted-asc', 'sorted-desc');
      });
      const th = table.querySelectorAll('thead tr:first-child th')[cfg.col];
      if (th) th.classList.add(cfg.asc ? 'sorted-asc' : 'sorted-desc');

      const tbody = document.getElementById(tabName === 'flow' ? 'tbody-flow' : 'tbody-vol');
      const rows = Array.from(tbody.querySelectorAll('tr'));

      // Abbreviated cells ("$4.5M", "1.2k", "2.10x") cannot be sorted from
      // their text, so those cells carry a raw numeric data-sortval which wins
      // when present.
      const cellVal = (row) => {
        const td = row.children[cfg.col];
        if (!td) return '';
        const sv = td.dataset ? td.dataset.sortval : undefined;
        if (sv !== undefined && sv !== '') return sv;
        return (td.textContent || '').trim().replace(/,/g, '').replace(/%/g, '');
      };

      // Determine if column is numeric based on content
      const isNumeric = rows.length > 0 && !isNaN(parseFloat(cellVal(rows[0])));

      rows.sort((a, b) => {
        const cellA = cellVal(a);
        const cellB = cellVal(b);

        if (isNumeric) {
          const numA = parseFloat(cellA) || 0;
          const numB = parseFloat(cellB) || 0;
          return cfg.asc ? (numA - numB) : (numB - numA);
        }
        return cfg.asc ? cellA.localeCompare(cellB) : cellB.localeCompare(cellA);
      });

      rows.forEach(r => tbody.appendChild(r));
    }

    /* ══════════════════════════════════════════════════════
       CSV EXPORT
       ══════════════════════════════════════════════════════ */
    function exportCurrentCSV() {
      // On the Performance tab, export the per-trade ledger rather than the
      // rendered summary tables - that is what is useful in a spreadsheet.
      if (activeTab === 'prem') {
        if (!premRows || !premRows.length) return alert('No priced trades to export.');
        const cols = ['trade_date', 'candle_time_ny', 'grade', 'score', 'direction',
          'has_signal', 'underlying', 'poc', 'strike', 'expiry', 'contract',
          'entry_px', 'exit_px', 'exit_time_ny', 'mins_held', 'outcome',
          'pnl', 'pnl_pct', 'mfe', 'mae', 'bars_available',
          'call_volume', 'put_volume', 'cp_ratio', 'side_bias',
          'rvol', 'dollar_traded', 'contract_vol_candle',
          'entry_iv', 'entry_delta', 'exit_iv', 'iv_change'];
        const lines = [cols.join(',')].concat(premRows.map(r =>
          cols.map(c => `"${String(r[c] == null ? '' : r[c]).replace(/"/g, '""')}"`).join(',')));
        const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `performance_${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        return;
      }

      // Volume cells are abbreviated ($4.5M, 1.2k), so export the raw rows.
      if (activeTab === 'vol') {
        if (!volRowsCache || !volRowsCache.length) return alert('No data to export.');
        const cols = ['trade_date', 'candle_time_ny', 'price', 'atm_strike',
          'calls_otm', 'puts_otm', 'calls_itm_atm', 'puts_itm_atm', 'calls_atm', 'puts_atm',
          'total_calls', 'total_puts', 'total_vol',
          'rvol_tod', 'rvol_tod_z', 'tod_samples', 'vol_trend_3',
          'calls_pct_chg', 'puts_pct_chg', 'total_pct_chg',
          'call_notional', 'put_notional', 'total_notional',
          'call_put_ratio', 'call_put_ratio_ex_atm', 'dollar_cp_ratio', 'cp_divergence',
          'avg_call_premium', 'avg_put_premium',
          'cum_calls', 'cum_puts', 'cum_vol', 'cum_notional', 'session_cp_ratio',
          'lowest_strike', 'highest_strike', 'grid_room_low', 'grid_room_high', 'near_grid_edge'];
        const lines = [cols.join(',')].concat(volRowsCache.map(r =>
          cols.map(c => `"${String(r[c] == null ? '' : r[c]).replace(/"/g, '""')}"`).join(',')));
        const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `option_volume_${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        return;
      }

      const tableId = activeTab === 'flow' ? 'tbl-flow'
        : (activeTab === 'vol' ? 'tbl-vol' : 'tbl-anomaly');
      const table = document.getElementById(tableId);
      const rows = Array.from(table.querySelectorAll('tr:not(.hidden):not(.filter-row)'));
      if (!rows.length) return alert('No data to export.');

      const csv = rows.map(r => {
        const cells = Array.from(r.querySelectorAll('th, td')).map(c => `"${c.textContent.trim().replace(/"/g, '""')}"`);
        return cells.join(',');
      }).join('\n');

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${activeTab}_export_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }

