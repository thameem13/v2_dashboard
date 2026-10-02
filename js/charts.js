/* charts.js - sparklines, regime strip
   Split from index.html. These are CLASSIC scripts, not modules:
   top-level let/const share one global lexical scope, so the 29
   mutable state variables and the inline onclick handlers keep
   working exactly as before. Load order is load-bearing. */
    /* ══════════════════════════════════════════════════════
       SPARKLINE RENDERER (#9)
       ══════════════════════════════════════════════════════ */
    function themeColor(token) {
      const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
      return v || '#3fb950';   // a token can be missing mid-deploy; never draw nothing
    }

    function drawSparkline(canvasId, data, color) {
      const canvas = document.getElementById(canvasId);
      if (!canvas || !data.length) return;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);

      const w = rect.width;
      const h = rect.height;
      const vals = data.slice(-30); // last 30 points
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const range = (max - min) || 1;
      const pad = 2;

      ctx.clearRect(0, 0, w, h);

      // Draw line
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';

      vals.forEach((v, i) => {
        const x = (i / (vals.length - 1)) * w;
        const y = h - pad - ((v - min) / range) * (h - pad * 2);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Draw fill gradient
      const last = vals[vals.length - 1];
      const lastY = h - pad - ((last - min) / range) * (h - pad * 2);
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, color.replace(')', ', 0.15)').replace('rgb', 'rgba'));
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.fill();

      // Draw endpoint dot
      ctx.beginPath();
      ctx.arc(w, lastY, 2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }

    /* ══════════════════════════════════════════════════════
       REGIME CONTEXT STRIP
       ──────────────────────────────────────────────────────
       Surfaces spy_intraday_log columns the dashboard never showed:
       VIX1D (0DTE vol regime), TICK (breadth), vw_dim zone, implied move
       and distance to the call/put walls.
       ══════════════════════════════════════════════════════ */
    function vixClass(v) {
      if (v == null) return '';
      if (v < 10) return 'rg-calm';
      if (v < 15) return 'rg-elevated';
      return 'rg-high';
    }

    function vixLabel(v) {
      if (v == null) return '-';
      if (v < 10) return 'CALM';
      if (v < 15) return 'ELEVATED';
      return 'HIGH';
    }

    function signedCls(v) {
      if (v == null) return 'muted';
      return v > 0 ? 'call' : (v < 0 ? 'put' : 'muted');
    }

    function num(v, dp) {
      if (v == null || v === '' || isNaN(+v)) return '-';
      return (+v).toFixed(dp == null ? 2 : dp);
    }

    function renderRegime(r) {
      const strip = document.getElementById('regime-strip');
      const body = document.getElementById('regime-body');
      if (!strip || !body) return;

      if (!r) {
        strip.style.display = 'none';
        return;
      }
      strip.style.display = 'flex';

      const vix = r.vix1d == null ? null : +r.vix1d;
      const chg = r.vix1d_chg == null ? null : +r.vix1d_chg;
      const tick = r.tick == null ? null : +r.tick;
      const tick20 = r.tick_avg_20 == null ? null : +r.tick_avg_20;
      const vwd = r.vw_dim == null ? null : +r.vw_dim;

      // vw_dim_zone is the pipeline's own label; colour it by its text.
      const zone = r.vw_dim_zone || '-';
      const zoneCls = /bull/i.test(zone) ? 'call' : (/bear/i.test(zone) ? 'put' : 'muted');

      const items = [
        `<div class="rg-item" title="VIX1D — 1-day implied vol. The 0DTE regime gate: under 10 is calm, 15+ means position smaller.">
           <div class="rg-label">VIX1D</div>
           <div class="rg-val ${vixClass(vix)}">${num(vix, 2)}
             <span class="rg-pill ${vixClass(vix)}">${vixLabel(vix)}</span></div>
           <div class="rg-sub">open ${num(r.vix1d_open, 2)} &nbsp;<span class="${chg > 0 ? 'put' : (chg < 0 ? 'call' : 'muted')}">${chg == null ? '-' : (chg > 0 ? '+' : '') + num(chg, 2)}</span></div>
         </div>`,

        `<div class="rg-item" title="NYSE TICK — advancing minus declining issues. Confirms or vetoes a directional flow signal.">
           <div class="rg-label">TICK</div>
           <div class="rg-val ${signedCls(tick)}">${tick == null ? '-' : (tick > 0 ? '+' : '') + tick}</div>
           <div class="rg-sub">20-avg ${tick20 == null ? '-' : (tick20 > 0 ? '+' : '') + num(tick20, 0)}</div>
         </div>`,

        `<div class="rg-item" title="Volume-weighted dealer imbalance and the pipeline's own zone label.">
           <div class="rg-label">VW-Dim</div>
           <div class="rg-val ${signedCls(vwd)}">${num(vwd, 3)}</div>
           <div class="rg-sub ${zoneCls}">${escapeHtml(zone)}</div>
         </div>`,

        `<div class="rg-item" title="Retail bias vs dealer hedge %. Wide opposing values are the divergence the side-signal detectors hunt.">
           <div class="rg-label">Retail / Hdg</div>
           <div class="rg-val"><span class="${signedCls(r.retail_bias)}">${num(r.retail_bias, 1)}</span>
             <span class="muted">/</span>
             <span class="${signedCls(r.hdg_percent)}">${num(r.hdg_percent, 1)}</span></div>
           <div class="rg-sub">delta ${num(r.delta_net, 1)}</div>
         </div>`,

        `<div class="rg-item" title="Implied move for the session, and IV skew.">
           <div class="rg-label">Impl Move</div>
           <div class="rg-val">&plusmn;${num(r.impl_move, 2)}</div>
           <div class="rg-sub">iv skew ${num(r.iv_skew, 1)}</div>
         </div>`,

        `<div class="rg-item" title="Call wall above / put wall below — the gamma levels that tend to pin or repel price. Distance in SPY points.">
           <div class="rg-label">Walls</div>
           <div class="rg-val"><span class="call">${num(r.call_wall, 0)}</span>
             <span class="muted">/</span>
             <span class="put">${num(r.put_wall, 0)}</span></div>
           <div class="rg-sub">+${num(r.dist_call_wall, 2)} / -${num(r.dist_put_wall, 2)}</div>
         </div>`
      ];

      let staleHtml = '';
      const lag = r.regime_lag_min == null ? null : +r.regime_lag_min;
      if (lag != null && lag >= 10) {
        staleHtml = `<div class="rg-stale">⚠️ regime feed ${num(lag, 0)}m behind flow</div>`;
      }

      body.innerHTML = items.join('') + staleHtml;
    }

