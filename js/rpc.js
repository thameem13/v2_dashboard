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
      document.getElementById('err').innerHTML = '';

      // (#6) Save scroll positions before re-render
      const flowWrap = document.getElementById('flow-wrap');
      const volWrap = document.getElementById('vol-wrap');
      const flowScroll = flowWrap ? flowWrap.scrollTop : 0;
      const volScroll = volWrap ? volWrap.scrollTop : 0;

      try {
        // Determine which RPC functions + params to use based on date range
        const dateCtx = getDateContext();
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

        const [flow, vol, anomalies, regime] = await Promise.all([
          flowPromise, volPromise, anomaliesPromise, regimePromise
        ]);

        // v2_regime_context returns at most one row.
        regimeCtx = (regime && regime.length) ? regime[0] : null;
        renderRegime(regimeCtx);

        anomalyMap = {};
        (anomalies || []).forEach(a => { anomalyMap[tsKey(a.candle_time_ny)] = a; });

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
        if (activeTab === 'prem' && premKey !== premKeyFor(dateCtx)) loadPremium();

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
        refBtn.classList.remove('is-loading');
        refBtn.removeAttribute('aria-busy');
      }
    }

