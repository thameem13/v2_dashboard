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
    function applyTheme(name) {
      const html = document.documentElement;
      if (name === 'dark') html.setAttribute('data-theme', 'dark');
      else html.removeAttribute('data-theme');
      const btn = document.getElementById('theme-btn');
      // The label names the theme you would switch TO, not the current one.
      if (btn) btn.textContent = name === 'dark' ? '☀️ Light' : '🌙 Dark';
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
      const btn = document.getElementById('collapse-btn');
      if (btn) {
        btn.textContent = collapsed ? '⬇️ Expand' : '⬆️ Compact';
        btn.classList.toggle('active-toggle', collapsed);
      }
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

