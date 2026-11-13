/* volregime.js - the Volume Regime tab.

   CLASSIC script, like every other file here: top-level function and let
   declarations share one global lexical scope, and the inline onclick
   handlers in index.html depend on that. Load order is load-bearing - this
   needs escapeHtml/fmtCompact from format.js and rpcWithRetry from rpc.js.

   The bars in the Session Flow table are styled divs, not SVG or canvas: they
   sit inside table cells that already have to stretch with their column, and
   a fixed viewBox would either clip or letterbox at every width. Colours come
   through CSS tokens so they follow the theme with no redraw. The tab holds
   no SVG chart any more - the volume profile that used to be one is now the
   volume column of that table, next to the signals it explains.

   The one rule this tab exists to enforce: no number is shown without the n
   it rests on, and anything under the configured threshold - min_n_reliable
   for the regime table, min_n_bucket for the 30-minute buckets, which cannot
   share a cutoff because one splits 250 signals three ways and the other
   thirteen - is marked as not yet trustworthy. The whole reason the tab was built is that an earlier
   read of this same question reported a +4 bp high-volume edge that turned
   out to be look-ahead bias plus frozen-feed days. */

    /* Fetched together: five small result sets, and rendering half a tab
       while the rest is still in flight reads as a broken page rather than a
       loading one. */
    async function loadVolRegime(force) {
      const key = currentStrategy;
      if (volRegimeLoading) return;
      if (!force && volRegimeKey === key && volRegimePerf) return;

      volRegimeLoading = true;
      volRegimeFailed = false;
      renderVolRegimeLoading();
      try {
        const params = { p_strategy: currentStrategy };
        const [status, flow, perf, days] = await Promise.all([
          rpcWithRetry('v2_vol_regime_status_by_strategy', null, params),
          rpcWithRetry('v2_vol_regime_flow_by_strategy', null, params),
          rpcWithRetry('v2_vol_regime_perf_by_strategy', null, params),
          rpcWithRetry('v2_vol_regime_days_by_strategy', null, params),
        ]);
        volRegimeStatus = Array.isArray(status) ? (status[0] || null) : status;
        volRegimeFlow = flow || [];
        volRegimePerf = perf || [];
        volRegimeDays = days || [];
        /* The selected row is an index into the flow rows, so a strategy
           switch that returns a shorter result would otherwise leave the
           focus card reading a row that no longer exists. */
        if (volRegimeSel >= volRegimeFlow.length) volRegimeSel = 0;
        volRegimeKey = key;
        renderVolRegime();
        updateRowCounts();
      } catch (e) {
        if (e.name === 'AbortError') return;
        /* volRegimeFailed keeps the row-count badge from saying "no signal
           data for this strategy", which asserts a fact about the data when
           what actually happened is that the request failed. */
        volRegimeFailed = true;
        document.getElementById('volregime-status').innerHTML =
          `<div class="chart-empty" style="height:60px">Could not load volume regime: ${escapeHtml(e.message || String(e))}</div>`;
        updateRowCounts();
      } finally {
        volRegimeLoading = false;
      }
    }

    function renderVolRegimeLoading() {
      document.getElementById('volregime-status').innerHTML =
        '<div class="chart-empty" style="height:60px">Loading volume regime...</div>';
      ['volregime-flow', 'volregime-perf', 'volregime-days']
        .forEach(id => { document.getElementById(id).innerHTML = ''; });
    }

    function renderVolRegime() {
      document.getElementById('volregime-status').innerHTML = volRegimeStatusHtml();
      document.getElementById('volregime-flow').innerHTML = volRegimeFlowHtml();
      document.getElementById('volregime-perf').innerHTML = volRegimePerfHtml();
      document.getElementById('volregime-days').innerHTML = volRegimeDaysHtml();
    }

    /* ══════════════════════════════════════════════════════
       (c) CURRENT STATUS
       ══════════════════════════════════════════════════════ */

    /* A bad day is a first-class state here, not an error. On a frozen feed
       there is no vratio to show at all, and an empty panel would read as
       "nothing wrong" - which is the opposite of true. */
    function volRegimeStatusHtml() {
      const s = volRegimeStatus;
      if (!s) return '<div class="chart-empty" style="height:60px">No bars for this strategy yet</div>';

      const cls = { LOW: 'vr-low', NORMAL: 'vr-normal', HIGH: 'vr-high' }[s.regime] || 'vr-none';
      const bad = s.day_quality !== 'CLEAN';

      let headline, detail;
      if (bad) {
        headline = 'No regime';
        detail = s.day_quality === 'BAD_FROZEN'
          ? `today's feed is frozen (${escapeHtml(s.frozen_components || 'unknown')}) - this session is excluded from baselines`
          : s.day_quality === 'BAD_SHORT_END'
            ? `today's session data ends at ${escapeHtml(String(s.last_bar || '?'))} - excluded from baselines`
            : `today's session data starts at ${escapeHtml(String(s.first_bar || '?'))} - excluded from baselines`;
      } else if (s.regime === 'NO_BASELINE') {
        headline = 'No baseline';
        detail = `fewer than ${s.min_baseline_days} prior clean sessions at this time of day`;
      } else if (s.regime === 'NO_WINDOW') {
        headline = 'No window';
        detail = 'less than 30 minutes into the session, so there is no 30-minute window yet';
      } else {
        headline = s.regime;
        detail = `vratio ${(+s.vratio).toFixed(2)} &middot; 30-min volume ${fmtCompact(s.vol_30m)}`
          + ` against a ${fmtCompact(s.baseline)} baseline from ${s.baseline_n} prior clean session${s.baseline_n === 1 ? '' : 's'}`;
      }

      /* Only while bars should actually be arriving. Outside the session the
         last bar is legitimately hours old, and warning on stale_min alone
         would cry stale every evening and all weekend. */
      const stale = (s.market_open && s.stale_min >= 10)
        ? `<span class="vr-stale">last bar ${s.stale_min} min ago</span>` : '';

      return `<div class="vr-status ${cls}">
        <div class="vr-status-main">
          <span class="vr-badge">${escapeHtml(headline)}</span>
          <span class="vr-detail">${detail}</span>
        </div>
        <div class="vr-status-foot">
          ${escapeHtml(s.symbol)} &middot; bar ${escapeHtml(String(s.ts || '').replace('T', ' '))}
          &middot; cutoffs LOW &lt; ${s.low_max} &le; NORMAL &le; ${s.normal_max} &lt; HIGH
          ${stale}
        </div>
      </div>`;
    }

    /* ══════════════════════════════════════════════════════
       (a) SESSION FLOW - volume, signals and outcome per bucket
       ══════════════════════════════════════════════════════ */

    /* One row per 30-minute bucket, answering the three parts of the same
       question side by side: how much of a session's option volume trades in
       this half hour, how many signals fired on those bars, and what those
       signals made or lost. This replaced a standalone volume-profile chart,
       which showed the first part and left the reader holding the other two in
       their head while they looked at a regime table further down the page.

       Two populations in one row, and they do not share an n. The volume
       columns are an average over CLEAN sessions only - a frozen feed would
       bend the shape of the curve. The signal columns count EVERY signal, bad
       sessions included, because a frozen option feed says nothing about the
       price log the returns are measured from. Each side carries its own n for
       that reason, and n_bad says how much of a bucket came off an excluded
       session. See the header of sql/volume_regime_flow.sql.

       Results come from spy_intraday_log, which is historical: the 15-minute
       delay on the live feed affects the status panel above and nothing here.

       Signals are bucketed on the same shifted stamp as the bars, so a signal
       always sits in the same row as the volume it fired on. A bar stamped
       10:00 covers 09:55-10:00 and belongs to the opening half hour; so does
       the signal that fired off it. */

    /* Which columns the horizon switch reads. The win count, the average and
       the total all have to move together with the n they rest on, so they
       live in one record rather than three parallel lookups that can fall out
       of step when a fourth horizon is added. */
    const VR_HZ = {
      '30':  { label: '+30 min',  n: 'n_30',   w: 'win_30',   avg: 'avg_bp_30',  sum: 'sum_bp_30',  when: '30 minutes after the signal' },
      '60':  { label: '+60 min',  n: 'n_60',   w: 'win_60',   avg: 'avg_bp_60',  sum: 'sum_bp_60',  when: '60 minutes after the signal' },
      'eod': { label: 'To close', n: 'n_eod',  w: 'win_eod',  avg: 'avg_bp_eod', sum: 'sum_bp_eod', when: 'by the close' },
    };

    /* Re-renders only the flow panel. The status, regime and excluded-day
       panels do not depend on the horizon or the selected row, and redrawing
       the whole tab would scroll a reader away from the row they just
       clicked. */
    function volRegimeSetHz(hz) {
      if (!VR_HZ[hz] || volRegimeHz === hz) return;
      volRegimeHz = hz;
      document.getElementById('volregime-flow').innerHTML = volRegimeFlowHtml();
    }

    function volRegimePick(i) {
      volRegimeSel = i;
      document.getElementById('volregime-flow').innerHTML = volRegimeFlowHtml();
    }

    /* U+2212 MINUS, not a hyphen: at --fs-cell in a tabular-nums column a
       hyphen sits too high and too short to read as a sign. */
    function vrSign(v, dp) {
      return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(dp);
    }
    function vrPn(v) { return v > 0 ? 'vr-pos' : v < 0 ? 'vr-neg' : ''; }

    function volRegimeFlowHtml() {
      const rows = volRegimeFlow || [];
      const hz = VR_HZ[volRegimeHz] || VR_HZ['30'];

      const head = '<div class="vr-section-head">Session flow'
        + '<span class="vr-sub">per 30-minute bucket: share of a session\'s option volume,'
        + ' the signals that fired on those bars, and what they made or lost</span></div>';

      if (!rows.length) return head + '<div class="chart-empty" style="height:60px">No sessions yet</div>';

      /* has_signals is false for a non-SPY strategy, which is not the same
         fact as a bucket having no signals in it. The volume half of the table
         is still worth showing, so the signal columns go to "n/a" and the
         banner says why rather than the table reading as a flat loss. */
      const hasSig = rows.some(r => r.has_signals);
      const minN = +(rows[0].min_n_bucket || 10);
      const sel = Math.min(Math.max(volRegimeSel | 0, 0), rows.length - 1);

      /* Derived once, read by the table, the totals row and the focus card -
         three places that must not disagree about what the selected bucket
         did. */
      let cum = 0;
      const items = rows.map((r, i) => {
        const vol = r.avg_pct == null ? null : +r.avg_pct;
        if (vol != null) cum += vol;
        const nM = r[hz.n] == null ? 0 : +r[hz.n];
        const w = r[hz.w] == null ? 0 : +r[hz.w];
        return {
          i,
          label: r.bucket_label,
          /* The bucket's own end, so the row reads as the interval it is
             rather than an instant. The last bucket closes the session. */
          end: i + 1 < rows.length ? rows[i + 1].bucket_label : '16:00',
          vol, cum,
          daysN: +(r.days_n || 0),
          /* Sessions of those that hold no bar in this bucket at all - a feed
             that started at 10:55 or stopped at 15:15. They count as 0% so
             the column keeps one denominator, which is true of the data and
             not of the market, so the row discloses it. */
          daysGap: +(r.days_gap || 0),
          nFired: r.n == null ? null : +r.n,
          nBad: r.n_bad == null ? 0 : +r.n_bad,
          nM, w, l: nM - w,
          rate: nM ? (w / nM) * 100 : null,
          avg: r[hz.avg] == null ? null : +r[hz.avg],
          net: r[hz.sum] == null ? null : +r[hz.sum],
          thin: nM > 0 && nM < minN,
        };
      });

      /* Scales. Every bar is relative to the largest value in its own column,
         so the shape of each column is readable; the numbers next to them are
         what the reader compares across columns. */
      const maxVol = Math.max(1, ...items.map(t => t.vol || 0));
      const maxN   = Math.max(1, ...items.map(t => t.nM));
      const maxAbs = Math.max(1, ...items.map(t => Math.abs(t.avg || 0)));

      const pct = (v, hi) => Math.max(0, Math.min(100, (v / hi) * 100));

      const body = items.map(t => {
        const volCell = t.vol == null
          ? '<td class="vr-na">-</td>'
          : `<td><span class="vr-cellbar">
               <span class="vr-bar ${t.daysGap ? 'vr-bar-gap' : ''}"><span class="vr-bar-fill" style="width:${pct(t.vol, maxVol).toFixed(1)}%"></span></span>
               <span class="vr-num">${t.vol.toFixed(1)}%${t.daysGap
                 ? `<span class="vr-n">${t.daysGap} session${t.daysGap === 1 ? '' : 's'} blank</span>` : ''}</span>
             </span></td>`;

        /* "Traded by then" is cumulative; the n line underneath is this
           bucket's share of that cumulative total - the mockup's "34% of
           32.1%" read. Guarded because a bucket with no volume at all on any
           clean session would make the first row divide by zero. */
        const cumCell = t.vol == null
          ? '<td class="vr-na">-</td>'
          : `<td>${t.cum.toFixed(1)}%${t.cum > 0
              ? `<span class="vr-n">${Math.round((t.vol / t.cum) * 100)}% of it</span>` : ''}</td>`;

        const sigCell = !hasSig
          ? '<td class="vr-na">n/a</td>'
          : t.nFired
            ? `<td><span class="vr-cellbar">
                 <span class="vr-bar ${t.thin ? 'vr-bar-thin' : ''}">
                   <span class="vr-wl-w" style="width:${pct(t.w, maxN).toFixed(1)}%"></span>
                   <span class="vr-wl-l" style="left:${pct(t.w, maxN).toFixed(1)}%;width:${pct(t.l, maxN).toFixed(1)}%"></span>
                 </span>
                 <span class="vr-num">${t.nM}${t.thin ? ' <span class="vr-flag">thin</span>' : ''}
                   <span class="vr-n">${t.w}W ${t.l}L${t.nM < t.nFired ? ` &middot; of ${t.nFired}` : ''}</span>
                 </span>
               </span></td>`
            : '<td class="vr-na">0<span class="vr-n">none fired</span></td>';

        const rateCell = t.rate == null
          ? '<td class="vr-na">-</td>'
          : `<td class="${t.rate > 50 ? 'pos' : t.rate < 50 ? 'neg' : ''}">${Math.round(t.rate)}%</td>`;

        const avgCell = t.avg == null
          ? '<td class="vr-na">-</td>'
          : `<td><span class="vr-cellbar">
               <span class="vr-div">
                 <span class="vr-div-zero"></span>
                 <span class="vr-div-${t.avg >= 0 ? 'pos' : 'neg'}"
                       style="width:${(pct(Math.abs(t.avg), maxAbs) / 2).toFixed(1)}%"></span>
               </span>
               <span class="vr-num ${vrPn(t.avg)}">${vrSign(t.avg, 1)}</span>
             </span></td>`;

        const netCell = t.net == null
          ? '<td class="vr-na">-</td>'
          : `<td class="vr-net ${vrPn(t.net)}">${vrSign(t.net, 0)}</td>`;

        return `<tr class="vr-flow-row ${t.i === sel ? 'vr-sel' : ''} ${t.thin ? 'vr-thin' : ''}"
            onclick="volRegimePick(${t.i})" tabindex="0"
            onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();volRegimePick(${t.i});}"
            aria-label="${escapeHtml(t.label)} to ${escapeHtml(t.end)}: ${t.vol == null ? 'no volume' : t.vol.toFixed(1) + '% of session volume'}, ${hasSig ? `${t.nFired} signals, ${t.nM} with a ${hz.label} result, ${t.w} won, ${t.l} lost` : 'signals not applicable'}">
          <td class="vr-time">${escapeHtml(t.label)}<span class="vr-dash">&ndash;</span>${escapeHtml(t.end)}</td>
          ${volCell}${cumCell}${sigCell}${rateCell}${avgCell}${netCell}
        </tr>`;
      }).join('');

      /* The totals row is the check on the table above it: the volume column
         has to add to 100% of a session, and the signal column has to add to
         the signal log. A reader who cannot see that cannot tell whether a
         bucket went missing. */
      const tVol = items.reduce((a, t) => a + (t.vol || 0), 0);
      const tFired = items.reduce((a, t) => a + (t.nFired || 0), 0);
      const tM = items.reduce((a, t) => a + t.nM, 0);
      const tW = items.reduce((a, t) => a + t.w, 0);
      const tNet = items.reduce((a, t) => a + (t.net || 0), 0);
      const foot = `<tr class="vr-total">
        <td class="vr-time">Session</td>
        <td>${tVol.toFixed(1)}%</td>
        <td class="vr-na">at close</td>
        ${hasSig
          ? `<td>${tM}<span class="vr-n">${tW}W ${tM - tW}L${tM < tFired ? ` &middot; of ${tFired}` : ''}</span></td>
             <td>${tM ? Math.round((tW / tM) * 100) + '%' : '-'}</td>
             <td class="${tM ? vrPn(tNet) : ''}">${tM ? vrSign(tNet / tM, 1) + ' avg' : '-'}</td>
             <td class="vr-net ${vrPn(tNet)}">${vrSign(tNet, 0)}</td>`
          : '<td class="vr-na">n/a</td><td class="vr-na">n/a</td><td class="vr-na">n/a</td><td class="vr-na">n/a</td>'}
      </tr>`;

      const toggle = ['30', '60', 'eod'].map(k =>
        `<button class="vr-hz-btn ${volRegimeHz === k ? 'on' : ''}" onclick="volRegimeSetHz('${k}')"
           aria-pressed="${volRegimeHz === k}">${VR_HZ[k].label}</button>`).join('');

      /* The date range at the top of the page does NOT reach this tab: the
         RPCs take a strategy and nothing else, and loadAll() - which every
         range change calls - does not call loadVolRegime at all. That is the
         right behaviour (a bucket holds 10-40 signals across the whole
         history; one session would spread five signals over thirteen buckets
         and read as noise) but a control that silently does nothing is the
         exact failure this tab exists to prevent, so the table says what it
         is actually built from. */
      const maxDays = Math.max(0, ...items.map(t => t.daysN));
      const firedAll = items.reduce((a, t) => a + (t.nFired || 0), 0);
      const coverage = `<span class="vr-coverage">Full history &middot;
        <b>${maxDays}</b> session${maxDays === 1 ? '' : 's'} of volume${hasSig
          ? ` &middot; <b>${firedAll}</b> signal${firedAll === 1 ? '' : 's'}` : ''}.
        The date range above does not apply to this tab.</span>`;

      const legend = `<div class="vr-legend">
        <span><i class="vr-sw vr-sw-vol"></i>Share of session option volume</span>
        <span><i class="vr-sw vr-sw-win"></i>Signals that won</span>
        <span><i class="vr-sw vr-sw-loss"></i>Signals that lost</span>
        <span><i class="vr-sw vr-sw-thin"></i>Under n = ${minN}, not yet reliable</span>
        ${items.some(t => t.daysGap)
          ? '<span><i class="vr-sw vr-sw-gap"></i>Some sessions have no bar here</span>' : ''}
      </div>`;

      /* Unreachable today: has_signals is true for every strategy now that the
         signal set is derived per symbol rather than read from a SPY-only log.
         Kept because the column still carries a real distinction - "no signals
         in this bucket" is not "no signal set for this strategy" - and a
         strategy added without bucket data would need it again. */
      const banner = hasSig ? '' : `<div class="vr-banner">No signal set for this strategy, so the
        signal, win-rate and basis-point columns are not available. The volume columns are for the
        selected symbol.</div>`;

      return head
        + `<div class="vr-flow-bar">
             ${coverage}
             <div class="vr-hz" role="group" aria-label="Result horizon">
               <span class="vr-hz-lab">Result measured</span>${toggle}
             </div>
           </div>`
        + banner
        + volRegimeFocusHtml(items[sel], hz, hasSig, minN)
        + legend
        + `<div class="vr-flow-scroll"><table class="vr-table vr-flow-table">
            <thead><tr>
              <th>Time (ET)</th>
              <th>Volume share</th>
              <th>Traded by then</th>
              <th>Signals (${escapeHtml(hz.label)})</th>
              <th>Win</th>
              <th>Avg bp</th>
              <th>Net bp</th>
            </tr></thead>
            <tbody>${body}${foot}</tbody>
          </table></div>`
        + `<div class="vr-rest">Volume is an average over every session on record, bad feeds
            included, so the column is the whole shape of the day and sums to 100%. The signal
            columns likewise count every signal, including the
            ${items.reduce((a, t) => a + t.nBad, 0)} on sessions the LOW/NORMAL/HIGH baselines
            below exclude &mdash; a frozen option feed does not invalidate a price. Click a row
            to read it on its own.</div>`;
    }

    /* The focus card exists because the table answers the question in seven
       columns and the question was asked in one sentence. It restates the
       selected row as that sentence, with the n it rests on in plain sight. */
    function volRegimeFocusHtml(t, hz, hasSig, minN) {
      if (!t) return '';
      const range = `${escapeHtml(t.label)}&ndash;${escapeHtml(t.end)}`;

      const tile = (lab, val, sub, cls) => `<div class="vr-tile">
        <div class="vr-tile-lab">${lab}</div>
        <div class="vr-tile-val ${cls || ''}">${val}</div>
        <div class="vr-tile-sub">${sub}</div>
      </div>`;

      const tiles = [
        tile('Option volume', t.vol == null ? '-' : `${t.vol.toFixed(1)}%`,
          t.vol == null ? 'no sessions' : `of a session &middot; ${t.daysN} session${
            t.daysN === 1 ? '' : 's'}${t.daysGap ? `, ${t.daysGap} with no bar here` : ''}`),
        hasSig
          ? tile('Signals fired', t.nFired == null ? '-' : t.nFired,
              t.nM === t.nFired ? `all have a ${escapeHtml(hz.label)} result`
                : `${t.nM} have a ${escapeHtml(hz.label)} result`)
          : tile('Signals fired', 'n/a', 'no signal set'),
        hasSig
          ? tile('Won / lost', `<span class="vr-pos">${t.w}</span><span class="vr-slash"> / </span><span class="vr-neg">${t.l}</span>`,
              t.rate == null ? 'no measured result' : `win rate ${Math.round(t.rate)}% of n = ${t.nM}`)
          : tile('Won / lost', 'n/a', 'no signal set'),
        hasSig
          ? tile('Net result', t.net == null ? '-' : `${vrSign(t.net, 0)} <span class="vr-unit">bp</span>`,
              t.avg == null ? '' : `avg ${vrSign(t.avg, 1)} bp per signal`, vrPn(t.net))
          : tile('Net result', 'n/a', 'no signal set'),
      ].join('');

      let sentence;
      if (!hasSig) {
        sentence = `${range} ET carries ${t.vol == null ? 'no measured share' : t.vol.toFixed(1)
          + '% of a session\'s option volume'}. No signal set for this strategy.`;
      } else if (!t.nFired) {
        sentence = `${range} ET carries ${t.vol.toFixed(1)}% of a session's option volume and has
          not fired a single signal yet, so there is nothing to score.`;
      } else {
        const verdict = t.net > 0 ? 'a net gain' : t.net < 0 ? 'a net loss' : 'break-even';
        sentence = `${range} ET carries ${t.vol == null ? 'an unmeasured share' : t.vol.toFixed(1) + '%'}
          of a session's option volume (${t.cum.toFixed(1)}% of it has traded by the end of this bucket)
          and fired ${t.nFired} signal${t.nFired === 1 ? '' : 's'}.
          ${t.nM} of those have a result ${hz.when}: ${t.w} right, ${t.l} wrong, for ${verdict}
          of ${vrSign(t.net, 0)} bp.`
          + (t.thin ? ` Only ${t.nM} measured signals, under the n = ${minN} this tab trusts - provisional.` : '')
          + (t.nBad ? ` ${t.nBad} of them fired on a session the regime baselines exclude.` : '')
          + (t.daysGap ? ` ${t.daysGap} of the ${t.daysN} sessions ${t.daysGap === 1 ? 'holds' : 'hold'}
             no bar in this window at all and ${t.daysGap === 1 ? 'counts' : 'count'} as 0%, so the
             share is a floor rather than a reading.` : '');
      }

      return `<div class="vr-focus">
        <div class="vr-focus-head">
          <span class="vr-focus-lab">Selected bucket</span>
          <span class="vr-focus-range">${range} ET</span>
        </div>
        <div class="vr-tiles">${tiles}</div>
        <p class="vr-focus-sent">${sentence}</p>
      </div>`;
    }

    /* ══════════════════════════════════════════════════════
       (b) + (d) PERFORMANCE BY REGIME, AND THE n WARNING
       ══════════════════════════════════════════════════════ */

    const VR_LABELS = {
      LOW: 'LOW', NORMAL: 'NORMAL', HIGH: 'HIGH',
      NO_BASELINE: 'No baseline', NO_WINDOW: 'No 30-min window',
      DATA_BAD: 'Excluded (bad data)', NO_BAR: 'No matching bar',
    };

    /* Only the three real regimes carry performance. The rest are shown as
       counts underneath so the signals add up to the full log - a reader who
       cannot see where the other 71 went has no way to judge the three that
       are left. */
    function volRegimePerfHtml() {
      const rows = volRegimePerf || [];
      const head = '<div class="vr-section-head">Performance by regime'
        + '<span class="vr-sub">signed basis points - positive means the signal\'s direction was right</span></div>';

      /* Was the SPY-only banner. Both symbols have a derived signal set now,
         so an empty result means genuinely no signals yet rather than a
         structural gap - which is a different sentence. */
      if (!rows.length) {
        return head + `<div class="vr-banner">No signals have fired for this strategy yet, so there
          is nothing to break down by regime. The session flow and current status above are for the
          selected symbol.</div>`;
      }

      const minN = rows[0].min_n_reliable;
      const graded = rows.filter(r => ['LOW', 'NORMAL', 'HIGH'].includes(r.vol_regime));
      const other = rows.filter(r => !['LOW', 'NORMAL', 'HIGH'].includes(r.vol_regime));
      const thin = graded.filter(r => !r.is_reliable).length;

      /* The warning is deliberately above the table, not a footnote. Every
         number below it is provisional and the reader should know that
         before reading any of them. */
      const warn = thin
        ? `<div class="vr-warn"><b>${thin} of ${graded.length} regimes are below n = ${minN}.</b>
             Treat those rows as not yet reliable - they are shown so the sample can be watched as it
             grows, not because they are conclusive. Every cell below carries its own n.</div>`
        : '';

      const cell = (val, n, suffix) => {
        if (n === 0 || val == null) return '<td class="vr-na">-<span class="vr-n">n=0</span></td>';
        const sign = suffix === 'bp' && val > 0 ? '+' : '';
        const cls = suffix === 'bp' ? (val > 0 ? 'pos' : (val < 0 ? 'neg' : '')) : '';
        return `<td class="${cls}">${sign}${val}${suffix === '%' ? '%' : ''}<span class="vr-n">n=${n}</span></td>`;
      };

      const body = graded.map(r => `<tr class="${r.is_reliable ? '' : 'vr-thin'}">
          <td class="vr-reg vr-${r.vol_regime.toLowerCase()}">${VR_LABELS[r.vol_regime]}</td>
          <td>${r.n}${r.is_reliable ? '' : ' <span class="vr-flag">thin</span>'}</td>
          ${cell(r.win_30, r.n_30, '%')}
          ${cell(r.win_60, r.n_60, '%')}
          ${cell(r.avg_bp_30, r.n_30, 'bp')}
          ${cell(r.avg_bp_60, r.n_60, 'bp')}
          ${cell(r.avg_bp_eod, r.n, 'bp')}
        </tr>`).join('');

      const rest = other.length
        ? `<div class="vr-rest">Not classified: ` + other.map(r =>
            `<span>${VR_LABELS[r.vol_regime] || escapeHtml(r.vol_regime)} <b>${r.n}</b></span>`).join(' &middot; ')
          + `</div>`
        : '';

      return head + warn + `<table class="vr-table">
        <thead><tr>
          <th>Regime</th><th>Signals</th>
          <th>Win +30m</th><th>Win +60m</th>
          <th>Avg +30m</th><th>Avg +60m</th><th>Avg EOD</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>` + rest;
    }

    /* ══════════════════════════════════════════════════════
       (e) EXCLUDED DAYS
       ══════════════════════════════════════════════════════ */

    /* signals_lost is the column that matters. "2026-10-16 was excluded" is a
       footnote; "2026-09-08 was excluded and took 11 signals with it" is what
       tells you whether the exclusions are quietly doing the work. */
    function volRegimeDaysHtml() {
      const rows = volRegimeDays || [];
      const head = '<div class="vr-section-head">Sessions excluded for bad data'
        + '<span class="vr-sub">excluded from every baseline; signals on these days are marked DATA_BAD rather than given a regime</span></div>';
      if (!rows.length) return head + '<div class="vr-banner">No sessions excluded.</div>';

      const lost = rows.reduce((a, r) => a + (r.signals_lost || 0), 0);
      const body = rows.map(r => `<tr>
          <td>${escapeHtml(String(r.ny_date))}</td>
          <td class="vr-reason">${escapeHtml(r.reason_detail || r.day_quality)}</td>
          <td>${r.bars}</td>
          <td>${r.signals_lost == null ? '-' : r.signals_lost}</td>
        </tr>`).join('');

      return head + `<table class="vr-table">
        <thead><tr><th>Session</th><th>Why</th><th>Bars</th><th>Signals lost</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
      <div class="vr-rest">${rows.length} session${rows.length === 1 ? '' : 's'} excluded,
        costing ${lost} signal${lost === 1 ? '' : 's'}.</div>`;
    }
