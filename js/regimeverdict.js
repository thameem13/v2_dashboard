/* regimeverdict.js - "Today's Regime" advisory verdict card
   ==========================================================================
   One read on whether today's opening conditions have historically suited
   the strategy, shown before the first trade of the day.

   ADVISORY ONLY. Nothing in this file touches signal generation, grading,
   filtering or alerting. It renders into #regime-verdict inside the existing
   Regime disclosure and writes exactly one thing to the database: the manual
   event tag, through v2_regime_set_event_by_strategy.

   Not on the 10s poll. The verdict is frozen at the open by definition, so
   polling it would be N requests an hour for a value that cannot change. It
   is fetched once on startup and on an explicit refresh. The live VIX1D
   shown beside the open does drift, which is the one thing here worth a
   refresh button - and the Regime strip above it already carries the live
   reading on the poll.

   Why it loads on startup rather than on panel open, which is how news.js
   behaves: the panel being closed is the normal state, and this card's whole
   purpose is to be read before the session starts. A verdict you have to go
   looking for is a verdict you will skip on the morning you most need it.
   One request per page load is the cost, and the verdict word is mirrored
   onto the Regime button so the morning read needs no click at all.

   Classification lives in SQL (v2_regime_config, one row), not here. This
   file maps a verdict string to a colour and nothing else - no thresholds,
   no band edges, no confidence cutoffs. Retuning is an UPDATE.
   ========================================================================== */

/* ── STATE ──
   Mirrors the on-demand pattern in volregime.js: a separate "failed" flag so
   a dead request never renders as "no regime data", which on this card would
   read as a verdict rather than as a failure. */
let regimeVerdict = null;      // today's row, or the last session's
let regimeVerdictHist = null;  // the strip
let regimeVerdictTally = null;  // the running record
let regimeVerdictDate = null;  // the trade_date the card is describing
let regimeVerdictLoading = false;
let regimeVerdictFailed = false;
let regimeVerdictStale = false; // true when showing a prior session

/* The NY session date, not the browser's local date.
   todayStr() in main.js returns the local calendar date, which is correct for
   a reader sitting in ET and silently wrong for one who is not - and "which
   trade_date" is the single most load-bearing input on this card, because the
   whole point is a value frozen against one specific session. Intl is used
   rather than an offset constant so DST is not hand-rolled.

   This is also why no SQL in regime_verdict.sql uses CURRENT_DATE: it
   evaluates in UTC and rolls over around 8 PM ET, so an evening review would
   be shown tomorrow's empty verdict. Every date crosses the wire as a string. */
function regimeSessionDate() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  } catch (e) {
    // en-CA already yields YYYY-MM-DD; this is the no-Intl fallback only.
    return typeof todayStr === 'function' ? todayStr() : '';
  }
}

const REGIME_VERDICT_CLASS = {
  'FAVOURABLE': 'rv-good',
  'THIN': 'rv-warn',
  'CAUTION': 'rv-bad',
  'NO DATA': 'rv-none'
};

const REGIME_FINE_LABEL = {
  'LT10': '< 10',
  'MID_10_13': '10 – 13',
  'MID_13_17': '13 – 17',
  'GTE17': '≥ 17',
  'NONE': 'no open'
};

const REGIME_EVENT_LABEL = {
  'PRE_EVENT': 'Pre-event',
  'POST_EVENT': 'Post-event',
  'CLEAN': 'Clean',
  /* Not "Unset". The stored UNSET now means "no manual override, use the
     calendar" - the day still gets a context, derived from v2_market_event.
     Calling that "Unset" would read as untagged when it usually is not. */
  'UNSET': 'Auto (calendar)'
};

const REGIME_EVENT_HELP = {
  'PRE_EVENT': 'Known catalyst still ahead — after today’s close, or later today',
  'POST_EVENT': 'Major catalyst resolved since the last close',
  'CLEAN': 'No scheduled catalyst either side',
  'UNSET': 'Take the context from the event calendar'
};


/* ══════════════════════════════════════════════════════
   LOAD
   ══════════════════════════════════════════════════════ */

async function loadRegimeVerdict(force) {
  if (regimeVerdictLoading) return;
  if (!force && regimeVerdict) return;

  regimeVerdictLoading = true;
  regimeVerdictFailed = false;
  renderRegimeVerdictLoading();

  const want = regimeSessionDate();

  try {
    /* Fetched together: a card showing a verdict with an empty strip under it
       reads as "no history", which is a claim about the data rather than a
       loading state. */
    let [today, hist, tally] = await Promise.all([
      rpcWithRetry('v2_regime_card_by_strategy', null, { p_date: want, p_strategy: currentStrategy }),
      rpcWithRetry('v2_regime_strip_by_strategy', null, { p_date: want, p_strategy: currentStrategy }),
      rpcWithRetry('v2_regime_tally_by_strategy', null, { p_date: want, p_strategy: currentStrategy })
    ]);

    /* Weekend, holiday, or a morning before the first candle has landed: the
       requested date has no row at all. Fall back to the newest session the
       history knows about and say so, rather than rendering NO DATA as if the
       feed had failed. */
    regimeVerdictStale = false;
    let shown = want;
    if ((!today || !today.length) && hist && hist.length) {
      shown = hist[hist.length - 1].trade_date;
      regimeVerdictStale = true;
      today = await rpcWithRetry('v2_regime_card_by_strategy', null,
        { p_date: shown, p_strategy: currentStrategy });
    }

    regimeVerdict = (today && today.length) ? today[0] : null;
    regimeVerdictHist = hist || [];
    regimeVerdictTally = tally || [];
    regimeVerdictDate = shown;
    renderRegimeVerdict();
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'AuthError') return;
    regimeVerdictFailed = true;
    renderRegimeVerdictError(e);
  } finally {
    regimeVerdictLoading = false;
  }
}

/* The one write this dashboard makes. Optimistic rendering is deliberately
   NOT used: the tag changes the displayed verdict (POST_EVENT downgrades to
   CAUTION), and showing a downgrade that did not persist would be the one
   failure mode that matters here. */
async function setRegimeEvent(ctx) {
  if (!regimeVerdictDate) return;
  const sel = document.getElementById('rv-event');
  if (sel) sel.disabled = true;
  try {
    await rpcWithRetry('v2_regime_set_event_by_strategy', null, {
      p_date: regimeVerdictDate, p_context: ctx, p_strategy: currentStrategy
    });
    await loadRegimeVerdict(true);
  } catch (e) {
    if (sel) sel.disabled = false;
    const n = document.getElementById('rv-event-note');
    if (n) {
      n.textContent = 'Tag not saved: ' + (e.message || 'request failed');
      n.className = 'rv-note rv-note-bad';
    }
  }
}


/* ══════════════════════════════════════════════════════
   RENDER
   ══════════════════════════════════════════════════════ */

function renderRegimeVerdictLoading() {
  const el = document.getElementById('regime-verdict');
  if (!el) return;
  if (regimeVerdict) return;   // a refresh keeps the old card on screen
  el.innerHTML = `<div class="rv-card"><div class="rv-head">
      <span class="panel-title"><svg class="ico"><use href="#ic-gauge"></use></svg>Today&rsquo;s Regime</span>
    </div><div class="rv-loading">Reading the open&hellip;</div></div>`;
}

function renderRegimeVerdictError(e) {
  const el = document.getElementById('regime-verdict');
  if (!el) return;
  el.innerHTML = `<div class="rv-card"><div class="rv-head">
      <span class="panel-title"><svg class="ico"><use href="#ic-gauge"></use></svg>Today&rsquo;s Regime</span>
      <button class="icon-btn" onclick="loadRegimeVerdict(true)" aria-label="Retry"><svg class="ico"><use href="#ic-refresh"></use></svg></button>
    </div>
    <div class="err">${iconMarkup('ic-alert')}Could not read the regime verdict: ${escapeHtml(e && e.message || 'request failed')}. This is a failed request, not a verdict.</div>
  </div>`;
  regimeVerdictButtonBadge(null);
}

/* The verdict word on the Regime button, so the card can be read without
   opening the disclosure. Written here rather than in chrome.js for the same
   reason renderRegime() writes both the strip and the rail chip: one writer,
   two views, never one view reading the other. */
function regimeVerdictButtonBadge(verdict) {
  const btn = document.getElementById('regime-btn');
  if (!btn) return;
  let dot = btn.querySelector('.rv-dot');
  if (!verdict) { if (dot) dot.remove(); return; }
  if (!dot) {
    dot = document.createElement('span');
    dot.className = 'rv-dot';
    btn.appendChild(dot);
  }
  dot.className = 'rv-dot ' + (REGIME_VERDICT_CLASS[verdict] || 'rv-none');
  dot.title = `Today's regime verdict: ${verdict} (advisory)`;
  /* The colour is not the only carrier: the button's accessible name says it
     too, because a coloured dot is invisible to a screen reader and to about
     one reader in twelve of everyone else. */
  dot.setAttribute('aria-label', `Regime verdict ${verdict}`);
  dot.setAttribute('role', 'img');
}

function rvNum(n, dp) {
  if (n === null || n === undefined || n === '') return '&mdash;';
  const v = Number(n);
  if (!isFinite(v)) return '&mdash;';
  return escapeHtml(v.toFixed(dp === undefined ? 2 : dp));
}

function rvTimeOnly(ts) {
  if (!ts) return '&mdash;';
  const m = String(ts).match(/(\d{2}:\d{2})/);
  return m ? escapeHtml(m[1]) : escapeHtml(String(ts));
}

function renderRegimeVerdict() {
  const el = document.getElementById('regime-verdict');
  if (!el) return;

  const d = regimeVerdict;
  if (!d) {
    el.innerHTML = `<div class="rv-card"><div class="rv-head">
        <span class="panel-title"><svg class="ico"><use href="#ic-gauge"></use></svg>Today&rsquo;s Regime</span>
        <button class="icon-btn" onclick="loadRegimeVerdict(true)" aria-label="Refresh"><svg class="ico"><use href="#ic-refresh"></use></svg></button>
      </div>
      <div class="rv-loading">No session logged yet. The verdict is set from the first VIX1D reading of the day.</div>
    </div>`;
    regimeVerdictButtonBadge(null);
    return;
  }

  const eff = d.effective_verdict || 'NO DATA';
  const cls = REGIME_VERDICT_CLASS[eff] || 'rv-none';
  regimeVerdictButtonBadge(eff);

  /* SAMPLE SIZE IS PART OF THE VERDICT, not a footnote to it. A green badge
     off seven sessions is a guess wearing the costume of a result, so the day
     count and the confidence label sit inside the badge block - not in a
     tooltip, where the one reader who needs them is the one who will not
     hover. */
  const n = d.band_sample_days;
  const conf = d.confidence_label || 'no sample';
  const confCls = /hypothesis|untested|no sample/.test(conf) ? 'rv-conf-weak' : 'rv-conf';

  /* A POST_EVENT day whose band verdict is ALREADY CAUTION produced
     "downgraded from CAUTION to CAUTION", which is noise dressed as a
     finding. The reason still travels on the row - the history and the
     tally want it - but the banner only earns its place when the downgrade
     actually changed something. */
  const downgraded = !!d.downgrade_reason && d.verdict !== d.effective_verdict;

  /* The select shows the OVERRIDE, not the effective context: 'manual' means
     a human set it, anything else means the calendar decided and the control
     sits at Auto. */
  const evSource = d.event_source || 'none';
  const overrideVal = evSource === 'manual' ? (d.event_context || 'UNSET') : 'UNSET';

  let evNote;
  if (evSource === 'manual') {
    evNote = 'Set by hand, overriding the calendar. Choose Auto to hand it back.';
  } else if (evSource === 'derived') {
    evNote = 'From the calendar: ' + escapeHtml(String(d.event_detail || ''))
      + '. Override it if that is wrong.';
  } else {
    /* Not "no events today". The calendar is hand-seeded and only claims
       CLEAN inside a window someone has declared complete - outside one,
       silence means nobody has checked, which is not the same thing and
       must not be shown as if it were. */
    evNote = 'No calendar entry for this date, and the calendar is not confirmed'
      + ' complete here — so no context is claimed. Set one by hand if you know better.';
  }

  /* Warnings about the INPUT, which this card cannot fix and must not hide. */
  const warn = [];
  if (d.open_capture_late) {
    warn.push(`The first VIX1D reading of the session did not arrive until
      ${rvTimeOnly(d.open_vix1d_captured_ny)} ET. VIX1D climbs through the
      session, so a late first reading is an inflated &ldquo;open&rdquo; and
      may have placed the day in the wrong band.`);
  }
  if (d.intraday_rows !== null && d.intraday_rows !== undefined && Number(d.intraday_rows) < 40) {
    warn.push(`Only ${escapeHtml(String(d.intraday_rows))} intraday rows logged
      for this session, against about 78 for a full day. The opening VIX1D and
      implied move both come from that feed.`);
  }
  if (d.candles_logged !== null && d.data_complete === false) {
    warn.push(`${escapeHtml(String(d.candles_logged ?? 0))} bucket candles logged,
      below the ${escapeHtml(String(d.min_candles ?? 70))} needed to score the day.
      Today&rsquo;s outcome will not enter any statistic.`);
  }

  el.innerHTML = `
    <div class="rv-card">
      <div class="rv-head">
        <span class="panel-title"><svg class="ico"><use href="#ic-gauge"></use></svg>Today&rsquo;s Regime</span>
        <!-- "SPY session" is not decoration. vix1d and impl_move exist only in
             spy_intraday_log, so this verdict is SPY's whichever strategy is
             selected, and a QQQ reader would otherwise take it for theirs. -->
        <span class="rv-advisory"><span class="rv-adv-full">SPY session &middot; advisory &middot; does not gate signals</span><span
          class="rv-adv-short">SPY &middot; advisory</span></span>
        <button class="icon-btn" onclick="loadRegimeVerdict(true)" aria-label="Refresh regime verdict" title="Re-read the verdict and the live VIX1D"><svg class="ico"><use href="#ic-refresh"></use></svg></button>
      </div>

      ${regimeVerdictStale ? `<div class="rv-stale">Showing the last logged session,
         ${escapeHtml(regimeVerdictDate || '')} &mdash; no candles for today yet.</div>` : ''}

      <div class="rv-body">
        <div class="rv-badge ${cls}" role="group" aria-label="Regime verdict">
          <div class="rv-verdict">${escapeHtml(eff)}</div>
          <div class="rv-sample">${n === null || n === undefined
              ? 'no comparable sessions'
              : escapeHtml(String(n)) + (Number(n) === 1 ? ' prior session' : ' prior sessions')}</div>
          <div class="${confCls}">${escapeHtml(conf)}</div>
        </div>

        <div class="rv-figs">
          <div class="rv-fig rv-fig-lead">
            <div class="rv-fig-lab">VIX1D at the open${d.open_capture_late ? ' <span class="rv-flag">late</span>' : ''}</div>
            <div class="rv-fig-val">${rvNum(d.open_vix1d, 2)}</div>
            <div class="rv-fig-sub">frozen &middot; captured ${rvTimeOnly(d.open_vix1d_captured_ny)} ET</div>
          </div>
          <div class="rv-fig">
            <div class="rv-fig-lab">VIX1D live</div>
            <div class="rv-fig-val rv-fig-dim">${rvNum(d.live_vix1d, 2)}</div>
            <div class="rv-fig-sub">${d.vix1d_drift_pct === null || d.vix1d_drift_pct === undefined
                ? 'drift unknown'
                : (Number(d.vix1d_drift_pct) >= 0 ? '+' : '') + rvNum(d.vix1d_drift_pct, 1) + '% since the open'}</div>
          </div>
          <div class="rv-fig">
            <div class="rv-fig-lab">Implied move (open)</div>
            <div class="rv-fig-val rv-fig-dim">$${rvNum(d.open_impl_move, 2)}</div>
            <div class="rv-fig-sub">${d.open_impl_move
                ? '&plusmn;$' + rvNum(Number(d.open_impl_move) * 2, 2) + ' implied range'
                : 'no implied move'}</div>
          </div>
          <div class="rv-fig">
            <div class="rv-fig-lab">Delivered so far</div>
            <div class="rv-fig-val rv-fig-dim">${rvNum(d.realized_vs_implied, 2)}</div>
            <div class="rv-fig-sub">of implied &middot; hit at ${rvNum(d.hit_threshold, 2)}</div>
          </div>
        </div>
      </div>

      ${downgraded ? `<div class="rv-downgrade">
          Verdict downgraded from <b>${escapeHtml(d.verdict || '')}</b> to <b>CAUTION</b>:
          ${escapeHtml(d.downgrade_reason)}.
        </div>` : ''}

      <div class="rv-event">
        <!-- The context now comes from the event calendar by default, so this
             control is an OVERRIDE, not a daily chore. Its value is the
             manual tag if one is set and "Auto" otherwise - never the
             derived value, or selecting Auto would look like a no-op.

             What the calendar concluded, and why, is printed beside it:
             a derived tag that cannot be questioned is worse than no tag,
             because the calendar is hand-seeded and will be wrong sometimes. -->
        <label for="rv-event">Event context</label>
        <!-- ctrl-select, not a bare select: that class is what themes a
             control on this page. Without it the dropdown rendered as the
             browser default - white on near-black in dark mode - and missed
             the 36px tap target the phone rules give every other control. -->
        <select id="rv-event" class="ctrl-select" onchange="setRegimeEvent(this.value)">
          ${['UNSET', 'PRE_EVENT', 'POST_EVENT', 'CLEAN'].map(k => `
            <option value="${k}" title="${escapeHtml(REGIME_EVENT_HELP[k])}"${overrideVal === k ? ' selected' : ''}>${escapeHtml(REGIME_EVENT_LABEL[k])}</option>
          `).join('')}
        </select>
        <span class="rv-note" id="rv-event-note">${evNote}</span>
      </div>

      ${warn.length ? `<div class="rv-warn">${warn.map(w => `<div>${iconMarkup('ic-alert')}${w}</div>`).join('')}</div>` : ''}

      ${renderRegimeStrip()}
      ${renderRegimeTally()}

      <div class="rv-foot">observe &amp; log &mdash; unconfirmed, scored in public. Advisory only: it does not gate signals.</div>
    </div>`;
}

/* The strip: what was said, and what the day did. The point of the whole
   feature - a verdict nobody scores is a horoscope. */
function renderRegimeStrip() {
  const rows = regimeVerdictHist || [];
  if (!rows.length) return '';

  const cells = rows.map(r => {
    const v = r.effective_verdict || 'NO DATA';
    const vc = REGIME_VERDICT_CLASS[v] || 'rv-none';
    /* Three states, not two: hit, miss, and not scoreable. An incomplete
       session rendered as a miss would quietly load the record against every
       verdict that happened to fall on a thin day. */
    let mark = '<span class="rv-sq rv-sq-na" title="Not scoreable">&middot;</span>';
    if (r.hit === true) mark = '<span class="rv-sq rv-sq-hit" title="Delivered">&#10003;</span>';
    else if (r.hit === false) mark = '<span class="rv-sq rv-sq-miss" title="Did not deliver">&times;</span>';

    const md = escapeHtml(String(r.trade_date || '').slice(5));
    return `<div class="rv-col" title="${md} &middot; ${escapeHtml(v)} &middot; open ${rvNum(r.open_vix1d, 2)} &middot; delivered ${rvNum(r.realized_vs_implied, 2)}">
        <div class="rv-col-d">${md}</div>
        <div class="rv-col-v ${vc}">${escapeHtml(v.charAt(0))}</div>
        <div class="rv-col-x">${rvNum(r.open_vix1d, 1)}</div>
        <div class="rv-col-h">${mark}</div>
        ${r.event_context && r.event_context !== 'UNSET'
            ? `<div class="rv-col-e" title="${escapeHtml(REGIME_EVENT_HELP[r.event_context] || '')}">${escapeHtml((REGIME_EVENT_LABEL[r.event_context] || '').slice(0, 4))}</div>`
            : ''}
      </div>`;
  }).join('');

  return `<div class="rv-strip-wrap">
      <div class="rv-sub">Last ${rows.length} sessions &middot; verdict, open VIX1D, and whether the day delivered</div>
      <div class="rv-strip">${cells}</div>
    </div>`;
}

function renderRegimeTally() {
  const all = regimeVerdictTally || [];
  if (!all.length) return '';

  const byKind = k => all.filter(r => r.grouping_kind === k);
  const order = { 'FAVOURABLE': 0, 'THIN': 1, 'CAUTION': 2, 'NO DATA': 3 };
  const verdicts = byKind('verdict').sort((a, b) => (order[a.label] ?? 9) - (order[b.label] ?? 9));
  /* SQL returns these ordered by code, which puts GTE17 first and reads as
     though the bands run high to low. Order them by where they sit on the
     scale instead. */
  const fineOrder = { 'LT10': 0, 'MID_10_13': 1, 'MID_13_17': 2, 'GTE17': 3, 'NONE': 4 };
  const fine = byKind('fine_band').sort((a, b) => (fineOrder[a.label] ?? 9) - (fineOrder[b.label] ?? 9));
  const evOrder = { 'PRE_EVENT': 0, 'POST_EVENT': 1, 'CLEAN': 2, 'UNSET': 3 };
  const ev = byKind('event').sort((a, b) => (evOrder[a.label] ?? 9) - (evOrder[b.label] ?? 9));

  /* UNSET means two different things in two places. On the control it is
     "defer to the calendar"; in this table it is "the calendar had no entry
     and claimed nothing", which is a bucket of unknowns rather than a
     setting. Same code, different sentence. */
  const TALLY_LABEL = Object.assign({}, REGIME_FINE_LABEL, REGIME_EVENT_LABEL, {
    'UNSET': 'No calendar entry'
  });
  const row = r => `<tr>
      <td>${escapeHtml(TALLY_LABEL[r.label] || String(r.label || '-').replace(/_/g, ' '))}</td>
      <td class="num">${escapeHtml(String(r.days ?? '-'))}</td>
      <td class="num">${escapeHtml(String(r.hits ?? '-'))}</td>
      <td class="num">${r.hit_rate_pct === null || r.hit_rate_pct === undefined ? '&mdash;' : escapeHtml(String(r.hit_rate_pct)) + '%'}</td>
      <td class="num">${rvNum(r.median_rvi, 2)}</td>
      <td class="num">$${rvNum(r.avg_net_move, 2)}</td>
      <td class="num">${rvNum(r.avg_efficiency, 1)}%</td>
    </tr>`;

  /* The headline goes in the <summary>, the tables behind it.

     #top is capped at clamp(180px, 52vh, 470px) and scrolls internally, and
     the band is only ~360px with both disclosures open. Two seven-column
     tables rendered flat pushed the card past that cap, which does not
     truncate visibly - it drops the content into an inner scroll area with
     no affordance, so the card simply was not there. A verdict you cannot
     see is worse than no card.

     So the record collapses to one line that still carries the number that
     matters: hits over days, per verdict. Nothing is hidden that was not
     already a click away - the fine bands were behind a <details> from the
     start - and the summary line is the comparison the merge rests on. */
  const headline = verdicts
    .filter(r => r.label !== 'NO DATA')
    .map(r => `${escapeHtml(String(r.label))} ${escapeHtml(String(r.hits ?? 0))}/${escapeHtml(String(r.days ?? 0))}`)
    .join(' · ');

  return `<details class="rv-tally">
      <summary><span class="rv-sub-inline">Running record</span> ${headline}</summary>
      <div class="rv-tscroll"><table class="rv-table">
        <thead><tr><th>Verdict</th><th class="num">Days</th><th class="num">Hits</th>
          <th class="num">Rate</th><th class="num">Median</th><th class="num">Net</th><th class="num">Eff</th></tr></thead>
        <tbody>${verdicts.map(row).join('')}</tbody>
      </table></div>
      ${fine.length ? `<details class="rv-details">
        <summary>By raw VIX1D band (${fine.length})</summary>
        <div class="rv-sub">The card merges 10&ndash;17 into one green band because the
          sample cannot separate those two. These rows are kept so that decision can be
          revisited rather than buried &mdash; if the record here ever splits them, the
          split belongs back on the card.</div>
        <div class="rv-tscroll"><table class="rv-table">
          <thead><tr><th>Band</th><th class="num">Days</th><th class="num">Hits</th>
            <th class="num">Rate</th><th class="num">Median</th><th class="num">Net</th><th class="num">Eff</th></tr></thead>
          <tbody>${fine.map(row).join('')}</tbody>
        </table></div>
      </details>` : ''}
      ${ev.length ? `<details class="rv-details">
        <summary>By event context (${ev.length})</summary>
        <div class="rv-sub">Does a day with resolved news behind it deliver less than one with
          news still ahead? This is the question the event calendar exists to answer. The
          calendar is hand-seeded and incomplete, so &ldquo;Auto (calendar)&rdquo; here means
          no entry and no claim &mdash; not a quiet day.</div>
        <div class="rv-tscroll"><table class="rv-table">
          <thead><tr><th>Context</th><th class="num">Days</th><th class="num">Hits</th>
            <th class="num">Rate</th><th class="num">Median</th><th class="num">Net</th><th class="num">Eff</th></tr></thead>
          <tbody>${ev.map(row).join('')}</tbody>
        </table></div>
      </details>` : ''}
    </details>`;
}
