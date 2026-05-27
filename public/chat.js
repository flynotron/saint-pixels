/**
 * public/chat.js — Global chat panel (client-side)
 *
 * Drop  <script src="/chat.js"></script>  after app.js in index.html.
 *
 * Requires app.js to expose after login / session restore:
 *   window.__authToken  — Bearer token string
 *   window.__username   — logged-in username string
 *
 * Requires app.js SSE handler to forward chat events:
 *   if (data.type === 'chat') window.__chatIncoming?.(data);
 *
 * Optional profile click-through (if the app has a profile viewer):
 *   window.__openProfile = (username) => { ... };
 *
 * Security notes:
 *  - All user content is rendered via textContent / dataset, never innerHTML,
 *    so XSS through chat messages or usernames is structurally impossible.
 *  - The esc() helper is kept only for the data-u attribute fallback; it now
 *    also escapes single-quotes to prevent attribute-context breakout.
 */

(function () {
  'use strict';

  const MAX_DISPLAY = 200;   // max <li> nodes kept alive in the DOM
  const COOLDOWN_MS = 2_000; // mirrors server-side cooldown for UX feedback

  // ── DOM refs ────────────────────────────────────────────────────────────────
  const panel       = document.getElementById('chat-panel');
  const toggleBtn   = document.getElementById('chat-toggle-btn');
  const closeBtn    = document.getElementById('chat-close-btn');
  const msgList     = document.getElementById('chat-messages');
  const input       = document.getElementById('chat-input');
  const sendBtn     = document.getElementById('chat-send-btn');
  const form        = document.getElementById('chat-form');
  const downloadBtn = document.getElementById('chat-download-btn');
  const unreadBadge = document.getElementById('chat-unread');

  // Bail gracefully if chat HTML is not in the document
  if (!panel || !toggleBtn) return;

  let isOpen       = false;
  let unreadCount  = 0;
  let sendCooldown = false;

  // ── Utilities ────────────────────────────────────────────────────────────────

  function isAtBottom() {
    return msgList.scrollHeight - msgList.scrollTop - msgList.clientHeight < 60;
  }

  function scrollToBottom(force) {
    if (force || isAtBottom()) {
      msgList.scrollTop = msgList.scrollHeight;
    }
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ── Message rendering — DOM API only, no innerHTML on user content ────────────
  //
  // Structure of each message <li>:
  //   <li class="chat-msg">
  //     <span class="chat-user" data-u="<username>"><username></span>
  //     <span class="chat-text"><message></span>
  //     <span class="chat-time"><time></span>
  //   </li>
  //
  // All user-supplied strings are written via .textContent or .dataset,
  // which the browser treats as plain text — no HTML parsing occurs.

  function appendMessage({ username, message, sent_at }, scroll) {
    // Coerce to strings and hard-cap lengths defensively on the client too
    const safeUser = String(username  ?? '').slice(0, 30);
    const safeMsg  = String(message   ?? '').slice(0, 300);
    const safeTime = formatTime(typeof sent_at === 'number' ? sent_at : Date.now());

    const li = document.createElement('li');
    li.className = 'chat-msg';

    const userSpan = document.createElement('span');
    userSpan.className = 'chat-user';
    userSpan.dataset.u = safeUser;   // dataset assignment — no HTML parsing
    userSpan.textContent = safeUser; // textContent — no HTML parsing

    const textSpan = document.createElement('span');
    textSpan.className = 'chat-text';
    textSpan.textContent = safeMsg;  // textContent — no HTML parsing

    const timeSpan = document.createElement('span');
    timeSpan.className = 'chat-time';
    timeSpan.textContent = safeTime;

    li.appendChild(userSpan);
    li.appendChild(textSpan);
    li.appendChild(timeSpan);
    msgList.appendChild(li);

    // Trim oldest messages to stay under the DOM cap
    while (msgList.children.length > MAX_DISPLAY) {
      msgList.removeChild(msgList.firstChild);
    }

    if (scroll !== false) scrollToBottom();
  }

  function appendSystem(text) {
    const li = document.createElement('li');
    li.className = 'chat-msg chat-system';
    li.textContent = String(text).slice(0, 200); // textContent — no HTML parsing
    msgList.appendChild(li);
    scrollToBottom();
  }

  // ── Open / close ──────────────────────────────────────────────────────────────

  function openPanel() {
    isOpen = true;
    panel.classList.remove('hidden');
    unreadCount = 0;
    if (unreadBadge) {
      unreadBadge.textContent = '';
      unreadBadge.classList.remove('visible');
    }
    scrollToBottom(true);
    if (input) input.focus();
  }

  function closePanel() {
    isOpen = false;
    panel.classList.add('hidden');
  }

  toggleBtn.addEventListener('click', () => (isOpen ? closePanel() : openPanel()));
  if (closeBtn) closeBtn.addEventListener('click', closePanel);

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) closePanel();
  });

  // ── Load history ──────────────────────────────────────────────────────────────

  async function loadHistory() {
    try {
      const res = await fetch('/api/chat');
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data?.messages)) return;
      msgList.innerHTML = '';
      for (const msg of data.messages) appendMessage(msg, false);
      scrollToBottom(true);
    } catch (err) {
      console.warn('[chat] Could not load history:', err);
    }
  }

  // ── Incoming SSE message (called from app.js) ─────────────────────────────────

  window.__chatIncoming = function (data) {
    // Reject malformed SSE payloads
    if (!data || typeof data !== 'object') return;
    const wasAtBottom = isAtBottom();
    appendMessage(data, wasAtBottom || isOpen);

    if (!isOpen) {
      unreadCount++;
      if (unreadBadge) {
        unreadBadge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
        unreadBadge.classList.add('visible');
      }
    }
  };

  // ── Send ──────────────────────────────────────────────────────────────────────

  async function sendMessage() {
    if (sendCooldown) return;

    const text = input.value.trim();
    if (!text) return;

    const token = window.__authToken;
    if (!token) {
      appendSystem('You must be logged in to chat.');
      return;
    }

    sendBtn.disabled = true;
    sendCooldown     = true;
    input.value      = '';

    try {
      const res = await fetch('/api/chat', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ message: text }),
      });

      const data = await res.json();
      if (!res.ok) {
        appendSystem(data?.error || 'Failed to send message.');
        input.value = text; // restore on failure
      }
      // On success the server SSE broadcast delivers the message to everyone
    } catch (err) {
      console.error('[chat] send error:', err);
      appendSystem('Network error — could not send.');
      input.value = text;
    }

    setTimeout(() => {
      sendCooldown     = false;
      sendBtn.disabled = false;
    }, COOLDOWN_MS);
  }

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      sendMessage();
    });
  }

  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }

  // ── Profile click-through ─────────────────────────────────────────────────────

  msgList.addEventListener('click', (e) => {
    // Only act on clicks on the .chat-user span
    if (!e.target.classList.contains('chat-user')) return;
    const u = e.target.dataset?.u;
    if (u && typeof window.__openProfile === 'function') {
      window.__openProfile(u);
    }
  });

  // ── Download chat log ─────────────────────────────────────────────────────────

  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      const lines = [];
      for (const li of msgList.querySelectorAll('.chat-msg:not(.chat-system)')) {
        const user = li.querySelector('.chat-user')?.textContent || '?';
        const msg  = li.querySelector('.chat-text')?.textContent || '';
        const time = li.querySelector('.chat-time')?.textContent || '';
        lines.push(`[${time}] ${user}: ${msg}`);
      }
      if (!lines.length) return;

      const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `saint-pixels-chat-${new Date().toISOString().slice(0, 10)}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────

  loadHistory();
  panel.classList.add('hidden'); // ensure panel starts closed

})();
