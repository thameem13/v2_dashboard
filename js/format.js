/* format.js - escaping, number/time formatting, sync age, filter matching
   Split from index.html. These are CLASSIC scripts, not modules:
   top-level let/const share one global lexical scope, so the 29
   mutable state variables and the inline onclick handlers keep
   working exactly as before. Load order is load-bearing. */
    /* ══════════════════════════════════════════════════════
       UTILITIES & ESCAPING
       ══════════════════════════════════════════════════════ */
    function escapeHtml(str) {
      if (str == null) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function fmtTime(ts) {
      if (!ts) return '-';
      const m = String(ts).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
      if (!m) return escapeHtml(ts);
      let h = +m[4], mi = m[5], ap = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      const time = `${h}:${mi} ${ap}`;

      // In multi-day mode, prefix with date
      const ctx = getDateContext();
      if (!ctx.isLive && ctx.start !== ctx.end) {
        return `${+m[2]}/${+m[3]} ${time}`;
      }
      return time;
    }

    function fmtNum(n) {
      if (n == null || isNaN(n)) return '-';
      return (+n).toLocaleString();
    }

    // Compact contract counts: 1.2M / 345.6k / 812
    function fmtCompact(n) {
      if (n == null || n === '' || isNaN(+n)) return '-';
      const v = +n;
      const a = Math.abs(v);
      if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
      if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k';
      return v.toLocaleString();
    }

    // Compact dollars: $4.5M / $812k / $95
    function fmtDollar(n) {
      if (n == null || n === '' || isNaN(+n)) return '-';
      const v = +n;
      const a = Math.abs(v);
      const sign = v < 0 ? '-' : '';
      if (a >= 1e9) return sign + '$' + (a / 1e9).toFixed(2) + 'B';
      if (a >= 1e6) return sign + '$' + (a / 1e6).toFixed(2) + 'M';
      if (a >= 1e3) return sign + '$' + (a / 1e3).toFixed(0) + 'k';
      return sign + '$' + a.toFixed(0);
    }

    function gate(v) {
      return v ? '<span class="gate-y">Y</span>' : '<span class="gate-n">-</span>';
    }

    function gradePill(g) {
      const safe = escapeHtml(g || '-');
      return `<span class="pill p${safe}">${safe}</span>`;
    }

    /* ══════════════════════════════════════════════════════
       TIMESTAMP KEY NORMALISER
       ──────────────────────────────────────────────────────
       The v2_* RPCs are inconsistent about their candle_time_ny type:
         v2_dashboard_today  → timestamptz  ("...T14:50:00+00:00")
         v2_anomalies_today  → timestamp    ("...T14:50:00")
         v2_dashboard_range  → timestamp    ("...T14:50:00")
         v2_anomalies_range  → timestamptz  ("...T14:50:00+00:00")
       So the raw strings never matched in EITHER mode and the surge pills
       never rendered. All these timestamps are NY wall-clock regardless of
       the declared type, so we key on the bare "YYYY-MM-DDTHH:MM" and drop
       any zone suffix.
       ══════════════════════════════════════════════════════ */
    function tsKey(v) {
      if (v == null) return '';
      // Strip a trailing "Z" or "+HH:MM" / "-HH:MM" offset, then seconds.
      const s = String(v).trim().replace(' ', 'T')
        .replace(/(?:Z|[+-]\d{2}:?\d{2})$/, '');
      const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
      return m ? `${m[1]}T${m[2]}:${m[3]}` : s;
    }

    function surgePill(t) {
      if (!t || t === 'none') return '';
      const cls = t === 'CALL SURGE' ? 'surge-call' : (t === 'PUT SURGE' ? 'surge-put' : 'surge-mixed');
      return `<span class="surge-pill ${cls}">${escapeHtml(t)}</span>`;
    }

    /* ══════════════════════════════════════════════════════
       RELATIVE "LAST SYNCED" TIMER (#4)
       ══════════════════════════════════════════════════════ */
    function updateSyncAge() {
      if (!lastSyncTime) return;
      const el = document.getElementById('foot-time');
      const ago = Math.round((Date.now() - lastSyncTime) / 1000);

      if (ago < 5) {
        el.textContent = 'Last synced: just now';
      } else if (ago < 60) {
        el.textContent = `Last synced: ${ago}s ago`;
      } else {
        const mins = Math.floor(ago / 60);
        el.textContent = `Last synced: ${mins}m ${ago % 60}s ago`;
      }

      // Highlight stale (>60s)
      el.classList.toggle('stale', ago > 60);
    }

    setInterval(updateSyncAge, 1000);

    /* ══════════════════════════════════════════════════════
       SMART NUMERIC FILTER EVALUATOR
       ══════════════════════════════════════════════════════ */
    function matchNumericOrText(filterStr, cellText) {
      if (!filterStr) return true;
      const filter = filterStr.trim();
      const cleanVal = parseFloat(String(cellText).replace(/,/g, '').replace(/%/g, ''));

      if (!isNaN(cleanVal)) {
        // Magnitude comparisons — for signed columns like Flow, where "strong"
        // means far from zero in either direction (e.g. "abs>=0.9").
        const lower = filter.toLowerCase();
        if (lower.startsWith('abs>=')) return Math.abs(cleanVal) >= parseFloat(lower.slice(5));
        if (lower.startsWith('abs<=')) return Math.abs(cleanVal) <= parseFloat(lower.slice(5));
        if (lower.startsWith('abs>')) return Math.abs(cleanVal) > parseFloat(lower.slice(4));
        if (lower.startsWith('abs<')) return Math.abs(cleanVal) < parseFloat(lower.slice(4));

        if (filter.startsWith('>=')) return cleanVal >= parseFloat(filter.slice(2));
        if (filter.startsWith('<=')) return cleanVal <= parseFloat(filter.slice(2));
        if (filter.startsWith('>')) return cleanVal > parseFloat(filter.slice(1));
        if (filter.startsWith('<')) return cleanVal < parseFloat(filter.slice(1));
        if (filter.startsWith('=')) return cleanVal === parseFloat(filter.slice(1));
      }
      return cellText.toLowerCase().indexOf(filter.toLowerCase()) >= 0;
    }

