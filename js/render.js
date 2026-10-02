/* render.js - KPI cards, sticky header offsets, the three tables
   Split from index.html. These are CLASSIC scripts, not modules:
   top-level let/const share one global lexical scope, so the 29
   mutable state variables and the inline onclick handlers keep
   working exactly as before. Load order is load-bearing. */
    /* ══════════════════════════════════════════════════════
       RENDER: CARDS (with sparklines #9, VA legend #11,
       signal timestamp #12, error boundary #18)
       ══════════════════════════════════════════════════════ */
    function renderCards(rows, volRows) {
      try {
        _renderCardsInner(rows, volRows);
      } catch (e) {
        console.error('renderCards error:', e);
        document.getElementById('err').innerHTML += `<div class="err">Card render error: ${escapeHtml(e.message)}</div>`;
      }
    }

    function _renderCardsInner(rows, volRows) {
      updateSentimentBar(rows, volRows);

      if (!rows || !rows.length) {
        document.getElementById('cards').innerHTML = `
          <div class="status quiet">No session data recorded for selected date.</div>
          <div class="card"><div class="label">SPY Last</div><div class="val">-</div></div>
          <div class="card"><div class="label">Session Trend</div><div class="val muted">FLAT</div></div>
          <div class="card"><div class="label">Signals Today</div><div class="val">0</div></div>
          <div class="card"><div class="label">POC / VAL / VAH</div><div class="val" style="font-size:13px">- / - / -</div></div>
          <div class="card"><div class="label">Latest Flow</div><div class="val muted">-</div></div>
        `;
        document.getElementById('sub').textContent = 'No data';
        document.getElementById('live-dot').style.display = 'none';
        requestAnimationFrame(syncNewsPanelHeight);
        return;
      }

      const last = rows[rows.length - 1];
      const sigs = rows.filter(x => x.has_signal);
      const open = rows[0].price;
      const close = last.price;
      const trend = close > open ? 'UP' : (close < open ? 'DOWN' : 'FLAT');
      const trendColor = trend === 'UP' ? 'call' : (trend === 'DOWN' ? 'put' : 'muted');
      const day = (last.candle_time_ny || '').slice(0, 10);
      document.getElementById('sub').textContent =
        `Session ${escapeHtml(day)} | ${rows.length} candles | latest ${fmtTime(last.candle_time_ny)}`;

      // ── STALE SESSION WARNING ──────────────────────────────────────────
      const errEl = document.getElementById('err');
      const todayNY = todayStr();
      if (day && day !== todayNY) {
        errEl.innerHTML = `<div class="err">⚠️ No data for today (${todayNY}). Showing last session: ${escapeHtml(day)} — market closed or weekend.</div>`;
      } else {
        if (errEl.innerHTML.includes('last session')) errEl.innerHTML = '';
      }

      // (#9) Collect sparkline data
      priceHistory = rows.map(r => r.price).filter(p => p != null);
      flowHistory = rows.map(r => r.flow).filter(f => f != null);

      const liveDot = document.getElementById('live-dot');
      let statusHtml = '';
      if (last.has_signal) {
        liveDot.style.display = 'inline-block';
        const d = escapeHtml(last.direction);
        const cls = d === 'PUT' ? 'put' : 'call';
        // (#12) Include timestamp on live signal
        const sigTime = fmtTime(last.candle_time_ny);
        statusHtml = `
      <div class="status live">
        <div style="display:flex;align-items:center;gap:6px">
          <span class="dot pulse"></span>
          <span>LIVE SIGNAL</span>
          ${gradePill(last.grade)}
          <span class="${cls}">${d}</span>
        </div>
        <div style="font-size:12px;font-weight:500">
          Strike <b>${escapeHtml(last.atm_strike)}</b> &nbsp;|&nbsp; 
          Flow <b>${escapeHtml(last.flow)}</b> &nbsp;|&nbsp; 
          Room <b>${escapeHtml(last.room)}</b> &nbsp;|&nbsp;
          <span class="muted">Fired at ${sigTime}</span>
        </div>
      </div>`;

        if (last.candle_time_ny !== lastAlertTimestamp) {
          lastAlertTimestamp = last.candle_time_ny;
          playChime(last.direction);
          // Called here rather than inside sendPushNotification(), which bails
          // out unless Push is on AND the OS granted permission — the in-page
          // card has to show up regardless of that.
          pushStickyAlert({
            kind: last.direction === 'PUT' ? 'put' : 'call',
            title: `🚨 SPY ${last.direction} Signal · Score ${last.score}`,
            rows: [
              ['Strike', last.atm_strike],
              ['Price', last.price],
              ['Flow', last.flow],
              ['Room', last.room],
              ['Grade', last.grade]
            ],
            ts: last.candle_time_ny
          });
          sendPushNotification(last);
        }
      } else {
        liveDot.style.display = 'none';
        statusHtml = `<div class="status quiet">No active signal on latest candle (${fmtTime(last.candle_time_ny)}).</div>`;
      }

      // Update Session Flow & Volume Sentiment Bar
      updateSentimentBar(rows, volRows);

      // VA Gauge with legend (#11)
      let vaGaugeHtml = '';
      if (last.poc != null && last.val != null && last.vah != null && last.price != null) {
        // Include the gamma walls in the gauge scale when we have them, so the
        // markers can't land outside the track.
        const cw = regimeCtx && regimeCtx.call_wall != null ? +regimeCtx.call_wall : null;
        const pw = regimeCtx && regimeCtx.put_wall != null ? +regimeCtx.put_wall : null;
        const lows = [last.val, last.price].concat(pw != null ? [pw] : []).concat(cw != null ? [cw] : []);
        const highs = [last.vah, last.price].concat(cw != null ? [cw] : []).concat(pw != null ? [pw] : []);
        const minVal = Math.min.apply(null, lows) - 1;
        const maxVal = Math.max.apply(null, highs) + 1;
        const span = (maxVal - minVal) || 1;
        const pos = (v) => Math.max(0, Math.min(100, ((v - minVal) / span) * 100));
        const valPct = pos(last.val);
        const vahPct = pos(last.vah);
        const pocPct = pos(last.poc);
        const prcPct = pos(last.price);

        let wallsHtml = '', wallsLegend = '';
        if (cw != null) {
          wallsHtml += `<div class="va-wall va-wall-c" style="left:${pos(cw)}%" title="Call wall ${cw}"></div>`;
        }
        if (pw != null) {
          wallsHtml += `<div class="va-wall va-wall-p" style="left:${pos(pw)}%" title="Put wall ${pw}"></div>`;
        }
        if (cw != null || pw != null) {
          wallsLegend =
            (cw != null ? '<span class="leg-cw"><span class="leg-dot"></span>Call Wall</span>' : '') +
            (pw != null ? '<span class="leg-pw"><span class="leg-dot"></span>Put Wall</span>' : '');
        }

        const wallTitle = (cw != null || pw != null)
          ? ` | Call Wall: ${cw ?? '-'} | Put Wall: ${pw ?? '-'}` : '';

        vaGaugeHtml = `
      <div class="va-track" title="VAL: ${last.val} | POC: ${last.poc} | VAH: ${last.vah}${wallTitle}">
        <div class="va-range" style="left:${valPct}%;width:${Math.max(2, vahPct - valPct)}%"></div>
        ${wallsHtml}
        <div class="va-poc" style="left:${pocPct}%"></div>
        <div class="va-price" style="left:${prcPct}%"></div>
      </div>
      <div class="va-legend">
        <span class="leg-price"><span class="leg-dot"></span>Price</span>
        <span class="leg-poc"><span class="leg-dot"></span>POC</span>
        <span class="leg-va"><span class="leg-dot"></span>Value Area</span>
        ${wallsLegend}
      </div>`;
      }

      document.getElementById('cards').innerHTML = `
    ${statusHtml}
    <div class="card">
      <div class="label">SPY Last</div>
      <div class="val">${escapeHtml(close)}</div>
      <div class="sparkline-wrap"><canvas id="spark-price"></canvas></div>
    </div>
    <div class="card">
      <div class="label">Session Trend</div>
      <div class="val ${trendColor}">${trend}</div>
    </div>
    <div class="card">
      <div class="label">Signals Today</div>
      <div class="val">${sigs.length}</div>
    </div>
    <div class="card">
      <div class="label">POC / VAL / VAH</div>
      <div class="val" style="font-size:13px">${last.poc ?? '-'} / ${last.val ?? '-'} / ${last.vah ?? '-'}</div>
      ${vaGaugeHtml}
    </div>
    <div class="card">
      <div class="label">Latest Flow</div>
      <div class="val ${(last.direction === 'PUT' || (last.flow && last.flow < 0)) ? 'flowneg' : ((last.direction === 'CALL' || (last.flow && last.flow > 0)) ? 'flowpos' : 'muted')}">${escapeHtml(last.flow ?? '-')}</div>
      <div class="sparkline-wrap"><canvas id="spark-flow"></canvas></div>
    </div>
  `;

      // (#9) Draw sparklines after DOM is updated
      requestAnimationFrame(() => {
        /* Canvas cannot read var(), so the stroke colours were hardcoded to
           the dark palette and stayed dark-green on a white card. Resolve the
           tokens at draw time instead - this runs on every render, so it
           follows a theme switch without extra wiring. */
        const pos = themeColor('--green'), neg = themeColor('--red');
        drawSparkline('spark-price', priceHistory, pos);
        drawSparkline('spark-flow', flowHistory,
          (flowHistory.length && flowHistory[flowHistory.length - 1] >= 0) ? pos : neg);
        syncNewsPanelHeight();
      });
    }

    /* The news panel now stretches to the header row via CSS grid
       (align-items: stretch), so the old JS height-matching is not only
       unnecessary, its inline style would override the stylesheet. Clear any
       stale inline height and let CSS own the sizing. */
    /* The filter row sticks directly beneath the label row, so its `top` has
       to equal that row's real height. It was the literal 27px - a measurement
       taken once - which silently desynced from any change to th padding or
       font size, leaving a gap or an overlap with no error anywhere.

       Measured here instead, and re-measured by a ResizeObserver so a zoom, a
       late-loading font or a wrapped header all keep it flush. */
    function syncStickyHeaderOffsets() {
      document.querySelectorAll('table').forEach(tbl => {
        const head = tbl.querySelector('thead tr:first-child');
        if (!head || !tbl.querySelector('thead tr.filter-row')) return;
        const h = head.getBoundingClientRect().height;
        // A hidden tab measures 0; keep the last good value rather than
        // collapsing the offset to nothing.
        if (h) tbl.style.setProperty('--thead-h', h + 'px');
      });
    }

    let theadObserver = null;
    function watchStickyHeaders() {
      syncStickyHeaderOffsets();
      if (typeof ResizeObserver !== 'function') return;   // CSS fallback covers it
      if (theadObserver) theadObserver.disconnect();
      theadObserver = new ResizeObserver(syncStickyHeaderOffsets);
      document.querySelectorAll('thead tr:first-child').forEach(r => theadObserver.observe(r));
    }

    function syncNewsPanelHeight() {
      const panel = document.getElementById('news-panel');
      if (panel && panel.style.height) panel.style.height = '';
    }

    /* ══════════════════════════════════════════════════════
       RENDER: FLOW TABLE (with error boundary #18)
       ══════════════════════════════════════════════════════ */
    function renderFlow(rows) {
      try {
        _renderFlowInner(rows);
      } catch (e) {
        console.error('renderFlow error:', e);
        document.getElementById('err').innerHTML += `<div class="err">Flow table render error: ${escapeHtml(e.message)}</div>`;
      }
    }

    function _renderFlowInner(rows) {
      if (!rows || !rows.length) {
        document.getElementById('tbody-flow').innerHTML = '';
        return;
      }

      // Sort pinned rows to the top
      const sortedRows = rows.slice().reverse().sort((a, b) => {
        const keyA = (a.candle_time_ny || '') + '_' + (a.atm_strike || '');
        const keyB = (b.candle_time_ny || '') + '_' + (b.atm_strike || '');
        const pinA = pinnedFlow.has(keyA) ? 1 : 0;
        const pinB = pinnedFlow.has(keyB) ? 1 : 0;
        return pinB - pinA;
      });

      const body = sortedRows.map(x => {
        const rowKey = (x.candle_time_ny || '') + '_' + (x.atm_strike || '');
        const isPinned = pinnedFlow.has(rowKey);
        const dirCls = x.direction === 'PUT' ? 'put' : (x.direction === 'CALL' ? 'call' : 'muted');
        const flowCls = (x.direction === 'PUT' || (x.flow && x.flow < 0)) ? 'flowneg' : ((x.direction === 'CALL' || (x.flow && x.flow > 0)) ? 'flowpos' : 'muted');
        let statusCell = '', statusClass = 'reason-col';

        if (x.has_signal) {
          statusCell = `${gradePill(x.grade)} ALERTED`;
          statusClass += ' fired';
        } else if (x.direction === 'none') {
          statusCell = '<span class="muted">flow below threshold</span>';
        } else {
          statusCell = escapeHtml((x.reason || '-').replace(/^no signal - /i, ''));
        }

        const anom = anomalyMap[tsKey(x.candle_time_ny)];
        if (anom) statusCell += ' ' + surgePill(anom.anomaly_type);

        const jsonStr = escapeHtml(JSON.stringify(x));

        return `
      <tr class="${x.has_signal ? 'sig' : ''} ${x.is_flip ? 'flip' : ''} ${isPinned ? 'pinned' : ''}" onclick='openSignalJournal(${jsonStr})' style="cursor:pointer" title="Click to view signal detail & copy trade log">
        <td><button class="pin-btn" onclick="togglePinFlow('${rowKey}', event)">${isPinned ? '📌' : '📍'}</button></td>
        <td class="col-time">${fmtTime(x.candle_time_ny)}</td>
        <td class="col-price">${escapeHtml(x.price)}</td>
        <td class="col-strike">${escapeHtml(x.atm_strike)}${x.is_flip ? ' (flip)' : ''}</td>
        <td class="col-flow ${flowCls}">${escapeHtml(x.flow)}</td>
        <td class="col-dir ${dirCls}">${x.direction === 'none' ? '-' : escapeHtml(x.direction)}</td>
        <td class="col-poc muted">${x.poc == null ? '-' : escapeHtml(x.poc)}</td>
        <td class="col-room">${x.room == null ? '-' : escapeHtml(x.room)}</td>
        <td class="col-fl">${escapeHtml(x.s_flow || 0)}</td>
        <td class="col-vol">${escapeHtml(x.s_vol || 0)}</td>
        <td class="col-inst">${escapeHtml(x.s_inst || 0)}</td>
        <td class="col-rm">${gate(x.room_ok)}</td>
        <td class="col-cln">${gate(x.s_clean > 0)}</td>
        <td class="col-score">${x.direction === 'none' ? '' : escapeHtml(x.score)}</td>
        <td class="col-grade">${x.direction === 'none' ? '' : gradePill(x.grade)}</td>
        <td class="${statusClass}">${statusCell}</td>
      </tr>`;
      }).join('');

      document.getElementById('tbody-flow').innerHTML = body;
      applyFlowFilters();
      applyHiddenCols();
    }

    /* ══════════════════════════════════════════════════════
       RENDER: VOLUME TABLE (with error boundary #18)
       ══════════════════════════════════════════════════════ */
    function renderVol(rows) {
      try {
        _renderVolInner(rows);
      } catch (e) {
        console.error('renderVol error:', e);
        document.getElementById('err').innerHTML += `<div class="err">Volume table render error: ${escapeHtml(e.message)}</div>`;
      }
    }

    function _renderVolInner(rows) {
      volRowsCache = rows || null;
      renderVolSession(rows);

      /* Keyed the same way anomalyMap is, so the signal modal can join a flow
         row to its volume candle -- the two come from separate RPCs. Rebuilt
         (not merged) on every load, or a stale entry from the previous range
         could be shown against a signal from the current one. */
      volMap = {};
      (rows || []).forEach(r => { volMap[tsKey(r.candle_time_ny)] = r; });

      if (!rows || !rows.length) {
        document.getElementById('tbody-vol').innerHTML = '';
        return;
      }

      // Sort pinned rows to top
      const sortedRows = rows.slice().reverse().sort((a, b) => {
        const keyA = (a.candle_time_ny || '') + '_' + (a.atm_strike || '');
        const keyB = (b.candle_time_ny || '') + '_' + (b.atm_strike || '');
        const pinA = pinnedVol.has(keyA) ? 1 : 0;
        const pinB = pinnedVol.has(keyB) ? 1 : 0;
        return pinB - pinA;
      });

      const body = sortedRows.map(x => {
        const rowKey = (x.candle_time_ny || '') + '_' + (x.atm_strike || '');
        const isPinned = pinnedVol.has(rowKey);

        const cpct = x.calls_pct_chg;
        const ppct = x.puts_pct_chg;
        const callChgCls = cpct == null ? 'flat' : (cpct > 0 ? 'up' : 'dn');
        const putChgCls = ppct == null ? 'flat' : (ppct > 0 ? 'up' : 'dn');
        const cChgTxt = cpct == null ? '-' : `${cpct > 0 ? '+' : ''}${cpct}%`;
        const pChgTxt = ppct == null ? '-' : `${ppct > 0 ? '+' : ''}${ppct}%`;

        // ── rVOL vs same time of day across earlier sessions ──
        const rv = x.rvol_tod == null ? null : +x.rvol_tod;
        const rz = x.rvol_tod_z == null ? null : +x.rvol_tod_z;
        const samples = x.tod_samples == null ? 0 : +x.tod_samples;
        let rvolCls = 'rvol-cool';
        if (rv != null) {
          if (rv >= 2) rvolCls = 'rvol-hot';
          else if (rv >= 1.3) rvolCls = 'rvol-warm';
        }
        // Fewer than 5 prior sessions at this time slot is not a usable baseline.
        const thin = samples > 0 && samples < 5;
        const rvolHtml = rv == null
          ? `<span class="muted" title="No earlier session has data for this time slot yet">-</span>`
          : `<span class="rvol-cell ${thin ? 'rvol-thin' : ''}" title="${x.total_vol} vs ${samples}-session average at this time of day${thin ? ' — only ' + samples + ' sessions, treat as provisional' : ''}">
               <b class="${rvolCls}">${rv.toFixed(2)}x</b>
               <span class="rvol-z">${rz == null ? '' : (rz > 0 ? '+' : '') + rz.toFixed(1) + 'σ'}</span>
             </span>`;

        // ── smoothed volume trend ──
        const tr = x.vol_trend_3 == null ? null : +x.vol_trend_3;
        const trendCls = tr == null ? 'flat' : (tr > 0 ? 'up' : 'dn');
        const trendTxt = tr == null ? '-' : `${tr > 0 ? '+' : ''}${tr.toFixed(0)}%`;

        // ── dollars ──
        const notional = x.total_notional == null ? null : +x.total_notional;
        const dcp = x.dollar_cp_ratio == null ? null : +x.dollar_cp_ratio;
        const ratio = x.call_put_ratio == null ? null : +x.call_put_ratio;
        const diverges = x.cp_divergence === true;

        const ratioCls = ratio == null ? 'flat' : (ratio > 1 ? 'call' : 'put');
        const totCalls = +(x.total_calls || 0);
        const totPuts = +(x.total_puts || 0);
        const sum = totCalls + totPuts;
        const callShare = sum > 0 ? Math.round((totCalls / sum) * 100) : 50;

        const ratioBarHtml = `
      <div class="ratio-wrap">
        <span class="${ratioCls}">${ratio == null ? '-' : ratio.toFixed(2)}</span>
        <div class="ratio-bar" title="Calls: ${callShare}% | Puts: ${100 - callShare}% (by contract count)">
          <div class="ratio-bar-call" style="width:${callShare}%"></div>
        </div>
      </div>`;

        const dcpCls = dcp == null ? 'flat' : (diverges ? 'dcp-diverge' : (dcp > 1 ? 'call' : 'put'));
        const dcpHtml = dcp == null
          ? '<span class="muted">-</span>'
          : `<span class="${dcpCls}" title="${fmtDollar(x.call_notional)} calls vs ${fmtDollar(x.put_notional)} puts${diverges ? ' — OPPOSITE side to the contract ratio (' + (ratio == null ? '?' : ratio.toFixed(2)) + ')' : ''}">${dcp.toFixed(2)}</span>`
            + (diverges ? '<span class="diverge-mark" title="Dollar ratio and contract ratio disagree on side">⚠</span>' : '');

        const acp = x.avg_call_premium == null ? null : +x.avg_call_premium;
        const app = x.avg_put_premium == null ? null : +x.avg_put_premium;
        const premHtml = (acp == null && app == null)
          ? '<span class="muted">-</span>'
          : `<span class="prem-pair" title="Average premium per contract paid this candle (OTM+ITM; ITM includes intrinsic)">
               <span class="call">${acp == null ? '-' : acp.toFixed(2)}</span><span class="muted">/</span><span class="put">${app == null ? '-' : app.toFixed(2)}</span>
             </span>`;

        // ── grid coverage ──
        const edge = x.near_grid_edge === true;
        const gridHtml = x.lowest_strike == null
          ? '<span class="muted">-</span>'
          : `<span class="grid-pill ${edge ? 'grid-warn' : 'grid-ok'}" title="Captured grid ${x.lowest_strike}–${x.highest_strike}; price is ${x.grid_room_low} above the low edge and ${x.grid_room_high} below the high edge${edge ? '. Within 2 strikes of an edge, so the OTM buckets are truncated and these totals understate.' : ''}">${edge ? '⚠ EDGE' : 'OK'}</span>`;

        const anom = anomalyMap[tsKey(x.candle_time_ny)];
        const anomType = anom ? anom.anomaly_type : '';
        const anomRowCls = anom ? (anomType === 'CALL SURGE' ? 'anomaly-call' : (anomType === 'PUT SURGE' ? 'anomaly-put' : 'anomaly-mixed')) : '';

        return `
      <tr class="${isPinned ? 'pinned' : ''} ${anomRowCls}"
          data-tvol="${x.total_vol == null ? '' : x.total_vol}"
          data-rvol="${rv == null ? '' : rv}"
          data-trend="${trendCls}"
          data-callchg="${callChgCls}"
          data-putchg="${putChgCls}"
          data-notional="${notional == null ? '' : notional}"
          data-ratio="${ratio == null ? '' : ratio}"
          data-dratio="${dcp == null ? '' : dcp}"
          data-diverge="${diverges ? '1' : '0'}"
          data-gridedge="${x.lowest_strike == null ? '' : (edge ? '1' : '0')}"
          data-anomaly="${anomType}">
        <td><button class="pin-btn" onclick="togglePinVol('${rowKey}', event)">${isPinned ? '📌' : '📍'}</button></td>
        <td class="vcol-time">${fmtTime(x.candle_time_ny)}</td>
        <td class="vcol-price">${escapeHtml(x.price)}</td>
        <td class="vcol-strike">${escapeHtml(x.atm_strike)}</td>
        <td class="vcol-cotm call">${fmtNum(x.calls_otm)}</td>
        <td class="vcol-potm put">${fmtNum(x.puts_otm)}</td>
        <td class="vcol-citm call">${fmtNum(x.calls_itm_atm)}</td>
        <td class="vcol-pitm put">${fmtNum(x.puts_itm_atm)}</td>
        <td class="vcol-tcalls call"><b>${fmtNum(x.total_calls)}</b></td>
        <td class="vcol-tputs put"><b>${fmtNum(x.total_puts)}</b></td>
        <td class="vcol-tvol"><b>${fmtNum(x.total_vol)}</b></td>
        <td class="vcol-rvol" data-sortval="${rv == null ? '' : rv}">${rvolHtml}</td>
        <td class="vcol-trend ${trendCls}" data-sortval="${tr == null ? '' : tr}">${trendTxt}</td>
        <td class="vcol-cchg ${callChgCls}">${cChgTxt}</td>
        <td class="vcol-pchg ${putChgCls}">${pChgTxt}</td>
        <td class="vcol-notional" data-sortval="${notional == null ? '' : notional}">${notional == null ? '<span class="muted">-</span>' : fmtDollar(notional)}</td>
        <td class="vcol-cp" data-sortval="${ratio == null ? '' : ratio}">${ratioBarHtml}</td>
        <td class="vcol-dcp" data-sortval="${dcp == null ? '' : dcp}">${dcpHtml}</td>
        <td class="vcol-prem" data-sortval="${acp == null ? '' : acp}">${premHtml}</td>
        <td class="vcol-grid">${gridHtml}</td>
        <td class="vcol-anom reason-col">${surgePill(anomType)}</td>
      </tr>`;
      }).join('');

      document.getElementById('tbody-vol').innerHTML = body;
      applyVolFilters();
      applyHiddenCols();
    }

    /* ══════════════════════════════════════════════════════
       RENDER: ANOMALIES TABLE (with error boundary #18)
       ══════════════════════════════════════════════════════ */
    function renderAnomalies(rows) {
      try {
        _renderAnomaliesInner(rows);
      } catch (e) {
        console.error('renderAnomalies error:', e);
        document.getElementById('err').innerHTML += `<div class="err">Anomalies table render error: ${escapeHtml(e.message)}</div>`;
      }
    }

    function _renderAnomaliesInner(rows) {
      const tbody = document.getElementById('tbody-anomaly');
      if (!rows || !rows.length) {
        tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;color:var(--dim);padding:24px">No anomalies detected in this range</td></tr>';
        return;
      }

      const body = rows.slice().reverse().map(x => {
        const rowCls = x.anomaly_type === 'CALL SURGE' ? 'anomaly-call' : (x.anomaly_type === 'PUT SURGE' ? 'anomaly-put' : 'anomaly-mixed');
        const cpct = x.calls_pct_chg, ppct = x.puts_pct_chg;
        const ratioCls = (x.cp_ratio != null && x.cp_ratio > 1) ? 'call' : 'put';

        return `
      <tr class="${rowCls}">
        <td class="an-time">${fmtTime(x.candle_time_ny)}</td>
        <td class="an-type">${surgePill(x.anomaly_type)}</td>
        <td class="an-price">${escapeHtml(x.spy_price)}</td>
        <td class="an-mult"><b>${escapeHtml(x.vol_multiple)}x</b></td>
        <td class="an-tvol">${fmtNum(x.total_vol)}</td>
        <td class="an-avgvol muted">${fmtNum(x.avg_vol)}</td>
        <td class="an-tcalls call">${fmtNum(x.total_calls)}</td>
        <td class="an-tputs put">${fmtNum(x.total_puts)}</td>
        <td class="an-cp ${ratioCls}">${x.cp_ratio ?? '-'}</td>
        <td class="an-cchg ${cpct > 0 ? 'up' : 'dn'}">${cpct == null ? '-' : `${cpct > 0 ? '+' : ''}${cpct}%`}</td>
        <td class="an-pchg ${ppct > 0 ? 'up' : 'dn'}">${ppct == null ? '-' : `${ppct > 0 ? '+' : ''}${ppct}%`}</td>
        <td class="an-reason reason-col">${escapeHtml(x.reason)}</td>
      </tr>`;
      }).join('');

      tbody.innerHTML = body;
    }

