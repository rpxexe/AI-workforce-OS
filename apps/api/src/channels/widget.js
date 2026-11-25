/* global document, window, localStorage, fetch, TextDecoderStream, URL, setInterval, clearInterval, setTimeout */
// The web chat widget, served at /widget.js and embedded with:
//   <script src="https://<api>/widget.js" data-key="wc_..." async></script>
// Optional attributes: data-customer + data-customer-hash (a visitor the website vouches for),
// data-open="true" (open on load). window.WorkforceChat has open(), close() and identify(customer, hash).
// Plain JavaScript with no build step; everything lives in a shadow root so the host page's CSS cannot reach it.
(function () {
  const script = document.currentScript;
  if (!script || !script.dataset.key) return;
  const key = script.dataset.key;
  const api = new URL(script.src).origin;
  const storeKey = `workforce-chat:${key}:visitor`;
  let identity = script.dataset.customer ? { customer: script.dataset.customer, customerHash: script.dataset.customerHash } : null;
  let session = null;
  let busy = false;
  // While a person from the team has the conversation, their messages are fetched every few seconds.
  const POLL_MS = 2500;
  /** The person answering, as the API reports it (first name), once they have written or typed. */
  let agentName = null;
  let pollTimer = null;
  let lastSeen = new Date(0).toISOString();

  // Styled after the dashboard's chat (shadcn/ui neutral theme): the visitor's turn is a muted bubble on the
  // right, the AI answers in plain text, a person from the team in an outlined bubble, and a divider marks
  // each switch between them.
  const css = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    .wrap { --bg: #ffffff; --fg: #0a0a0a; --muted: #f5f5f5; --muted-fg: #737373; --border: #e5e5e5; --primary: #171717; --primary-fg: #fafafa; --ring: #a3a3a3; --err: #dc2626;
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; display: flex; flex-direction: column; align-items: flex-end; gap: 12px; }
    @media (prefers-color-scheme: dark) { .wrap { --bg: #0a0a0a; --fg: #fafafa; --muted: #262626; --muted-fg: #a3a3a3; --border: #262626; --primary: #e5e5e5; --primary-fg: #171717; --ring: #737373; --err: #f87171; } }
    button { font: inherit; cursor: pointer; }
    button:focus-visible, textarea:focus-visible { outline: 3px solid color-mix(in srgb, var(--ring) 50%, transparent); outline-offset: 2px; }
    svg { flex-shrink: 0; }
    .launcher { width: 52px; height: 52px; border-radius: 50%; border: 0; background: var(--primary); color: var(--primary-fg); box-shadow: 0 4px 16px rgb(0 0 0 / 0.2); display: grid; place-items: center; }
    .panel { width: min(380px, calc(100vw - 32px)); height: min(580px, calc(100vh - 100px)); background: var(--bg); color: var(--fg); border: 1px solid var(--border);
      border-radius: 14px; box-shadow: 0 8px 32px rgb(0 0 0 / 0.16); display: flex; flex-direction: column; overflow: hidden; }
    .panel[hidden] { display: none; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 12px 12px 16px; border-bottom: 1px solid var(--border); }
    header strong { font-size: 14px; font-weight: 600; }
    .close { border: 0; background: transparent; color: var(--muted-fg); width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; }
    .close:hover { background: var(--muted); color: var(--fg); }
    .scroller { position: relative; flex: 1; min-height: 0; }
    .log { height: 100%; overflow-y: auto; overscroll-behavior: contain; padding: 16px; display: flex; flex-direction: column; gap: 16px; font-size: 14px; line-height: 1.55;
      /* Same as the dashboard's message list: a thin bar that shows only on hover, room kept for it, and the bottom edge fading out. */
      scrollbar-width: thin; scrollbar-color: transparent transparent; scrollbar-gutter: stable; }
    .log.more { -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 24px), transparent); mask-image: linear-gradient(to bottom, #000 calc(100% - 24px), transparent); }
    .log:hover { scrollbar-color: color-mix(in srgb, var(--muted-fg) 35%, transparent) transparent; }
    .msg { max-width: 85%; white-space: pre-wrap; overflow-wrap: anywhere; }
    .USER { align-self: flex-end; background: var(--muted); padding: 8px 12px; border-radius: 10px; }
    .ASSISTANT { align-self: flex-start; max-width: 100%; }
    .AGENT { align-self: flex-start; border: 1px solid var(--border); padding: 8px 12px; border-radius: 10px; }
    .thinking { color: var(--muted-fg); }
    .thinking span { animation: blink 1.2s infinite both; }
    .thinking span:nth-child(2) { animation-delay: 0.2s; }
    .thinking span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes blink { 0%, 80%, 100% { opacity: 0.2; } 40% { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .thinking span { animation: none; } }
    .who { align-self: flex-start; margin-bottom: -12px; padding: 0 4px; color: var(--muted-fg); font-size: 12px; }
    .typing-row { align-self: flex-start; color: var(--muted-fg); font-size: 13px; }
    .typing-row[hidden] { display: none; }
    .typing-row span { animation: blink 1.2s infinite both; }
    .typing-row span:nth-child(2) { animation-delay: 0.2s; }
    .typing-row span:nth-child(3) { animation-delay: 0.4s; }
    @media (prefers-reduced-motion: reduce) { .typing-row span { animation: none; } }
    .checkpoint { display: flex; align-items: center; gap: 8px; color: var(--muted-fg); font-size: 12px; }
    .checkpoint::before, .checkpoint::after { content: ""; flex: 1; height: 1px; background: var(--border); }
    .note { align-self: center; color: var(--err); font-size: 13px; text-align: center; }
    .to-end { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--border);
      background: var(--bg); color: var(--fg); display: grid; place-items: center; box-shadow: 0 2px 8px rgb(0 0 0 / 0.12); transition: opacity 0.2s, transform 0.2s; }
    .to-end[hidden] { display: grid; opacity: 0; pointer-events: none; transform: translate(-50%, 8px); }
    form { padding: 12px; }
    .composer { display: flex; align-items: flex-end; gap: 8px; border: 1px solid var(--border); border-radius: 10px; padding: 6px 6px 6px 12px; background: var(--bg); }
    .composer:focus-within { border-color: var(--ring); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 35%, transparent); }
    textarea { flex: 1; resize: none; height: 28px; max-height: 120px; padding: 4px 0; border: 0; outline: 0; background: transparent; color: var(--fg); font-size: 14px; line-height: 20px; }
    textarea:focus-visible { outline: 0; }
    textarea::placeholder { color: var(--muted-fg); }
    .send { width: 28px; height: 28px; border: 0; border-radius: 50%; background: var(--primary); color: var(--primary-fg); display: grid; place-items: center; }
    .send:disabled { opacity: 0.5; cursor: default; }
  `;

  /** A Lucide-style stroke icon. */
  const icon = (d, size) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;

  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${css}</style>
    <div class="wrap">
      <section class="panel" role="dialog" aria-label="Chat" hidden>
        <header><strong class="title">Chat</strong><button type="button" class="close" aria-label="Close chat">${icon("M18 6 6 18M6 6l12 12", 18)}</button></header>
        <div class="scroller">
          <div class="log" role="log" aria-live="polite"></div>
          <button type="button" class="to-end" aria-label="Scroll to the latest message" hidden>${icon("M12 5v14M19 12l-7 7-7-7", 16)}</button>
        </div>
        <form><div class="composer"><textarea aria-label="Your message" placeholder="Write a message" maxlength="4000" rows="1"></textarea><button class="send" type="submit" aria-label="Send" disabled>${icon("m5 12 7-7 7 7M12 19V5", 16)}</button></div></form>
      </section>
      <button type="button" class="launcher" aria-label="Open chat" aria-expanded="false">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      </button>
    </div>`;
  const $ = (selector) => root.querySelector(selector);
  const panel = $(".panel");
  const launcher = $(".launcher");
  const log = $(".log");
  const input = $("textarea");
  const sendButton = $(".send");
  const toEnd = $(".to-end");
  /** Who answered last ("ASSISTANT" or "AGENT"), to mark each switch between the AI and a person. */
  let answerer = null;

  // Follow new messages only while the visitor is at the bottom; otherwise offer a button back down.
  const atEnd = () => log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  const scrollToEnd = (smooth) => log.scrollTo({ top: log.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  /** Shows the jump-down button and the bottom fade only while there is more below. */
  const edge = () => {
    toEnd.hidden = atEnd();
    log.classList.toggle("more", !toEnd.hidden);
  };
  log.addEventListener("scroll", edge);
  toEnd.addEventListener("click", () => scrollToEnd(true));
  const append = (el, before) => {
    const follow = atEnd();
    // New rows go before `before` (or the typing row), so "… is typing" always stays last.
    const ref = before || typingRow;
    log.insertBefore(el, ref && ref.parentNode === log ? ref : null);
    if (follow) scrollToEnd(false);
    edge();
    return el;
  };
  /** Grows the box with its text (up to 120px) and enables Send only when there is something to send. */
  const fit = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    sendButton.disabled = busy || !input.value.trim();
  };
  input.addEventListener("input", fit);

  const read = (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const write = (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // Private mode: the visitor gets a new anonymous id next time.
    }
  };

  const checkpoint = (text, before) => {
    const el = document.createElement("div");
    el.className = "checkpoint";
    el.setAttribute("role", "note");
    el.textContent = text;
    append(el, before);
  };
  /** Records who is answering, with a divider when it switches between the AI and a person. */
  const answeredBy = (role, before) => {
    if (answerer && answerer !== role)
      checkpoint(role === "AGENT" ? `${agentName || "A person from our team"} joined` : "You are back with the assistant", before);
    answerer = role;
  };
  const bubble = (role, text) => {
    if (role === "ASSISTANT" || role === "AGENT") answeredBy(role);
    if (role === "AGENT") {
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = agentName || "Our team";
      append(who, typingRow);
    }
    const el = document.createElement("div");
    el.className = `msg ${role}`;
    el.textContent = text;
    return append(el, typingRow);
  };
  const note = (text) => {
    const el = document.createElement("div");
    el.className = "msg note";
    el.setAttribute("role", "alert");
    el.textContent = text;
    append(el);
  };
  // "Sam is typing…" while the person answering writes; kept as the last row of the log.
  const typingRow = document.createElement("div");
  typingRow.className = "typing-row";
  typingRow.hidden = true;
  const showTyping = (on) => {
    if (on) {
      typingRow.textContent = `${agentName || "Our team"} is typing`;
      typingRow.insertAdjacentHTML("beforeend", "<span>.</span><span>.</span><span>.</span>");
      if (!typingRow.isConnected) log.appendChild(typingRow);
    }
    if (typingRow.hidden === !on) return;
    typingRow.hidden = !on;
    if (on && atEnd()) scrollToEnd(false);
  };

  // A person's reply while the visitor looks elsewhere: a chime, and the page title flashes until they come back.
  const pageTitle = document.title;
  let unread = 0;
  let flashTimer = null;
  const chime = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [880, 1320].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const start = ctx.currentTime + i * 0.12;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.15, start + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.25);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.3);
      });
      setTimeout(() => void ctx.close(), 800);
    } catch {
      // Audio blocked or unsupported: the title still flashes.
    }
  };
  const clearAttention = () => {
    unread = 0;
    clearInterval(flashTimer);
    flashTimer = null;
    document.title = pageTitle;
  };
  const attention = (count) => {
    if (!document.hidden && !panel.hidden) return;
    unread += count;
    chime();
    if (flashTimer) return;
    let on = false;
    flashTimer = setInterval(() => {
      on = !on;
      document.title = on ? `(${unread}) New message` : pageTitle;
    }, 1200);
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !panel.hidden) clearAttention();
  });

  const seen = (iso) => {
    if (iso && iso > lastSeen) lastSeen = iso;
  };
  const withPeople = (status) => status === "WAITING_FOR_HUMAN" || status === "HUMAN_ACTIVE";

  const stopPolling = () => {
    clearInterval(pollTimer);
    pollTimer = null;
  };
  const poll = async () => {
    if (!session) return;
    const res = await fetch(`${api}/chat/${encodeURIComponent(key)}/messages?after=${encodeURIComponent(lastSeen)}`, {
      headers: { authorization: `Bearer ${session.token}` },
    }).catch(() => null);
    if (!res || !res.ok) return;
    const data = await res.json();
    if (data.agent && data.agent.name) agentName = data.agent.name;
    showTyping(Boolean(data.agent && data.agent.typing) && data.messages.length === 0);
    for (const m of data.messages) {
      bubble(m.role, m.content);
      seen(m.createdAt);
    }
    if (data.messages.length > 0) attention(data.messages.length);
    if (!withPeople(data.status)) {
      showTyping(false);
      stopPolling();
    }
  };
  const startPolling = () => {
    if (pollTimer) return;
    checkpoint("Connecting you with a person from our team");
    pollTimer = setInterval(() => void poll(), POLL_MS);
  };

  const post = (path, body, token) =>
    fetch(`${api}/chat/${encodeURIComponent(key)}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body),
    });
  const errorOf = async (res) => ((await res.json().catch(() => null)) || {}).error || `Something went wrong (${res.status}).`;

  const start = async () => {
    const res = await post("session", identity || { visitorId: read(storeKey) || undefined });
    if (!res.ok) throw new Error(await errorOf(res));
    session = await res.json();
    if (session.visitorId) write(storeKey, session.visitorId);
    $(".title").textContent = session.employee.name;
    log.textContent = "";
    answerer = null;
    agentName = null;
    typingRow.hidden = true;
    stopPolling();
    if (session.messages.length === 0) bubble("ASSISTANT", session.greeting);
    for (const m of session.messages) {
      bubble(m.role, m.content);
      seen(m.createdAt);
    }
    if (withPeople(session.status)) startPolling();
  };

  const open = async () => {
    panel.hidden = false;
    if (!document.hidden) clearAttention();
    launcher.setAttribute("aria-expanded", "true");
    launcher.setAttribute("aria-label", "Close chat");
    input.focus();
    if (!session)
      await start().catch((err) => {
        note(err.message);
      });
  };
  const close = () => {
    panel.hidden = true;
    launcher.setAttribute("aria-expanded", "false");
    launcher.setAttribute("aria-label", "Open chat");
    launcher.focus();
  };

  const send = async (text) => {
    let res = await post("messages", { message: text }, session && session.token);
    if (res.status === 401) {
      // The session expired: start again (history comes back) and resend once.
      await start();
      bubble("USER", text);
      res = await post("messages", { message: text }, session.token);
    }
    if (!res.ok || !res.body) throw new Error(await errorOf(res));
    // Typing dots until the first words arrive; they do not count as the AI answering yet.
    const reply = document.createElement("div");
    reply.className = "msg ASSISTANT thinking";
    reply.setAttribute("aria-label", "Typing");
    reply.innerHTML = "<span>.</span><span>.</span><span>.</span>";
    append(reply);
    let started = false;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";
      for (const frame of frames) {
        if (!frame.startsWith("data: ")) continue;
        const event = JSON.parse(frame.slice(6));
        if (event.type === "text") {
          const follow = atEnd();
          if (!started) {
            answeredBy("ASSISTANT", reply);
            reply.className = "msg ASSISTANT";
            reply.removeAttribute("aria-label");
          }
          reply.textContent = (started ? reply.textContent : "") + event.text;
          started = true;
          if (follow) scrollToEnd(false);
        } else if (event.type === "held") {
          // A person has the conversation: no AI reply; theirs arrives by polling.
          reply.remove();
          seen(event.message.createdAt);
          startPolling();
        } else if (event.type === "done") {
          seen(event.messages[1].createdAt);
          if (withPeople(event.conversation.status)) startPolling();
        } else if (event.type === "error") {
          reply.remove();
          note(event.error);
        }
      }
    }
  };

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true;
    input.value = "";
    fit();
    try {
      if (!session) await start();
      bubble("USER", text);
      await send(text);
    } catch (err) {
      note(err.message);
      if (!input.value) input.value = text;
    } finally {
      busy = false;
      fit();
      input.focus();
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("form").requestSubmit();
    }
  });
  launcher.addEventListener("click", () => (panel.hidden ? open() : close()));
  $(".close").addEventListener("click", close);
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) close();
  });

  window.WorkforceChat = {
    open,
    close,
    /** Switches to a visitor the website vouches for (after they sign in); the next message starts their chat. */
    identify(customer, customerHash) {
      identity = customer ? { customer, customerHash } : null;
      session = null;
      stopPolling();
      lastSeen = new Date(0).toISOString();
      answerer = null;
      agentName = null;
      typingRow.hidden = true;
      log.textContent = "";
      if (!panel.hidden) void start().catch((err) => note(err.message));
    },
  };

  const mount = () => {
    document.body.appendChild(host);
    if (script.dataset.open === "true") void open();
  };
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
