/* rpc.js - Access session recovery, the proxy calls, loadAll
   Split from index.html. These are CLASSIC scripts, not modules:
   top-level let/const share one global lexical scope, so the 29
   mutable state variables and the inline onclick handlers keep
   working exactly as before. Load order is load-bearing. */
    /* ══════════════════════════════════════════════════════
       DATA FETCHING — with Retry (#2) & AbortController (#16)
       ══════════════════════════════════════════════════════ */
    /* PostgREST caps every response at 1000 rows (db-max-rows) and silently
       drops the rest — there is no error and no warning. Because these RPCs
       order by candle_time_ny ASC, the rows lost were the NEWEST ones: on the
       "All" preset the dashboard was discarding the most recent candles of the
       latest session. The Range header is ignored on RPC POSTs, so we page with
       ?limit/&offset until a short page comes back. */
    const PAGE_SIZE = 1000;

    /* The Cloudflare Access session expires on its own timer, and Access
       answers a background call with a redirect to its login page rather than
       with data. Without this the dashboard would poll on for hours, failing
       silently every 10s. Reloading re-runs the Access handshake, which is a
       no-op if the session is in fact still good. */
    function recoverSession() {
      let last = 0;
      try { last = Number(sessionStorage.getItem('lastAuthReload') || 0); } catch (e) { }
      // sessionStorage survives the reload, so this caps us at one reload per
      // 30s and a genuinely broken login cannot become a refresh loop.
      if (Date.now() - last < 30000) return;
      try { sessionStorage.setItem('lastAuthReload', String(Date.now())); } catch (e) { }
      window.location.reload();
    }

    function isAuthChallenge(res, ctype) {
      // redirect:'manual' turns Access's 302 into an opaque response instead of
      // a silently-followed navigation, so it can be recognised.
      if (res.type === 'opaqueredirect') return true;
      if (res.status === 401 || res.status === 403) return true;
      /* Some Access configurations answer 200 with the login HTML, so a
         content-type sniff is still worth having -- but ONLY on a non-error
         status. Cloudflare's own failure pages (a Worker exception is 1101)
         are HTML too, and treating a Supabase outage as an expired session
         would reload the page instead of showing what actually broke. */
      return res.ok && ctype.includes('text/html');
    }

    /* Ends the Cloudflare Access session on this device. /cdn-cgi/access/ is
       handled at Cloudflare's edge before both Access and the Worker - verified
       by it answering 200 while an unknown path answers a 302 to the login page
       - so this needs no route of its own and never reaches worker.js.

       Confirmed first: signing back in costs an OTP round-trip, and on a phone
       this button sits in a horizontally scrolling strip where a mis-tap is
       easy. */
    function logout() {
      if (!confirm('Sign out? You will need a new login code to get back in.')) return;
      window.location.href = '/cdn-cgi/access/logout';
    }

    async function rpcPage(fn, signal, params, offset) {
      const qs = offset > 0 ? `?limit=${PAGE_SIZE}&offset=${offset}` : '';
      const res = await fetch(`/api/rpc/${fn}${qs}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(params),
        signal: signal,
        redirect: 'manual',
        credentials: 'same-origin'
      });

      // Safe on an opaque response: its header list is empty, not throwing.
      const ctype = res.headers.get('content-type') || '';
      if (isAuthChallenge(res, ctype)) {
        recoverSession();
        const err = new Error('Session expired - signing in again...');
        err.name = 'AuthError';   // so rpcWithRetry does not back off on it
        throw err;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }

    async function rpc(fn, signal, params = {}) {
      let out = await rpcPage(fn, signal, params, 0);
      // Scalar/row-returning RPCs give an object, not an array — nothing to page.
      if (!Array.isArray(out)) return out;

      let offset = out.length;
      // Guard against a runaway loop if the server ever stops honouring offset.
      let guard = 0;
      while (out.length % PAGE_SIZE === 0 && out.length > 0 && guard++ < 50) {
        const next = await rpcPage(fn, signal, params, offset);
        if (!Array.isArray(next) || next.length === 0) break;
        out = out.concat(next);
        offset += next.length;
        if (next.length < PAGE_SIZE) break;
      }
      return out;
    }

    async function rpcWithRetry(fn, signal, params = {}, retries = 3) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          return await rpc(fn, signal, params);
        } catch (e) {
          // Aborts are intentional; an auth challenge is already being handled
          // by a reload, so backing off 2s/4s/8s on either is wasted.
          if (e.name === 'AbortError' || e.name === 'AuthError') throw e;
          if (attempt === retries) throw e;
          // Exponential backoff: 2s, 4s, 8s
          const delay = Math.pow(2, attempt) * 1000;
          document.getElementById('sub').textContent = `Retry ${attempt}/${retries} in ${delay / 1000}s...`;
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    async function loadAll() {
      if (isFetching) return;
      isFetching = true;

      // (#16) Abort any in-flight request
      if (abortController) {
        abortController.abort();
      }
      abortController = new AbortController();
      const signal = abortController.signal;

      const refBtn = document.getElementById('refresh-btn');
      // Was textContent = 'Loading...', which on an icon-only button removed
      // the <svg> and never put it back. Left unguarded exactly as before:
      // adding a null check here would change how this path fails.
      refBtn.classList.add('is-loading');
      refBtn.setAttribute('aria-busy', 'true');
      setBusy(true, loadingLabel());
      document.getElementById('err').innerHTML = '';

      // (#6) Save scroll positions before re-render
      const flowWrap = document.getElementById('flow-wrap');
      const volWrap = document.getElementById('vol-wrap');
      const flowScroll = flowWrap ? flowWrap.scrollTop : 0;
      const volScroll = volWrap ? volWrap.scrollTop : 0;

      try {
        // Determine which RPC functions + params to use based on date range
        const dateCtx = getDateContext();

        /* "Today's Alerts" is a different shape of load: one flow call per
           strategy instead of four calls for one strategy. Handled in its own
           function rather than as a branch inside this one - the aggregate
           view has no volume, no anomalies and no regime to join, so sharing
           the tail below would mean guarding every line of it. */
        if (isAggregate()) {
          await loadAggregate(signal, dateCtx);
          if (flowWrap) flowWrap.scrollTop = flowScroll;
          lastSyncTime = Date.now();
          updateSyncAge();
          return;
        }

        let flowPromise, volPromise, anomaliesPromise;

        // Anomalies are a non-critical enhancement — failures (e.g. missing
        // range RPC on historical dates) shouldn't block the core dashboard.
        const anomaliesOnFail = (err) => {
          if (err.name !== 'AbortError') console.warn('Anomalies load failed:', err);
          return [];
        };

        // Regime context is also non-critical enhancement data.
        const regimeOnFail = (err) => {
          if (err.name !== 'AbortError') console.warn('Regime context load failed:', err);
          return null;
        };
        /* p_strategy goes on every call. The RPC resolves it to a symbol in
           SQL, so the browser never learns which table a strategy reads - and
           a new strategy needs no change here at all. */
        const strat = { p_strategy: currentStrategy };

        const regimePromise = rpcWithRetry('v2_regime_context_by_strategy', signal,
          dateCtx.isLive ? strat : { p_date: dateCtx.end || dateCtx.start, ...strat }, 1)
          .catch(regimeOnFail);

        /* The pin detector's wall series. Non-critical like the anomalies: an
           empty series hides the card, which is the right failure - a pin
           card with no walls in it would read as "no pin today" and that is
           exactly the claim it must never make by accident. */
        const pinOnFail = (err) => {
          if (err.name !== 'AbortError') console.warn('Pin series load failed:', err);
          return [];
        };
        /* One function for live and range: p_start = p_end is today. It takes
           dates in both modes, unlike the pairs above, so there is no branch
           on dateCtx.isLive here - see the header of
           sql/v2_pin_series_by_strategy.sql.

           On the All preset both dates are null, and this RPC reads that as
           the latest session rather than all of history the way the other
           range RPCs do. Deliberate: the card reports on one session, so
           fetching every session to display the newest would be the
           dashboard's largest request in service of nothing. The history
           table is the place that looks back, and it fetches its own range. */
        const pinPromise = rpcWithRetry('v2_pin_series_by_strategy', signal,
          dateCtx.isLive
            ? { p_strategy: currentStrategy }
            : { p_start: dateCtx.start, p_end: dateCtx.end, ...strat }, 1)
          .catch(pinOnFail);

        if (dateCtx.isLive) {
          // Live mode: today's session
          flowPromise = rpcWithRetry('v2_dashboard_by_strategy', signal, strat);
          volPromise  = rpcWithRetry('v2_volume_enriched_today_by_strategy', signal, strat);
          anomaliesPromise = rpcWithRetry('v2_anomalies_today_by_strategy', signal, strat, 1).catch(anomaliesOnFail);
        } else {
          // Historical / range mode
          const params = { p_start: dateCtx.start, p_end: dateCtx.end, ...strat };
          flowPromise = rpcWithRetry('v2_dashboard_range_by_strategy', signal, params);
          volPromise  = rpcWithRetry('v2_volume_enriched_range_by_strategy', signal, params);
          anomaliesPromise = rpcWithRetry('v2_anomalies_range_by_strategy', signal, params, 1).catch(anomaliesOnFail);
        }

        const [flow, vol, anomalies, regime, pin] = await Promise.all([
          flowPromise, volPromise, anomaliesPromise, regimePromise, pinPromise
        ]);

        // v2_regime_context returns at most one row.
        regimeCtx = (regime && regime.length) ? regime[0] : null;
        renderRegime(regimeCtx);

        anomalyMap = {};
        (anomalies || []).forEach(a => { anomalyMap[tsKey(a.candle_time_ny)] = a; });

        /* Indexed before renderFlow, not after: signalWallFlag() reads both
           maps while the rows are being built, so a later refresh would badge
           every row against the previous poll's walls. */
        pinSeries = pin || [];
        pinIndexSeries(pinSeries);
        pinIndexStatus(pinSeries);
        renderPinCard();

        renderCards(flow, vol);
        renderFlow(flow);
        renderVol(vol);
        renderAnomalies(anomalies);
        checkNewAnomaly(anomalies);
        updateRowCounts();

        // (#17) Re-apply sort after data refresh
        applySort('flow');
        applySort('vol');

        // (#6) Restore scroll positions
        if (flowWrap) flowWrap.scrollTop = flowScroll;
        if (volWrap) volWrap.scrollTop = volScroll;

        // (#4) Update sync time
        lastSyncTime = Date.now();
        updateSyncAge();


        /* The premium backtest is keyed on the date range too, and nothing else
           reloads it: switchTab only fires when you arrive at the tab, so
           changing the range while already standing on it left the old range's
           trades on screen under the new dates. Compared against the full key
           rather than called unconditionally, so the 10s live poll does not
           re-run the backtest - and does not re-render the ledger out from
           under you while you are scrolled into it. */
        if (activeTab === 'prem' && !isAggregate() && premKey !== premKeyFor(dateCtx)) loadPremium();

      } catch (e) {
        if (e.name === 'AbortError') {
          // Silently ignore aborted requests
        } else {
          // (#18) Error boundary — show user-friendly message
          document.getElementById('err').innerHTML = `<div class="err">Could not load data: ${escapeHtml(e.message)}</div>`;
          document.getElementById('sub').textContent = 'Load failed';
        }
      } finally {
        isFetching = false;
        setBusy(false);
        refBtn.classList.remove('is-loading');
        refBtn.removeAttribute('aria-busy');
      }
    }

    /* ══════════════════════════════════════════════════════
       AGGREGATE LOAD — every strategy's graded candles at once

       Fans out the existing per-strategy flow RPC over the registry. No new
       endpoint and no worker change: v2_dashboard_by_strategy and its range
       twin are already allowlisted, and the browser still never learns which
       table a strategy reads.
       ══════════════════════════════════════════════════════ */
    async function loadAggregate(signal, dateCtx) {
      /* main.js calls loadAll() before loadStrategies(), so on a reload with
         this view saved the registry is not here yet - and without it there is
         nothing to fan out over. */
      if (!strategyList.length) await loadStrategies();

      const strategies = strategyList.filter(s => s.status !== 'retired');
      if (!strategies.length) {
        document.getElementById('err').innerHTML =
          '<div class="err">No strategies in the registry to aggregate.</div>';
        renderAggCards([]);
        renderFlow(null);
        return;
      }

      /* retries = 1 on purpose. The default 3 tries back off 2s/4s/8s, and N
         strategies doing that in parallel would stretch a 10s poll tick well
         past the next one. A failed strategy is named below instead. */
      const fn = dateCtx.isLive ? 'v2_dashboard_by_strategy' : 'v2_dashboard_range_by_strategy';
      const settled = await Promise.allSettled(strategies.map(s => rpcWithRetry(fn, signal,
        dateCtx.isLive
          ? { p_strategy: s.id }
          : { p_start: dateCtx.start, p_end: dateCtx.end, p_strategy: s.id },
        1)));

      // An abort means a newer load is already running; leave the screen alone.
      if (signal.aborted) return;

      const all = [];
      const failed = [];
      settled.forEach((res, i) => {
        const s = strategies[i];
        if (res.status !== 'fulfilled') {
          if (res.reason && res.reason.name === 'AbortError') return;
          failed.push(s.id);
          return;
        }
        (res.value || []).forEach(r => {
          // Only graded candles: a candle with no direction has no grade to
          // compare across strategies, and N strategies' worth of
          // below-threshold rows would bury the ones that matter.
          if (!r.direction || r.direction === 'none') return;
          r._sid = s.id;
          r._sym = s.symbol;
          r._slabel = s.label || s.name || s.id;
          all.push(r);
        });
      });

      /* Ascending by time, _sid breaking the tie so the order within one
         candle is stable across polls. _renderFlowInner() reverses the array,
         so this lands newest-first on screen exactly like a single strategy. */
      all.sort((a, b) => {
        // tsKey rather than the raw string: the v2_* RPCs disagree about
        // whether candle_time_ny carries a zone suffix, and a mixed sort would
        // interleave the sessions wrongly.
        const ta = tsKey(a.candle_time_ny), tb = tsKey(b.candle_time_ny);
        if (ta !== tb) return ta < tb ? -1 : 1;
        return String(a._sid).localeCompare(String(b._sid));
      });

      document.getElementById('err').innerHTML = failed.length
        ? `<div class="err">${iconMarkup('ic-alert')}Could not load ${failed.length} of ${strategies.length} strategies: ${escapeHtml(failed.join(', '))}</div>`
        : '';

      /* Both maps are keyed by bare candle time, with no strategy in the key.
         Left populated they would hang one strategy's volume surge on another
         strategy's candle of the same minute - in the table and in the modal. */
      anomalyMap = {};
      volMap = {};
      volRowsCache = null;
      regimeCtx = null;
      priceHistory = [];
      flowHistory = [];
      /* Same reasoning one step further: the wall levels belong to one symbol,
         so across a merged table they would badge QQQ candles against SPY's
         walls. Cleared before renderFlow so signalWallFlag() finds nothing. */
      pinSeries = null;
      pinIndexSeries(null);
      pinIndexStatus(null);
      pinHistory = null;

      renderAggCards(all);
      renderPinCard();
      renderFlow(all);
      renderRegime(null);
      renderVol(null);
      renderAnomalies(null);
      checkAggAlerts(all);
      updateRowCounts();
      applySort('flow');
    }
