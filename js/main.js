/* main.js - polling, date range, keyboard, startup
   Split from index.html. These are CLASSIC scripts, not modules:
   top-level let/const share one global lexical scope, so the 29
   mutable state variables and the inline onclick handlers keep
   working exactly as before. Load order is load-bearing. */
    /* ══════════════════════════════════════════════════════
       POLLING INTERVAL
       ══════════════════════════════════════════════════════ */
    function changeInterval() {
      if (pollTimer) clearInterval(pollTimer);
      const ms = parseInt(document.getElementById('poll-interval').value, 10);
      if (ms > 0) {
        pollTimer = setInterval(loadAll, ms);
      }
    }

    /* ══════════════════════════════════════════════════════
       DATE RANGE LOGIC
       ══════════════════════════════════════════════════════ */
    let currentPreset = 'today';

    function todayStr() {
      const d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    }

    function offsetDate(days) {
      const d = new Date();
      d.setDate(d.getDate() - days);
      return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    }

    function setDatePreset(preset) {
      currentPreset = preset;
      const startEl = document.getElementById('date-start');
      const endEl = document.getElementById('date-end');
      const today = todayStr();

      switch (preset) {
        case 'today':
          startEl.value = today;
          endEl.value = today;
          break;
        case 'yesterday':
          const yd = offsetDate(1);
          startEl.value = yd;
          endEl.value = yd;
          break;
        case '3d':
          startEl.value = offsetDate(2);
          endEl.value = today;
          break;
        case '5d':
          startEl.value = offsetDate(4);
          endEl.value = today;
          break;
        case 'all':
          startEl.value = '';
          endEl.value = '';
          break;
      }

      // Update preset button highlight
      document.querySelectorAll('.date-presets button').forEach(b => b.classList.remove('active-preset'));
      event.target.classList.add('active-preset');

      updateDateMode();
      loadAll();
    }

    function onDateChange() {
      // Clear preset highlights when user manually edits dates
      currentPreset = 'custom';
      document.querySelectorAll('.date-presets button').forEach(b => b.classList.remove('active-preset'));
      updateDateMode();
      loadAll();
    }

    function getDateContext() {
      const startEl = document.getElementById('date-start');
      const endEl = document.getElementById('date-end');
      const start = startEl.value;
      const end = endEl.value;
      const today = todayStr();

      // "Live" if both dates are today or both empty (defaults to today via RPC)
      const isToday = (!start && !end) || (start === today && end === today);
      const isLive = isToday || currentPreset === 'today';

      return {
        isLive,
        start: start || null,
        end: end || null
      };
    }

    function updateDateMode() {
      const ctx = getDateContext();
      const badge = document.getElementById('date-mode-badge');
      const pollSelect = document.getElementById('poll-interval');

      if (ctx.isLive) {
        badge.textContent = '● Live';
        badge.className = 'date-mode-badge live';
        // Re-enable auto-poll
        pollSelect.disabled = false;
        changeInterval();
      } else {
        badge.textContent = '● Historical';
        badge.className = 'date-mode-badge historical';
        // Disable auto-poll for historical data
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        pollSelect.disabled = true;
      }
    }

    function initDatePicker() {
      const today = todayStr();
      document.getElementById('date-start').value = today;
      document.getElementById('date-end').value = today;
    }

    /* ══════════════════════════════════════════════════════
       KEYBOARD SHORTCUTS (#7)
       ══════════════════════════════════════════════════════ */
    document.addEventListener('keydown', (e) => {
      // Don't fire shortcuts when typing in input/select fields
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      // Modal open: only Esc (close it) gets through — everything else is suppressed
      if (document.getElementById('modal-journal').classList.contains('visible')) {
        if (e.key.toLowerCase() === 'escape') {
          e.preventDefault();
          closeModal();
        }
        return;
      }

      // A sticky alert is a deliberate "you must see this" card, so Esc
      // clears it before falling through to clearFilters() below.
      if (e.key.toLowerCase() === 'escape' && dismissNewestStickyAlert()) {
        e.preventDefault();
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'r':
          e.preventDefault();
          loadAll();
          break;
        case '1':
          e.preventDefault();
          switchTab('flow');
          break;
        case '2':
          e.preventDefault();
          switchTab('vol');
          break;
        case '3':
          e.preventDefault();
          switchTab('anomaly');
          break;
        case '4':
          e.preventDefault();
          switchTab('perf');
          break;
        case 'escape':
          e.preventDefault();
          clearFilters();
          break;
        case 't':
          e.preventDefault();
          toggleTheme();
          break;
        case 'h':
          e.preventDefault();
          toggleHeader();
          break;
        case 's':
          e.preventDefault();
          toggleSound();
          break;
        case 'd':
          e.preventDefault();
          // Cycle: today → yesterday → 3d → 5d → all → today
          const cycle = ['today', 'yesterday', '3d', '5d', 'all'];
          const idx = cycle.indexOf(currentPreset);
          const next = cycle[(idx + 1) % cycle.length];
          // Simulate button click for the preset
          const btns = document.querySelectorAll('.date-presets button');
          btns[cycle.indexOf(next)]?.click();
          break;
        case '?':
          e.preventDefault();
          document.getElementById('kbd-panel').classList.toggle('visible');
          break;
      }
    });

    /* ══════════════════════════════════════════════════════
       INIT
       ══════════════════════════════════════════════════════ */
    function initBuildStamp() {
      const el = document.getElementById('foot-build');
      if (el) el.textContent = `build ${BUILD}`;
      // Also surface it in the console on load, so a screenshot of DevTools
      // is enough to confirm which build is running.
      console.log(`Trade Flow Dashboard build ${BUILD} (${BUILD_TS})`);
    }

    initBuildStamp();
    watchStickyHeaders();
    initStrategy();
    initTheme();
    initHeaderCollapse();
    initDatePicker();
    initPinnedRows();
    initHiddenCols();
    initStickyAlerts();
    initPush();
    initSound();
    loadAll();
    loadStrategies();   // fills the dropdown; loadAll already has the saved id
    changeInterval();
    loadNews();
    setInterval(() => loadNews(), 5 * 60 * 1000);
    window.addEventListener('resize', () => { syncNewsPanelHeight(); syncStickyHeaderOffsets(); });
  
