/* chrome.js - theme, header collapse, pinned rows, column visibility
   Split from index.html. These are CLASSIC scripts, not modules:
   top-level let/const share one global lexical scope, so the 29
   mutable state variables and the inline onclick handlers keep
   working exactly as before. Load order is load-bearing. */
    /* ══════════════════════════════════════════════════════
       THEME TOGGLE (#8)
       ══════════════════════════════════════════════════════ */
    /* Light is now the default, so the absence of a data-theme attribute
       means light and [data-theme="dark"] is the override. The stored values
       are still the strings 'light' and 'dark', so anyone with an existing
       preference keeps it - only the no-preference default moved. */
    /* ════════════════════════════════════════════════════
       ICON BUTTON STATE
       ════════════════════════════════════════════════════
       The toolbar toggles are icon-only, so they have no text node: state is
       the icon, the pressed flag and the tooltip. Every caller below used to
       write textContent, which on these buttons would DELETE the <svg> child
       and leave a blank square - which is why none of them set a label any
       more, and why the one write left in the fetch path (rpc.js) became a
       class instead.

       Declared here rather than in alerts.js, which loads earlier: function
       declarations do not hoist across classic scripts, but every caller runs
       after load from main.js, so by then this is defined.
       ════════════════════════════════════════════════════ */
    function setIconBtn(id, { on, icon, label } = {}) {
      const btn = document.getElementById(id);
      if (!btn) return;
      if (on !== undefined) {
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.classList.toggle('active-toggle', on);
      }
      if (icon) {
        const use = btn.querySelector('use');
        if (use) use.setAttribute('href', '#' + icon);
      }
      if (label) btn.title = label;
    }

    function applyTheme(name) {
      const html = document.documentElement;
      if (name === 'dark') html.setAttribute('data-theme', 'dark');
      else html.removeAttribute('data-theme');
      // The icon and tooltip name the theme you would switch TO, not the
      // current one. No aria-pressed: this is a mode, not an on/off toggle,
      // so 'pressed' would have no honest value.
      setIconBtn('theme-btn', {
        icon: name === 'dark' ? 'ic-sun' : 'ic-moon',
        label: name === 'dark' ? 'Switch to light theme (T)' : 'Switch to dark theme (T)'
      });
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', name === 'dark' ? '#0b0e11' : '#f7f7f5');
    }

    function toggleTheme() {
      const next = document.documentElement.getAttribute('data-theme') === 'dark'
        ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem('v2-theme', next); } catch (e) { }
    }

    /* ══════════════════════════════════════════════════════
       HEADER COLLAPSE
       The header band is fixed while only the table scrolls, so on a short
       screen it eats the rows. This hides the cards/regime/news/date band and
       hands that space to the table; the title row and tabs stay put.
       ══════════════════════════════════════════════════════ */
    /* DOM and button state only, with no persistence. Split out of
       toggleHeader() so the phone default below can collapse the band without
       recording a preference the user never expressed: v2-header-collapsed is
       shared with the desktop layout on the same device, and a remembered '1'
       would go on to collapse the desktop header too. */
    function applyHeaderCollapsed(collapsed) {
      const top = document.getElementById('top');
      if (!top) return;
      top.classList.toggle('collapsed', collapsed);
      setIconBtn('collapse-btn', {
        on: collapsed,
        icon: collapsed ? 'ic-chevron-down' : 'ic-chevron-up',
        label: collapsed
          ? 'Expand the header band (H)'
          : 'Collapse the header band for maximum table height (H)'
      });
    }

    function toggleHeader() {
      const top = document.getElementById('top');
      if (!top) return;
      const collapsed = !top.classList.contains('collapsed');
      applyHeaderCollapsed(collapsed);
      try { localStorage.setItem('v2-header-collapsed', collapsed ? '1' : '0'); } catch (e) { }
    }

    function initHeaderCollapse() {
      let saved = null;
      try { saved = localStorage.getItem('v2-header-collapsed'); } catch (e) { }
      if (saved === '1') { applyHeaderCollapsed(true); return; }
      if (saved === '0') return;
      // On a phone the header band would own the whole screen before a single
      // table row is visible, so start collapsed -- but only when the user has
      // made no choice yet, and without persisting this as their choice.
      if (window.matchMedia('(max-width: 700px)').matches) applyHeaderCollapsed(true);
    }

    function initTheme() {
      let saved = null;
      try { saved = localStorage.getItem('v2-theme'); } catch (e) { }
      applyTheme(saved === 'dark' ? 'dark' : 'light');
    }

    /* ══════════════════════════════════════════════════════
       ROW PINNING LOGIC
       ══════════════════════════════════════════════════════ */
    function initPinnedRows() {
      try {
        const f = localStorage.getItem('v2-pinned-flow');
        const v = localStorage.getItem('v2-pinned-vol');
        if (f) pinnedFlow = new Set(JSON.parse(f));
        if (v) pinnedVol = new Set(JSON.parse(v));
      } catch (e) { }
    }

    function togglePinFlow(key, e) {
      if (e) e.stopPropagation();
      if (pinnedFlow.has(key)) pinnedFlow.delete(key);
      else pinnedFlow.add(key);
      try { localStorage.setItem('v2-pinned-flow', JSON.stringify([...pinnedFlow])); } catch (e) { }
      loadAll();
    }

    function togglePinVol(key, e) {
      if (e) e.stopPropagation();
      if (pinnedVol.has(key)) pinnedVol.delete(key);
      else pinnedVol.add(key);
      try { localStorage.setItem('v2-pinned-vol', JSON.stringify([...pinnedVol])); } catch (e) { }
      loadAll();
    }

    /* ══════════════════════════════════════════════════════
       COLUMN VISIBILITY MANAGEMENT
       ══════════════════════════════════════════════════════ */
    // The Columns button opens whichever menu belongs to the active tab.
    function toggleColumnMenu() {
      const flowMenu = document.getElementById('col-menu');
      const volMenu = document.getElementById('col-menu-vol');
      const wantVol = activeTab === 'vol';
      const target = wantVol ? volMenu : flowMenu;
      const other = wantVol ? flowMenu : volMenu;
      if (other) other.classList.remove('visible');
      if (target) target.classList.toggle('visible');
    }

    function closeColumnMenus() {
      ['col-menu', 'col-menu-vol'].forEach(id => {
        const m = document.getElementById(id);
        if (m) m.classList.remove('visible');
      });
    }

    function toggleCol(colClass, isVisible) {
      if (isVisible) hiddenCols.delete(colClass);
      else hiddenCols.add(colClass);

      document.querySelectorAll(`.${colClass}`).forEach(el => {
        el.style.display = isVisible ? '' : 'none';
      });
      try { localStorage.setItem('v2-hidden-cols', JSON.stringify([...hiddenCols])); } catch (e) { }
    }

    function applyHiddenCols() {
      hiddenCols.forEach(colClass => {
        document.querySelectorAll(`.${colClass}`).forEach(el => el.style.display = 'none');
        const chk = document.querySelector(`.col-menu input[onchange*="${colClass}"]`);
        if (chk) chk.checked = false;
      });
    }

    // Call Chg% / Put Chg% are candle-over-candle and extremely noisy (median
    // absolute change ~26%, range -68%..+621%), so they start hidden. The
    // smoothed Vol Trend column replaces them for everyday reading.
    const DEFAULT_HIDDEN_COLS = ['vcol-cchg', 'vcol-pchg'];

    function initHiddenCols() {
      try {
        const saved = localStorage.getItem('v2-hidden-cols');
        if (saved) {
          hiddenCols = new Set(JSON.parse(saved));
          return;
        }
      } catch (e) { }
      hiddenCols = new Set(DEFAULT_HIDDEN_COLS);
    }


    /* ══════════════════════════════════════════════════════
       STRATEGY SELECTION
       ══════════════════════════════════════════════════════ */
    function initStrategy() {
      try {
        const saved = localStorage.getItem('v2-strategy');
        if (saved) currentStrategy = saved;
      } catch (e) { }
    }

    async function loadStrategies() {
      try {
        const rows = await rpcWithRetry('list_strategies', null, {}, 1);
        strategyList = Array.isArray(rows) ? rows : [];
      } catch (e) {
        console.warn('Strategy list failed:', e);
        strategyList = [];
      }

      const sel = document.getElementById('strategy-select');
      if (!sel) return;

      if (!strategyList.length) {
        /* The registry is unreachable. Rather than an empty dropdown that
           looks broken, show the strategy we are actually running. */
        sel.innerHTML = `<option value="${escapeHtml(currentStrategy)}">${escapeHtml(currentStrategyLabel())}</option>`;
        return;
      }

      // A saved strategy that has since been retired would select nothing and
      // leave the dropdown blank while the page loaded that strategy's data.
      if (!strategyList.some(s => s.id === currentStrategy)) {
        currentStrategy = strategyList[0].id;
      }

      sel.innerHTML = strategyList.map(s =>
        `<option value="${escapeHtml(s.id)}"${s.id === currentStrategy ? ' selected' : ''}>` +
        `${escapeHtml(s.label || (s.name + ' - ' + s.symbol))}</option>`).join('');
    }

    function changeStrategy() {
      const sel = document.getElementById('strategy-select');
      if (!sel || sel.value === currentStrategy) return;
      currentStrategy = sel.value;
      try { localStorage.setItem('v2-strategy', currentStrategy); } catch (e) { }

      /* Every cache below is keyed by candle time, not by strategy, so leaving
         any of them would paint one symbol's history under another's name.
         Sparklines are the worst of these: stale history still draws a
         plausible line, so it is wrong without looking wrong. */
      volRowsCache = null;
      volMap = {};
      anomalyMap = {};
      perfRows = null;
      perfKey = null;
      premRows = null;
      premKey = null;
      priceHistory = [];
      flowHistory = [];
      regimeCtx = null;
      lastAlertTimestamp = null;     // do not re-chime the other symbol's last signal
      lastAnomalyTimestamp = null;

      /* Rules are per strategy, so the inputs have to follow the switch -
         otherwise QQQ would be backtested with SPY's targets still showing. */
      initPremParams();

      loadAll();
      if (activeTab === 'prem') loadPremium(true);
    }

    /* ══════════════════════════════════════════════════════
       BUILD STALENESS

       This page is left open for a whole session. It polls data every 10s but
       never re-fetches its own HTML or JS, so a tab opened before a deploy
       keeps running that older build indefinitely - and the only clue is a
       build number in the footer that nobody reads. That is exactly how a
       shipped fix looked like it had not worked: the modal kept saying SPY
       over QQQ's numbers because the tab was still running the old signal.js.

       Cloudflare already serves assets with max-age=0, must-revalidate, so a
       reload genuinely does pick up a new build. The missing part is knowing
       that a reload is needed.
       ══════════════════════════════════════════════════════ */

    async function checkForNewBuild() {
      // Nothing to learn while the tab is in the background, and no reason to
      // spend a request on it.
      if (typeof document.visibilityState === 'string'
          && document.visibilityState !== 'visible') return;
      try {
        const res = await fetch('/index.html', {
          cache: 'no-store',          // the whole point: ask the server, every time
          credentials: 'same-origin'
        });
        if (!res.ok) return;
        const html = await res.text();
        const m = /<meta\s+name="build"\s+content="([^"]+)"/.exec(html);
        /* The meta match IS the auth guard. isAuthChallenge() cannot be reused
           here: it treats "ok + text/html" as a login redirect, which is what
           our own index.html is, so it would suppress every check. Access's
           login page simply has no build meta, so it falls out here with no
           notice and no error. */
        if (!m) return;
        latestBuildSeen = m[1];
        if (latestBuildSeen !== BUILD && latestBuildSeen !== buildNoticeDismissed) {
          showBuildNotice(latestBuildSeen);
        }
        markBuildStale(latestBuildSeen !== BUILD);
      } catch (e) {
        // Offline, or the request was blocked. Silence is correct: this is a
        // convenience, and a failed check must never look like a real error.
      }
    }

    function markBuildStale(stale) {
      const el = document.getElementById('foot-build');
      if (!el) return;
      el.classList.toggle('build-stale', !!stale);
      el.title = stale
        ? `You are running build ${BUILD}; ${latestBuildSeen} is deployed. Reload to update.`
        : 'Deployed build. This tab is running the current version.';
    }

    function showBuildNotice(newBuild) {
      const el = document.getElementById('build-notice');
      if (!el) return;
      const v = document.getElementById('build-notice-ver');
      if (v) v.textContent = newBuild;
      el.classList.add('visible');
    }

    function dismissBuildNotice() {
      // Remembers the BUILD waved away, not a boolean, so the next deploy
      // after this one still gets to speak up.
      buildNoticeDismissed = latestBuildSeen;
      const el = document.getElementById('build-notice');
      if (el) el.classList.remove('visible');
    }

    function reloadForNewBuild() {
      window.location.reload();
    }

    /* The instrument the selected strategy trades. Everything user-facing that
       names a symbol must come through here: the modal, the KPI label, the
       exports and the browser notifications all used to say "SPY" literally,
       so switching to QQQ relabelled the page but left every one of them
       asserting the wrong instrument over QQQ's numbers.

       The regex is a fallback for the window before list_strategies() returns -
       strategy ids end with their symbol. If even that does not match it
       returns '', because a missing symbol is recoverable and a wrong one is
       what this is fixing. */
    function currentSymbol() {
      const s = strategyList.find(x => x.id === currentStrategy);
      if (s && s.symbol) return s.symbol;
      const m = /_([a-z]{1,6})$/.exec(currentStrategy || '');
      return m ? m[1].toUpperCase() : '';
    }

    function currentStrategyLabel() {
      const s = strategyList.find(x => x.id === currentStrategy);
      return s ? (s.label || (s.name + ' - ' + s.symbol)) : currentStrategy;
    }
