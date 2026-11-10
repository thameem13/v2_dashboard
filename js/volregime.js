/* volregime.js - the Volume Regime tab.

   CLASSIC script, like every other file here: top-level function and let
   declarations share one global lexical scope, and the inline onclick
   handlers in index.html depend on that. Load order is load-bearing - this
   needs escapeHtml/fmtCompact from format.js and rpcWithRetry from rpc.js.

   Charts are inline SVG for the reason set out at js/premium.js:568-577: they
   are built inside an innerHTML string, so a <canvas> would need a second
   pass to find the element and draw after insertion, and could silently
   render blank if the ordering changed. Colours come through
   style="fill:var(--token)" so they follow the theme with no redraw.

   The one rule this tab exists to enforce: no number is shown without the n
   it rests on, and anything under the configured min_n_reliable is marked as
   not yet trustworthy. The whole reason the tab was built is that an earlier
   read of this same question reported a +4 bp high-volume edge that turned
   out to be look-ahead bias plus frozen-feed days. */

    /* Fetched together: four small result sets, and rendering half a tab
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
        const [status, profile, perf, days] = await Promise.all([
          rpcWithRetry('v2_vol_regime_status_by_strategy', null, params),
          rpcWithRetry('v2_vol_regime_profile_by_strategy', null, params),
          rpcWithRetry('v2_vol_regime_perf_by_strategy', null, params),
          rpcWithRetry('v2_vol_regime_days_by_strategy', null, params),
        ]);
        volRegimeStatus = Array.isArray(status) ? (status[0] || null) : status;
        volRegimeProfile = profile || [];
        volRegimePerf = perf || [];
        volRegimeDays = days || [];
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
      ['volregime-profile', 'volregime-perf', 'volregime-days']
        .forEach(id => { document.getElementById(id).innerHTML = ''; });
    }

    function renderVolRegime() {
      document.getElementById('volregime-status').innerHTML = volRegimeStatusHtml();
      document.getElementById('volregime-profile').innerHTML = volRegimeProfileHtml();
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
       (a) DAILY PROFILE
       ══════════════════════════════════════════════════════ */

    /* Average share of a session's volume in each 30-minute bucket. Clean
       days only - a frozen feed would drag whichever buckets it spans toward
       zero and bend the curve. */
    function volRegimeProfileHtml() {
      const rows = volRegimeProfile || [];
      const head = '<div class="vr-section-head">Daily volume profile'
        + '<span class="vr-sub">average share of a session\'s option volume, by 30-minute bucket, clean sessions only</span></div>';
      if (!rows.length) return head + svgEmpty(160, 'No clean sessions yet');

      const W = 620, H = 170, PL = 34, PR = 10, PT = 12, PB = 34;
      const hi = Math.max(...rows.map(r => +r.avg_pct)) || 1;
      const bw = (W - PL - PR) / rows.length;
      const y = v => PT + (1 - v / hi) * (H - PT - PB);
      const base = H - PB;
      const daysN = Math.min(...rows.map(r => r.days_n));

      const bars = rows.map((r, i) => {
        const v = +r.avg_pct;
        const x = PL + i * bw;
        const top = y(v);
        return `<rect x="${(x + 1).toFixed(1)}" y="${top.toFixed(1)}"
            width="${(bw - 2).toFixed(1)}" height="${(base - top).toFixed(1)}"
            style="fill:var(--blue)" opacity="0.75"
            title="${escapeHtml(r.bucket_label)}: ${v.toFixed(2)}% of a session, ${r.days_n} sessions"/>
          ${i % 2 === 0
            ? `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 20}" text-anchor="middle"
                 style="fill:var(--dim)" font-size="8">${escapeHtml(r.bucket_label)}</text>` : ''}`;
      }).join('');

      const ticks = [hi, hi / 2, 0];
      return head + `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Average share of session option volume by 30-minute bucket across ${daysN} clean sessions">
        ${ticks.map(t => `<line x1="${PL}" x2="${W - PR}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"
            style="stroke:var(--line)" stroke-width="1" ${t === 0 ? '' : 'stroke-dasharray="2 3"'}/>
          <text x="${PL - 6}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end"
            style="fill:var(--dim)" font-size="9">${t.toFixed(1)}%</text>`).join('')}
        ${bars}
        <text x="${PL}" y="${H - 6}" style="fill:var(--dim)" font-size="9">n = ${daysN} clean sessions</text>
      </svg>`;
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

      if (!rows.length) {
        return head + `<div class="vr-banner">The signal log is SPY-only - it has no symbol column -
          so there are no per-regime results for this strategy. The profile and current status above
          are for the selected symbol.</div>`;
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
