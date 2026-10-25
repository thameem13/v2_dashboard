/* signal.js - quick filters, sentiment bar, signal journal modal
   Split from index.html. These are CLASSIC scripts, not modules:
   top-level let/const share one global lexical scope, so the 29
   mutable state variables and the inline onclick handlers keep
   working exactly as before. Load order is load-bearing. */
    /* ══════════════════════════════════════════════════════
       FILTER PRESETS
       ══════════════════════════════════════════════════════ */
    function applyPreset(preset) {
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      if (window.event && window.event.target) window.event.target.classList.add('active');

      document.getElementById('f-time').value = '';
      document.getElementById('f-price').value = '';
      document.getElementById('f-strike').value = '';
      document.getElementById('f-flow').value = '';
      document.getElementById('f-dir').value = '';
      document.getElementById('f-poc').value = '';
      document.getElementById('f-room').value = '';
      document.getElementById('f-score').value = '';
      document.getElementById('f-tick').value = '';
      gradeFilter.clear();
      document.getElementById('f-status').value = '';

      switch (preset) {
        case 'grade-a-calls':
          document.getElementById('f-dir').value = 'CALL';
          gradeFilter.add('A');
          break;
        case 'grade-a-puts':
          document.getElementById('f-dir').value = 'PUT';
          gradeFilter.add('A');
          break;
        case 'alerted':
          document.getElementById('f-status').value = 'ALERTED';
          break;
        case 'high-flow':
          // Flow (divergence_flow) spans roughly -1.8..+1.9; 0.9 is the top
          // scoring tier in v2_dashboard_today (s_flow = 3).
          document.getElementById('f-flow').value = 'abs>=0.9';
          break;
      }
      syncGradeChips();
      applyFlowFilters();
    }

    /* ══════════════════════════════════════════════════════
       SESSION FLOW & VOLUME SENTIMENT BAR
       ══════════════════════════════════════════════════════ */
    function updateSentimentBar(flowRows, volRows) {
      const fill = document.getElementById('sentiment-bar-fill');
      const label = document.getElementById('sentiment-bias-label');
      if (!fill || !label) return;

      const fmtVol = (n) => {
        if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
        return n.toLocaleString();
      };

      // 1. Primary: Option Volume Sentiment (contracts)
      if (volRows && volRows.length) {
        let totCalls = 0, totPuts = 0;
        volRows.forEach(x => {
          totCalls += (x.total_calls || 0);
          totPuts += (x.total_puts || 0);
        });
        const totalVol = totCalls + totPuts;
        if (totalVol > 0) {
          const callPct = Math.round((totCalls / totalVol) * 100);
          const putPct = 100 - callPct;
          const isBullish = callPct >= 50;
          const netBias = isBullish ? `Bullish (${callPct}% Call Bias)` : `Bearish (${putPct}% Put Bias)`;
          const netVol = totCalls - totPuts;
          const netSign = netVol >= 0 ? '+' : '-';
          const netStr = `${netSign}${fmtVol(Math.abs(netVol))}`;
          const netCls = netVol >= 0 ? 'call' : 'put';

          fill.style.width = `${callPct}%`;
          label.innerHTML = `<b class="${isBullish ? 'call' : 'put'}">${netBias}</b> &nbsp;|&nbsp; Put Vol: <b>${fmtVol(totPuts)}</b> &nbsp;|&nbsp; Call Vol: <b>${fmtVol(totCalls)}</b> &nbsp;|&nbsp; Net Vol: <b class="${netCls}">${netStr}</b>`;
          return;
        }
      }

      // 2. Fallback: Flow Signal Sentiment (flow score sum)
      if (flowRows && flowRows.length) {
        let callFlow = 0, putFlow = 0;
        flowRows.forEach(r => {
          const f = Math.abs(r.flow || 0);
          if (r.direction === 'CALL') {
            callFlow += f;
          } else if (r.direction === 'PUT') {
            putFlow += f;
          } else {
            if (r.flow > 0) callFlow += f;
            else if (r.flow < 0) putFlow += f;
          }
        });
        const total = callFlow + putFlow;
        if (total > 0) {
          const callPct = Math.round((callFlow / total) * 100);
          const putPct = 100 - callPct;
          const isBullish = callPct >= 50;
          const netBias = isBullish ? `Bullish (${callPct}% Call Bias)` : `Bearish (${putPct}% Put Bias)`;
          const netFlow = callFlow - putFlow;
          const netSign = netFlow >= 0 ? '+' : '-';
          const netStr = `${netSign}${Math.abs(netFlow).toFixed(3)}`;
          const netCls = netFlow >= 0 ? 'call' : 'put';

          fill.style.width = `${callPct}%`;
          label.innerHTML = `<b class="${isBullish ? 'call' : 'put'}">${netBias}</b> &nbsp;|&nbsp; Put Flow: -${putFlow.toFixed(3)} &nbsp;|&nbsp; Call Flow: +${callFlow.toFixed(3)} &nbsp;|&nbsp; Net Session: <b class="${netCls}">${netStr}</b>`;
        }
      }
    }

    /* ══════════════════════════════════════════════════════
       SIGNAL DETAIL & TRADE JOURNAL MODAL
       ══════════════════════════════════════════════════════ */
    /* Option-volume context for the signal modal. The flow row says the signal
       fired; this says whether there was any size behind it. rVOL is the one
       that matters most -- a grade B on thin volume is a different trade from
       the same grade on 2x the usual flow for that time of day. */
    /* One cache slot per strategy per range. The range is in the key because
       the same candle time means a different session on a different range, and
       a stale hit would caption the wrong day's volume. */
    function volCacheKey(sid) {
      const ctx = getDateContext();
      return sid + '|' + (ctx.isLive ? 'live' : (ctx.start || '') + '..' + (ctx.end || ''));
    }

    /* Live data grows: a slot fetched at 10:05 has nothing for the 10:35
       candle, and without an age check the modal would keep answering "no
       volume row" from a cache that simply predates the row. A closed range
       never changes, so it is cached for the session. */
    const VOL_CACHE_TTL = 60000;

    function volSlot(sig) {
      const slot = volByStrategy[volCacheKey(sig._sid)];
      if (!slot || slot.pending) return slot || null;
      // A failure is cached only briefly, so reopening the row retries rather
      // than repeating "could not load" for the rest of the session.
      if (slot.failed) return Date.now() - slot.at > VOL_CACHE_TTL ? null : slot;
      if (getDateContext().isLive && Date.now() - slot.at > VOL_CACHE_TTL) return null;
      return slot;
    }

    /* Volume for ONE row of the merged view, fetched when that row is opened.
       Not on the 10s poll: volume is the heavy half of a tick (~64 kB a
       strategy) and in the merged view it would be fetched per strategy, every
       tick, to answer a question nobody has asked yet. */
    async function loadVolForSignal(sig) {
      const key = volCacheKey(sig._sid);
      if (volByStrategy[key] && volByStrategy[key].pending) return;
      volByStrategy[key] = { pending: true };

      const ctx = getDateContext();
      try {
        const rows = await rpcWithRetry(
          ctx.isLive ? 'v2_volume_enriched_today_by_strategy' : 'v2_volume_enriched_range_by_strategy',
          null,
          ctx.isLive ? { p_strategy: sig._sid }
                     : { p_start: ctx.start, p_end: ctx.end, p_strategy: sig._sid },
          1);
        const map = {};
        (rows || []).forEach(r => { map[tsKey(r.candle_time_ny)] = r; });
        volByStrategy[key] = { at: Date.now(), map: map };
      } catch (e) {
        volByStrategy[key] = { failed: true, at: Date.now() };
        console.warn('Volume for ' + sig._sid + ' failed:', e);
      }

      /* Repaint only if this row is still the one on screen - the fetch can
         outlive the modal, or land after another row was opened. */
      const el = document.getElementById('modal-vol');
      if (el && currentJournalSignal === sig) el.outerHTML = volPanelHtml(sig);
    }

    function volPanelHtml(sig) {
      const wrap = (inner) =>
        `<div id="modal-vol" style="background:var(--bg);padding:10px 14px;border-radius:8px;border:1px solid var(--line);">
           <div style="font-size:11px;color:var(--dim);margin-bottom:6px;text-transform:uppercase">Option Volume &mdash; this candle</div>
           ${inner}
         </div>`;

      /* An aggregate row carries its strategy, and volMap does not: in the
         merged view that map is empty precisely so one symbol's volume cannot
         be captioned onto another's candle of the same minute. */
      let v;
      if (sig._sid) {
        const slot = volSlot(sig);
        if (slot && slot.failed) {
          return wrap('<div class="muted" style="font-size:11px">Could not load volume for '
            + escapeHtml(rowSymbol(sig)) + '.</div>');
        }
        if (!slot) loadVolForSignal(sig);        // absent, stale, or retryable
        if (!slot || slot.pending) {
          return wrap('<div class="muted" style="font-size:11px">Loading volume for '
            + escapeHtml(rowSymbol(sig)) + '...</div>');
        }
        v = slot.map[tsKey(sig.candle_time_ny)];
      } else {
        v = volMap[tsKey(sig.candle_time_ny)];
      }

      if (!v) {
        // Happens when the volume RPC failed, or the candle predates the
        // enriched volume data. Say so rather than rendering empty cells.
        return wrap('<div class="muted" style="font-size:11px">No volume row matched this candle.</div>');
      }

      const rv = v.rvol_tod == null ? null : +v.rvol_tod;
      const rz = v.rvol_tod_z == null ? null : +v.rvol_tod_z;
      const samples = v.tod_samples == null ? 0 : +v.tod_samples;
      let rvolCls = 'rvol-cool';
      if (rv != null) {
        if (rv >= 2) rvolCls = 'rvol-hot';
        else if (rv >= 1.3) rvolCls = 'rvol-warm';
      }
      const thin = samples > 0 && samples < 5;
      const rvolTxt = rv == null
        ? '<span class="muted">-</span>'
        : `<span class="${rvolCls}">${rv.toFixed(2)}x</span>`
          + (rz == null ? '' : ` <span class="rvol-z">${rz > 0 ? '+' : ''}${rz.toFixed(1)}σ</span>`)
          + (thin ? ` <span class="rvol-z">(${samples} sessions)</span>` : '');

      const ratio = v.call_put_ratio == null ? null : +v.call_put_ratio;
      const dcp = v.dollar_cp_ratio == null ? null : +v.dollar_cp_ratio;
      const diverges = v.cp_divergence === true;
      const sideTxt = (r) => r == null ? '' : (r > 1 ? 'call heavy' : 'put heavy');
      const sideCls = (r) => r == null ? 'muted' : (r > 1 ? 'call' : 'put');

      const cell = (label, val, sub) =>
        `<div><div class="modal-item-label">${label}</div>
           <div class="modal-item-val">${val}</div>
           ${sub ? `<div class="rg-sub">${sub}</div>` : ''}</div>`;

      // Only worth a line when it actually happened -- these two are the
      // interesting cases, not decoration.
      const anom = anomalyMap[tsKey(sig.candle_time_ny)];
      const notes = [];
      if (anom) notes.push(surgePill(anom.anomaly_type) + ` <span class="muted">${escapeHtml(anom.vol_multiple)}x avg volume</span>`);
      if (v.near_grid_edge === true) {
        notes.push('<span class="grid-pill grid-warn">⚠ EDGE</span> <span class="muted">price near the captured strike grid edge &mdash; OTM buckets truncated, these totals understate</span>');
      }

      return wrap(`
        <div class="modal-grid" style="padding:0;border:none;background:none">
          ${cell('Total Volume', fmtCompact(v.total_vol),
                 `<span class="call">${fmtCompact(v.total_calls)}</span> / <span class="put">${fmtCompact(v.total_puts)}</span>`)}
          ${cell('rVOL (time of day)', rvolTxt, 'vs the same minute in earlier sessions')}
          ${cell('C/P Ratio', `<span class="${sideCls(ratio)}">${ratio == null ? '-' : ratio.toFixed(2)}</span>`, sideTxt(ratio))}
          ${cell('$ C/P Ratio',
                 `<span class="${diverges ? 'dcp-diverge' : sideCls(dcp)}">${dcp == null ? '-' : dcp.toFixed(2)}</span>`,
                 diverges ? '<span class="dcp-diverge">money leans the other way</span>' : sideTxt(dcp))}
          ${cell('$ Traded', fmtDollar(v.total_notional),
                 `<span class="call">${fmtDollar(v.call_notional)}</span> / <span class="put">${fmtDollar(v.put_notional)}</span>`)}
          ${cell('Avg Premium',
                 `<span class="call">${v.avg_call_premium == null ? '-' : (+v.avg_call_premium).toFixed(2)}</span>`
                 + '<span class="muted"> / </span>'
                 + `<span class="put">${v.avg_put_premium == null ? '-' : (+v.avg_put_premium).toFixed(2)}</span>`,
                 'per contract, calls / puts')}
        </div>
        ${notes.length ? `<div style="margin-top:8px;font-size:11px;display:flex;flex-direction:column;gap:4px">${notes.map(n => `<div>${n}</div>`).join('')}</div>` : ''}`);
    }

    function openSignalJournal(sig) {
      currentJournalSignal = sig;
      const titleEl = document.getElementById('modal-title');
      const bodyEl = document.getElementById('modal-body');

      const isCall = sig.direction === 'CALL';
      const dirCls = isCall ? 'call' : (sig.direction === 'PUT' ? 'put' : 'muted');

      titleEl.innerHTML = `${escapeHtml(rowSymbol(sig))} $${sig.atm_strike} ${sig.direction || ''} Signal &nbsp; ${gradePill(sig.grade)}`;
      bodyEl.innerHTML = `
        <div class="modal-grid">
          <div><div class="modal-item-label">Timestamp</div><div class="modal-item-val">${fmtTime(sig.candle_time_ny)}</div></div>
          <div><div class="modal-item-label">${escapeHtml(rowSymbol(sig))} Price</div><div class="modal-item-val">$${sig.price ?? '-'}</div></div>
          <div><div class="modal-item-label">ATM Strike</div><div class="modal-item-val">$${sig.atm_strike ?? '-'}</div></div>
          <div><div class="modal-item-label">Divergence Flow</div><div class="modal-item-val ${sig.flow >= 0 ? 'flowpos' : 'flowneg'}">${sig.flow ?? 0}</div></div>
          <div><div class="modal-item-label">Direction</div><div class="modal-item-val ${dirCls}">${sig.direction ?? '-'}</div></div>
          <div><div class="modal-item-label">POC / Room</div><div class="modal-item-val">${sig.poc ?? '-'} / ${sig.room ?? '-'}</div></div>
          <div><div class="modal-item-label">Total Score</div><div class="modal-item-val">${sig.score ?? '-'} / 10</div></div>
          <div><div class="modal-item-label">Signal Status</div><div class="modal-item-val">${sig.has_signal ? 'ALERTED' : (sig.reason || 'None')}</div></div>
        </div>
        <div style="background:var(--bg);padding:10px 14px;border-radius:8px;border:1px solid var(--line);">
          <div style="font-size:11px;color:var(--dim);margin-bottom:4px;text-transform:uppercase">Rules Check</div>
          <div style="display:flex;gap:12px;font-size:11px">
            <span>Flow: <b>${sig.s_flow ?? 0}</b></span>
            <span>Vol: <b>${sig.s_vol ?? 0}</b></span>
            <span>Inst: <b>${sig.s_inst ?? 0}</b></span>
            <span>Room: ${gate(sig.room_ok)}</span>
            <span>Clean: ${gate(sig.s_clean > 0)}</span>
          </div>
        </div>
        ${volPanelHtml(sig)}`;

      document.getElementById('modal-journal').classList.add('visible');
    }

    function closeModal() {
      document.getElementById('modal-journal').classList.remove('visible');
    }

    function copyTradeLog() {
      if (!currentJournalSignal) return;
      const sig = currentJournalSignal;
      const sym = rowSymbol(sig);
      const text = `🚨 **${sym} Options Flow Alert** | ${fmtTime(sig.candle_time_ny)}
- **Direction**: ${sig.direction} ($${sig.atm_strike} Strike @ ${sym} $${sig.price})
- **Net Flow**: ${sig.flow} | **Score**: ${sig.score}/10 (Grade ${sig.grade || 'N/A'})
- **POC / Room**: ${sig.poc ?? '-'} / ${sig.room ?? '-'}
- **Status**: ${sig.has_signal ? 'ALERTED' : (sig.reason || 'None')}`;

      navigator.clipboard.writeText(text).then(() => {
        alert('Trade Log copied to clipboard!');
      });
    }

    function exportSignalSnapshot() {
      if (!currentJournalSignal) return;
      const sig = currentJournalSignal;
      const sym = rowSymbol(sig);
      const text = `${sym} SIGNAL SNAPSHOT — ${fmtTime(sig.candle_time_ny)}
==========================================
Direction: ${sig.direction}
Strike:    $${sig.atm_strike}
${sym} Price: $${sig.price}
Net Flow:  ${sig.flow}
Score:     ${sig.score}/10
Grade:     ${sig.grade || 'N/A'}
Status:    ${sig.has_signal ? 'ALERTED' : (sig.reason || 'None')}
==========================================`;

      const blob = new Blob([text], { type: 'text/plain;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sym || 'signal'}_Signal_${(sig.candle_time_ny || 'date').slice(0, 10)}_${sig.atm_strike}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    }

