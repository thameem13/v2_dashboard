/* news.js - Finnhub headlines panel
   Split from index.html. These are CLASSIC scripts, not modules:
   top-level let/const share one global lexical scope, so the 29
   mutable state variables and the inline onclick handlers keep
   working exactly as before. Load order is load-bearing. */
    /* ══════════════════════════════════════════════════════
       MARKET NEWS PANEL
       ══════════════════════════════════════════════════════ */
    function getNewsKey() {
      try { return localStorage.getItem('v2-finnhub-key') || ''; } catch (e) { return ''; }
    }

    function renderNewsKeyForm(errorMsg) {
      const body = document.getElementById('news-body');
      body.innerHTML = `
        <div class="news-key-form">
          ${errorMsg ? `<div class="news-error">${escapeHtml(errorMsg)}</div>` : ''}
          <div class="news-key-hint">
            Paste a free Finnhub API key to show market headlines.
            Get one at <a href="https://finnhub.io/register" target="_blank" rel="noopener">finnhub.io/register</a>.
          </div>
          <input type="text" id="news-key-input" placeholder="Finnhub API key">
          <button onclick="saveNewsKey()">Save &amp; Load News</button>
        </div>`;
    }

    function saveNewsKey() {
      const input = document.getElementById('news-key-input');
      const key = (input && input.value || '').trim();
      if (!key) return;
      try { localStorage.setItem('v2-finnhub-key', key); } catch (e) { }
      loadNews(true);
    }

    function changeNewsKey() {
      renderNewsKeyForm();
    }

    async function loadNews(forceRefresh) {
      const key = getNewsKey();
      if (!key) {
        renderNewsKeyForm();
        return;
      }

      const body = document.getElementById('news-body');
      if (forceRefresh) body.innerHTML = 'Loading...';

      try {
        const res = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${encodeURIComponent(key)}&_=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const articles = await res.json();
        renderNews(articles);
      } catch (e) {
        console.warn('News load failed:', e);
        renderNewsKeyForm('Couldn\'t load news — check your API key or connection.');
      }
    }

    function renderNews(articles) {
      const body = document.getElementById('news-body');
      if (!articles || !articles.length) {
        body.innerHTML = '<div class="news-error">No news available right now.</div>';
        return;
      }

      const top = articles
        .slice()
        .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
        .slice(0, 15);

      const itemsHtml = top.map(a => {
        const time = a.datetime
          ? new Date(a.datetime * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : '-';
        return `
          <div class="news-item">
            <div class="news-item-time">${escapeHtml(time)}</div>
            <a href="${escapeHtml(a.url || '#')}" target="_blank" rel="noopener">${escapeHtml(a.headline || 'Untitled')}</a>
            <div class="news-item-source">${escapeHtml(a.source || '')}</div>
          </div>`;
      }).join('');

      body.innerHTML = `
        <span class="news-change-key" onclick="changeNewsKey()">change API key</span>
        <div class="news-list">${itemsHtml}</div>`;
    }

