/* alerts.js - sticky alert cards, push notifications, chime
   Split from index.html. These are CLASSIC scripts, not modules:
   top-level let/const share one global lexical scope, so the 29
   mutable state variables and the inline onclick handlers keep
   working exactly as before. Load order is load-bearing. */
    /* ══════════════════════════════════════════════════════
       STICKY IN-PAGE ALERTS
       ══════════════════════════════════════════════════════
       An alert card drawn by the page itself, so nothing can
       time it out — it stays until the user closes it. This is
       the reliable half of the alert story: the OS notifications
       below are auto-hidden by Windows after a few seconds, and
       only fire at all when Push is toggled on.
       ══════════════════════════════════════════════════════ */
    function stickyAlertStack() {
      return document.getElementById('alert-stack');
    }

    /* `icon` is a sprite symbol id rather than a glyph inside `title`:
       the title is escapeHtml'd below, so an <svg> passed through there
       would render as literal markup. */
    function pushStickyAlert({ kind, title, icon, rows, ts }) {
      if (!stickyAlertsEnabled) return;
      const stack = stickyAlertStack();
      if (!stack) return;

      const id = 'sticky-alert-' + (++alertSeq);
      const card = document.createElement('div');
      card.className = 'sticky-alert ' + (kind || '');
      card.id = id;

      const body = (rows || [])
        .map(([label, val]) => `<div class="sticky-alert-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(val)}</span></div>`)
        .join('');

      card.innerHTML = `
        <div class="sticky-alert-head">
          <div>
            <div class="sticky-alert-title">${iconMarkup(icon)}${escapeHtml(title)}</div>
            <div class="sticky-alert-time">${ts ? fmtTime(ts) : ''}</div>
          </div>
          <button class="alert-close" title="Dismiss">✕</button>
        </div>
        ${body}`;

      card.querySelector('.alert-close').onclick = () => dismissStickyAlert(id);
      stack.appendChild(card);
      updateAlertStackControls();
      // Newest card sits at the bottom of the stack — keep it in view once the
      // stack is tall enough to scroll.
      stack.scrollTop = stack.scrollHeight;
    }

    function dismissStickyAlert(id) {
      const card = document.getElementById(id);
      if (card) card.remove();
      updateAlertStackControls();
    }

    function clearStickyAlerts() {
      const stack = stickyAlertStack();
      if (!stack) return;
      stack.querySelectorAll('.sticky-alert').forEach(el => el.remove());
      updateAlertStackControls();
    }

    /* Returns true if a card was actually dismissed, so the Esc handler can
       tell whether to fall through to clearFilters(). */
    function dismissNewestStickyAlert() {
      const stack = stickyAlertStack();
      if (!stack) return false;
      const cards = stack.querySelectorAll('.sticky-alert');
      if (!cards.length) return false;
      cards[cards.length - 1].remove();
      updateAlertStackControls();
      return true;
    }

    function updateAlertStackControls() {
      const stack = stickyAlertStack();
      if (!stack) return;

      // A busy session must not bury the page — drop the oldest cards.
      let cards = stack.querySelectorAll('.sticky-alert');
      for (let i = 0; i < cards.length - MAX_STICKY_ALERTS; i++) cards[i].remove();
      cards = stack.querySelectorAll('.sticky-alert');

      let btn = document.getElementById('alert-clear-all');
      if (!btn) {
        btn = document.createElement('button');
        btn.id = 'alert-clear-all';
        btn.className = 'alert-clear-all';
        btn.onclick = clearStickyAlerts;
        stack.prepend(btn);   // first child => renders above the cards
      }
      btn.textContent = `Clear all (${cards.length})`;
      btn.classList.toggle('visible', cards.length >= 2);
    }

    function toggleStickyAlerts() {
      stickyAlertsEnabled = !stickyAlertsEnabled;
      if (!stickyAlertsEnabled) clearStickyAlerts();
      updateAlertBtn();
      try { localStorage.setItem('v2-sticky-alerts', stickyAlertsEnabled ? '1' : '0'); } catch (e) { }
    }

    function updateAlertBtn() {
      setIconBtn('alert-btn', {
        on: stickyAlertsEnabled,
        label: 'Sticky alerts: ' + (stickyAlertsEnabled ? 'on' : 'off')
      });
    }

    function initStickyAlerts() {
      let saved = null;
      try { saved = localStorage.getItem('v2-sticky-alerts'); } catch (e) { }
      if (saved === '0') stickyAlertsEnabled = false;
      updateAlertBtn();
    }

    /* ══════════════════════════════════════════════════════
       PUSH NOTIFICATIONS SYSTEM
       ══════════════════════════════════════════════════════ */
    function togglePushNotifications() {
      if (!('Notification' in window)) {
        alert('Desktop push notifications are not supported in your browser.');
        return;
      }
      if (Notification.permission === 'granted') {
        pushEnabled = !pushEnabled;
        updatePushBtn();
        persistPush();
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(permission => {
          if (permission === 'granted') {
            pushEnabled = true;
            updatePushBtn();
            persistPush();
            // Deliberately NOT requireInteraction: this is a transient
            // acknowledgement of a button press, not an alert worth keeping.
            new Notification('Trade Flow Dashboard Pro', { body: 'Desktop push alerts enabled!' });
          }
        });
      } else {
        alert('Notification permission was blocked in browser settings.');
      }
    }

    function updatePushBtn() {
      setIconBtn('push-btn', {
        on: pushEnabled,
        label: 'Push notifications: ' + (pushEnabled ? 'on' : 'off')
      });
    }

    function persistPush() {
      try { localStorage.setItem('v2-push', pushEnabled ? '1' : '0'); } catch (e) { }
    }

    /* Push used to reset to OFF on every reload -- the flag was the only
       toggle in the dashboard with no init/restore pair -- so alerts went
       quiet the moment the page was refreshed. */
    function initPush() {
      // Notification is undefined outside a secure context. sendPushNotification()
      // reads Notification.permission OUTSIDE its try block, and that read was
      // only ever unreachable because pushEnabled could not start true. Restoring
      // the flag from storage removes that protection, so guard it here.
      if (!('Notification' in window)) { updatePushBtn(); return; }
      let saved = null;
      try { saved = localStorage.getItem('v2-push'); } catch (e) { }
      // Only restore ON if the OS permission is still live: it may have been
      // revoked in browser settings since the flag was written.
      if (saved === '1' && Notification.permission === 'granted') pushEnabled = true;
      updatePushBtn();
    }

    function sendPushNotification(sig) {
      if (!pushEnabled || Notification.permission !== 'granted') return;
      const title = `🚨 SPY ${sig.direction} Alert (Score ${sig.score})`;
      const body = `Strike: $${sig.atm_strike} | Price: $${sig.price} | Flow: ${sig.flow} | Grade: ${sig.grade}`;
      try {
        // requireInteraction: the signal you missed while away from the desk is
        // exactly the one worth keeping on screen -- same reasoning as the
        // in-page sticky alert cards, which have no auto-dismiss timer either.
        new Notification(title, { body, requireInteraction: true });
      } catch (e) {
        console.warn('Push notification failed:', e);
      }
    }

    function sendAnomalyPushNotification(anom) {
      if (!pushEnabled || Notification.permission !== 'granted') return;
      const title = `⚠️ SPY ${anom.anomaly_type} Detected`;
      const body = `${anom.vol_multiple}x avg vol | Calls: ${anom.total_calls} | Puts: ${anom.total_puts} | C/P ${anom.cp_ratio}`;
      try {
        new Notification(title, { body, requireInteraction: true });
      } catch (e) {
        console.warn('Push notification failed:', e);
      }
    }

    /* ══════════════════════════════════════════════════════
       NEW ANOMALY ALERT — fires the sticky in-page card, the
       chime and the OS notification once per new anomaly
       (dedup'd by candle_time_ny + anomaly_type)
       ══════════════════════════════════════════════════════ */
    function checkNewAnomaly(anomalies) {
      if (!anomalies || !anomalies.length) return;
      const latest = anomalies[anomalies.length - 1];
      const key = latest.candle_time_ny + '_' + latest.anomaly_type;
      if (key === lastAnomalyTimestamp) return;
      lastAnomalyTimestamp = key;
      const dir = latest.anomaly_type === 'PUT SURGE' ? 'PUT' : 'CALL';
      playChime(dir);
      pushStickyAlert({
        kind: 'anomaly',
        title: `SPY ${latest.anomaly_type} Detected`,
        icon: 'ic-alert',
        rows: [
          ['Vol', `${latest.vol_multiple}x avg`],
          ['Calls', latest.total_calls],
          ['Puts', latest.total_puts],
          ['C/P', latest.cp_ratio]
        ],
        ts: latest.candle_time_ny
      });
      sendAnomalyPushNotification(latest);
    }

    /* ══════════════════════════════════════════════════════
       AUDIO SYSTEM — Directional Audio Chime
       ══════════════════════════════════════════════════════ */
    function getAudioCtx() {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) audioCtx = new AC();
      }
      return audioCtx;
    }

    function playChime(direction) {
      if (!soundEnabled) return;
      try {
        const ctx = getAudioCtx();
        if (!ctx) return;
        if (ctx.state === 'suspended') ctx.resume();

        const playTone = (freq, start, duration, type = 'sine') => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = type;
          osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
          gain.gain.setValueAtTime(0.12, ctx.currentTime + start);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + duration);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(ctx.currentTime + start);
          osc.stop(ctx.currentTime + start + duration);
        };

        if (direction === 'PUT') {
          // Warning low chime for PUTs
          playTone(440.0, 0.0, 0.25, 'triangle');
          playTone(349.23, 0.15, 0.40, 'triangle');
        } else {
          // High upbeat chime for CALLs
          playTone(523.25, 0.0, 0.18);
          playTone(659.25, 0.10, 0.18);
          playTone(783.99, 0.20, 0.35);
        }
      } catch (e) {
        console.warn('Audio play failed:', e);
      }
    }

    /* Paired with initSound() below, matching updateAlertBtn/initStickyAlerts
       and updatePushBtn/initPush. Keeping the button's look derived from
       soundEnabled - rather than hardcoding the on state into the markup -
       is what makes it still correct if sound ever gains persistence. */
    function updateSoundBtn() {
      setIconBtn('sound-btn', {
        on: soundEnabled,
        icon: soundEnabled ? 'ic-volume' : 'ic-volume-off',
        label: 'Alert chime: ' + (soundEnabled ? 'on' : 'off') + ' (S)'
      });
    }

    function toggleSound() {
      soundEnabled = !soundEnabled;
      updateSoundBtn();
      if (soundEnabled) playChime('CALL');
    }

    /* Sound was the one toggle with no init, so the button never got
       .active-toggle on load and rendered grey - identical to a genuinely
       disabled toggle - while soundEnabled was true and the chime was armed.
       Harmless while the label read "Sound: ON" in words; a lie once the
       button became icon-only and the icon was the only signal left.

       There is nothing to restore here: unlike theme, header, sticky alerts
       and push, sound is deliberately not persisted, so it starts on every
       session. This exists to make the button say so. */
    function initSound() {
      updateSoundBtn();
    }

