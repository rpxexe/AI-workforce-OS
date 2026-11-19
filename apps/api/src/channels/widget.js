/* global document, window, localStorage, fetch, TextDecoderStream, URL */
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

  const css = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    .wrap { --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #d8dee4; --mine: #1f6feb; --mine-fg: #ffffff; --theirs: #f0f2f5; --err: #cf222e;
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; display: flex; flex-direction: column; align-items: flex-end; gap: 12px; }
    @media (prefers-color-scheme: dark) { .wrap { --bg: #1c1f23; --fg: #e6e6e6; --muted: #9da7b3; --line: #30363d; --mine: #2f81f7; --theirs: #2a2f36; --err: #ff7b72; } }
    button { font: inherit; cursor: pointer; }
    button:focus-visible, textarea:focus-visible { outline: 3px solid color-mix(in srgb, var(--mine) 50%, transparent); outline-offset: 2px; }
    .launcher { width: 56px; height: 56px; border-radius: 50%; border: 0; background: var(--mine); color: var(--mine-fg); box-shadow: 0 4px 16px rgb(0 0 0 / 0.2); display: grid; place-items: center; }
    .panel { width: min(380px, calc(100vw - 32px)); height: min(560px, calc(100vh - 104px)); background: var(--bg); color: var(--fg); border: 1px solid var(--line);
      border-radius: 16px; box-shadow: 0 8px 32px rgb(0 0 0 / 0.18); display: flex; flex-direction: column; overflow: hidden; }
    .panel[hidden] { display: none; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
    header strong { font-size: 15px; }
    .close { border: 0; background: transparent; color: var(--muted); width: 32px; height: 32px; border-radius: 8px; font-size: 20px; line-height: 1; }
    .log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; font-size: 14px; line-height: 1.45; }
    .msg { max-width: 85%; padding: 8px 12px; border-radius: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .USER { align-self: flex-end; background: var(--mine); color: var(--mine-fg); }
    .ASSISTANT { align-self: flex-start; background: var(--theirs); }
    .note { align-self: center; color: var(--err); font-size: 13px; text-align: center; }
    form { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--line); }
    textarea { flex: 1; resize: none; height: 40px; max-height: 120px; padding: 9px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: var(--fg); font-size: 14px; }
    .send { border: 0; border-radius: 10px; padding: 0 14px; background: var(--mine); color: var(--mine-fg); font-size: 14px; font-weight: 600; }
    .send:disabled { opacity: 0.5; cursor: default; }
  `;

  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${css}</style>
    <div class="wrap">
      <section class="panel" role="dialog" aria-label="Chat" hidden>
        <header><strong class="title">Chat</strong><button type="button" class="close" aria-label="Close chat">&times;</button></header>
        <div class="log" role="log" aria-live="polite"></div>
        <form><textarea aria-label="Your message" placeholder="Write a message" maxlength="4000"></textarea><button class="send" type="submit">Send</button></form>
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

  const bubble = (role, text) => {
    const el = document.createElement("div");
    el.className = `msg ${role}`;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  };
  const note = (text) => {
    const el = bubble("note", text);
    el.className = "msg note";
    el.setAttribute("role", "alert");
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
    if (session.messages.length === 0) bubble("ASSISTANT", session.greeting);
    for (const m of session.messages) bubble(m.role, m.content);
  };

  const open = async () => {
    panel.hidden = false;
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
    const reply = bubble("ASSISTANT", "…");
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
          reply.textContent = (started ? reply.textContent : "") + event.text;
          started = true;
          log.scrollTop = log.scrollHeight;
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
    sendButton.disabled = true;
    input.value = "";
    try {
      if (!session) await start();
      bubble("USER", text);
      await send(text);
    } catch (err) {
      note(err.message);
      if (!input.value) input.value = text;
    } finally {
      busy = false;
      sendButton.disabled = false;
      input.focus();
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
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
