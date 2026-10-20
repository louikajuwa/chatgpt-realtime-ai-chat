// AI Chat - frontend. Plain ES2020 module, no dependencies (Socket.IO client is the global `io`).
const TOKEN_KEY = 'rtgpt_token';
const CHAT_KEY = 'aichat_current';
const ACK_TIMEOUT = 10000;
const PERSIST_DELAY = 300;
const MAX_INPUT_LINES = 8;

const $ = (id) => document.getElementById(id);
const el = {
  statusPill: $('statusPill'), statusText: $('statusText'), reconnectBtn: $('reconnectBtn'), newChatBtn: $('newChatBtn'),
  banner: $('banner'), busyBox: $('busyBox'), busyText: $('busyText'), retryBtn: $('retryBtn'),
  authPanel: $('authPanel'), authForm: $('authForm'), tokenInput: $('tokenInput'), authError: $('authError'),
  brainInput: $('brainInput'), brainCount: $('brainCount'), brainStatus: $('brainStatus'),
  saveBrain: $('saveBrain'), loadBrain: $('loadBrain'),
  instrInput: $('instrInput'), instrCount: $('instrCount'),
  messages: $('messages'), emptyState: $('emptyState'),
  composer: $('composer'), messageInput: $('messageInput'), sendBtn: $('sendBtn'), stopBtn: $('stopBtn'),
  toasts: $('toasts'),
};

const state = {
  config: { authRequired: false, brainMaxChars: 20000, instructionsMaxChars: 4000, messageMaxChars: 8000 },
  socket: null,
  connected: false,
  needsAuth: false,
  chat: { messages: [], instructions: '' }, // messages: {role, content}; DOM node kept in `nodes`
  streaming: false,
  pendingId: null,   // server id of the in-flight reply (null until the send ack arrives)
  pending: null,     // the assistant placeholder message of the in-flight reply
  early: [],         // events that arrived before the send ack: [{id, fn}]
  brainSaved: '',
  brainPending: false,
  brainAutoLoaded: false,
};
const nodes = new WeakMap(); // message object -> DOM node

/* ---------- Toasts ---------- */
function toast(message, isError = false) {
  const t = document.createElement('div');
  t.className = isError ? 'toast toast-error' : 'toast';
  if (isError) t.setAttribute('role', 'alert');
  t.textContent = message;
  el.toasts.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

/* ---------- Persistence (localStorage may be unavailable) ---------- */
let persistTimer = null;

function persistNow() {
  clearTimeout(persistTimer);
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(state.chat)); } catch (_) { /* ignore */ }
}

function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, PERSIST_DELAY);
}

function restoreChat() {
  try {
    const data = JSON.parse(localStorage.getItem(CHAT_KEY) || 'null');
    if (!data || !Array.isArray(data.messages)) return;
    state.chat.messages = data.messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
      .map((m) => ({ role: m.role, content: m.content }));
    state.chat.instructions = typeof data.instructions === 'string' ? data.instructions : '';
  } catch (_) { /* corrupt or unavailable: start fresh */ }
}

/* ---------- Message rendering (textContent only) ---------- */
function nearBottom() {
  const m = el.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
}

function scrollToBottom() { el.messages.scrollTop = el.messages.scrollHeight; }

function updateEmptyState() {
  el.emptyState.hidden = el.messages.querySelector('.msg') !== null;
}

function makeNode(role, content, extraClass = '') {
  const div = document.createElement('div');
  div.className = `msg ${role}${extraClass ? ' ' + extraClass : ''}`;
  div.textContent = content;
  return div;
}

function appendNode(node) {
  const stick = nearBottom();
  el.messages.appendChild(node);
  updateEmptyState();
  if (stick) scrollToBottom();
}

function renderMessages() {
  el.messages.querySelectorAll('.msg').forEach((n) => n.remove());
  state.chat.messages.forEach((m) => {
    const node = makeNode(m.role, m.content);
    nodes.set(m, node);
    el.messages.appendChild(node);
  });
  updateEmptyState();
  scrollToBottom();
}

function addSystem(text, isError = false) {
  appendNode(makeNode('system', text, isError ? 'is-error' : ''));
}

function addMessage(msg) {
  state.chat.messages.push(msg);
  const node = makeNode(msg.role, msg.content, msg.content ? '' : 'typing');
  nodes.set(msg, node);
  appendNode(node);
}

function removeMessage(msg) {
  const i = state.chat.messages.indexOf(msg);
  if (i >= 0) state.chat.messages.splice(i, 1);
  const node = nodes.get(msg);
  if (node) node.remove();
  updateEmptyState();
}

/* ---------- Status / UI ---------- */
function render() {
  let kind = 'offline';
  let text = 'Disconnected';
  if (state.connected) { kind = 'ready'; text = 'Connected'; }
  else if (!state.needsAuth && state.socket && state.socket.active) { kind = 'connecting'; text = 'Connecting'; }
  el.statusPill.className = 'pill pill-' + kind;
  el.statusText.textContent = text;

  el.reconnectBtn.hidden = state.connected || state.needsAuth || !!(state.socket && state.socket.active);
  el.sendBtn.disabled = state.streaming || !state.connected;
  el.sendBtn.hidden = state.streaming;
  el.stopBtn.hidden = !state.streaming;
  updateBrainButtons();
}

function autoGrow() {
  const input = el.messageInput;
  input.style.height = 'auto';
  const cs = getComputedStyle(input);
  const line = parseFloat(cs.lineHeight) || 24;
  const extra = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']
    .reduce((sum, k) => sum + (parseFloat(cs[k]) || 0), 0);
  const max = line * MAX_INPUT_LINES + extra;
  input.style.height = Math.min(input.scrollHeight, max) + 'px';
  input.style.overflowY = input.scrollHeight > max ? 'auto' : 'hidden';
}

/* ---------- Ack helper ---------- */
function emitAck(event, payload, cb) {
  const s = state.socket;
  if (!s || !s.connected) { cb(new Error('Not connected')); return; }
  const handler = (err, res) => cb(err, res);
  if (payload === undefined) s.timeout(ACK_TIMEOUT).emit(event, handler);
  else s.timeout(ACK_TIMEOUT).emit(event, payload, handler);
}

function ackError(err, res, fallback) {
  if (err) return 'Request timed out. Please try again.';
  if (res && res.ok === false) return (res.error && res.error.message) || fallback;
  if (!res) return fallback;
  return null;
}

/* ---------- Chat ---------- */
function endStreaming() {
  const node = state.pending && nodes.get(state.pending);
  if (node) node.classList.remove('typing');
  state.streaming = false;
  state.pendingId = null;
  state.pending = null;
  state.early = [];
  persistNow();
  render();
}

function showError(message) {
  addSystem(message, true);
  toast(message, true);
}

function send() {
  const text = el.messageInput.value.trim();
  if (!text || state.streaming || !state.connected) return;
  const history = state.chat.messages.map(({ role, content }) => ({ role, content }));
  history.push({ role: 'user', content: text });

  const userMsg = { role: 'user', content: text };
  const aiMsg = { role: 'assistant', content: '' };
  addMessage(userMsg);
  addMessage(aiMsg);
  scrollToBottom();
  el.messageInput.value = '';
  autoGrow();
  state.streaming = true;
  state.pending = aiMsg;
  persistNow();
  render();

  emitAck('chat:send', { messages: history, instructions: state.chat.instructions }, (err, res) => {
    if (state.pending !== aiMsg) return; // already ended (stopped, reset, disconnected)
    const msg = ackError(err, res, 'Could not send message.');
    if (msg) {
      removeMessage(aiMsg);
      removeMessage(userMsg);
      endStreaming();
      showError(msg);
      if (!el.messageInput.value) { el.messageInput.value = text; autoGrow(); }
      return;
    }
    state.pendingId = res.id;
    const queued = state.early.filter((e) => e.id === res.id);
    state.early = [];
    queued.forEach((e) => e.fn());
  });
}

// Run fn for an event with this id; buffer it if the send ack hasn't told us our id yet.
function whenCurrent(id, fn) {
  if (!state.streaming) return;
  if (state.pendingId === null) state.early.push({ id, fn });
  else if (id === state.pendingId) fn();
}

function onDelta(d) {
  if (!d || typeof d.text !== 'string') return;
  whenCurrent(d.id, () => {
    const msg = state.pending;
    const stick = nearBottom();
    msg.content += d.text;
    const node = nodes.get(msg);
    node.classList.remove('typing');
    node.textContent = msg.content;
    if (stick) scrollToBottom();
  });
}

function finishReply(errorMessage) {
  const msg = state.pending;
  if (msg && !msg.content) removeMessage(msg);
  endStreaming();
  if (errorMessage) showError(errorMessage);
}

function onDone(d) { if (d) whenCurrent(d.id, () => finishReply()); }

function onChatError(d) {
  if (d) whenCurrent(d.id, () => finishReply(d.message || 'The assistant could not reply.'));
}

function stop() {
  if (state.streaming) emitAck('chat:stop', undefined, () => {});
}

function newChat() {
  if (state.chat.messages.length && !window.confirm('Start a new chat? The current conversation will be cleared.')) return;
  if (state.streaming) { stop(); endStreaming(); }
  state.chat = { messages: [], instructions: '' };
  el.instrInput.value = '';
  updateInstrCounter();
  persistNow();
  renderMessages();
  render();
  el.messageInput.focus();
}

/* ---------- Chat instructions ---------- */
function updateInstrCounter() {
  const max = state.config.instructionsMaxChars;
  const n = el.instrInput.value.length;
  el.instrCount.textContent = `${n} / ${max}`;
  el.instrCount.classList.toggle('over', n >= max);
  el.instrCount.classList.toggle('warn', n < max && n >= max * 0.9);
}

el.instrInput.addEventListener('input', () => {
  state.chat.instructions = el.instrInput.value;
  updateInstrCounter();
  persistSoon();
});

/* ---------- Knowledge (global brain) ---------- */
function brainDirty() { return el.brainInput.value !== state.brainSaved; }

function updateBrainCounter() {
  const max = state.config.brainMaxChars;
  const n = el.brainInput.value.length;
  el.brainCount.textContent = `${n} / ${max}`;
  el.brainCount.classList.toggle('over', n >= max);
  el.brainCount.classList.toggle('warn', n < max && n >= max * 0.9);
}

function updateBrainButtons() {
  const on = state.connected && !state.brainPending;
  el.saveBrain.disabled = !on || !brainDirty();
  el.loadBrain.disabled = !on;
}

function saveBrain() {
  if (el.saveBrain.disabled) return;
  const value = el.brainInput.value;
  state.brainPending = true;
  updateBrainButtons();
  emitAck('brain:save', { value }, (err, res) => {
    state.brainPending = false;
    const msg = ackError(err, res, 'Could not save knowledge.');
    if (msg) { toast(msg, true); el.brainStatus.textContent = 'Save failed'; }
    else {
      state.brainSaved = value;
      el.brainStatus.textContent = res.savedAt ? `Saved ${new Date(res.savedAt).toLocaleTimeString()}` : 'Saved';
    }
    updateBrainButtons();
  });
}

function loadBrain({ auto = false } = {}) {
  if (state.brainPending) return;
  if (!auto && brainDirty() && !window.confirm('You have unsaved changes. Replace them with the saved knowledge?')) return;
  state.brainPending = true;
  updateBrainButtons();
  emitAck('brain:load', undefined, (err, res) => {
    state.brainPending = false;
    const msg = ackError(err, res, 'Could not load knowledge.');
    if (msg) toast(msg, true);
    else if (!auto || el.brainInput.value === '') {
      const value = typeof res.value === 'string' ? res.value : '';
      el.brainInput.value = value;
      state.brainSaved = value;
      updateBrainCounter();
      el.brainStatus.textContent = 'Loaded';
    }
    updateBrainButtons();
  });
}

el.brainInput.addEventListener('input', () => {
  updateBrainCounter();
  updateBrainButtons();
  if (brainDirty()) el.brainStatus.textContent = 'Unsaved changes';
});
el.saveBrain.addEventListener('click', saveBrain);
el.loadBrain.addEventListener('click', () => loadBrain());
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveBrain(); }
});

/* ---------- Composer ---------- */
el.composer.addEventListener('submit', (e) => { e.preventDefault(); send(); });
el.messageInput.addEventListener('input', autoGrow);
el.messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
el.stopBtn.addEventListener('click', stop);
el.newChatBtn.addEventListener('click', newChat);
window.addEventListener('pagehide', persistNow);

/* ---------- Auth ---------- */
function getToken() { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } }
function setToken(t) { try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch (_) { /* ignore */ } }

function showAuth(errorText) {
  state.needsAuth = true;
  el.authPanel.hidden = false;
  el.authError.hidden = !errorText;
  el.authError.textContent = errorText || '';
  el.tokenInput.value = '';
  el.tokenInput.focus();
  render();
}

el.authForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = el.tokenInput.value.trim();
  if (!t) return;
  setToken(t);
  el.authPanel.hidden = true;
  state.needsAuth = false;
  connect();
});

/* ---------- Socket ---------- */
function connect() {
  if (state.socket) { state.socket.removeAllListeners(); state.socket.disconnect(); }
  el.busyBox.hidden = true;
  const s = io({ auth: { token: getToken() }, transports: ['websocket'] });
  state.socket = s;
  state.connected = false;
  bindSocket(s);
  render();
}

function bindSocket(s) {
  s.on('connect', () => {
    state.connected = true;
    el.busyBox.hidden = true;
    el.authPanel.hidden = true;
    state.needsAuth = false;
    if (state.streaming) finishReply(); // a reply cannot survive a reconnect
    if (!state.brainAutoLoaded) {
      state.brainAutoLoaded = true;
      if (el.brainInput.value === '') loadBrain({ auto: true });
    }
    render();
  });

  s.on('disconnect', () => {
    state.connected = false;
    state.brainPending = false;
    const wasStreaming = state.streaming;
    if (wasStreaming) finishReply();
    addSystem(wasStreaming ? 'Connection lost while the assistant was replying.' : 'Disconnected from server.', wasStreaming);
    render();
  });

  s.on('connect_error', (err) => {
    state.connected = false;
    const m = err && err.message;
    if (m === 'unauthorized') {
      setToken('');
      s.disconnect();
      showAuth('That token was not accepted. Please try again.');
    } else if (m === 'server_busy') {
      s.disconnect();
      el.busyText.textContent = 'The server is busy right now. Please try again in a moment.';
      el.busyBox.hidden = false;
    }
    render();
  });

  s.on('chat:delta', onDelta);
  s.on('chat:done', onDone);
  s.on('chat:error', onChatError);

  s.on('app:error', (d) => {
    const message = (d && d.message) || 'Something went wrong.';
    if (d && d.code === 'NO_API_KEY') { el.banner.textContent = message; el.banner.hidden = false; }
    showError(message);
  });
}

el.reconnectBtn.addEventListener('click', connect);
el.retryBtn.addEventListener('click', connect);

/* ---------- Init ---------- */
async function init() {
  restoreChat();
  el.instrInput.value = state.chat.instructions;
  renderMessages();
  updateBrainCounter();
  updateInstrCounter();
  autoGrow();
  render();
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    if (r.ok) Object.assign(state.config, await r.json());
  } catch (_) {
    toast('Could not load server configuration; using defaults.', true);
  }
  el.brainInput.maxLength = state.config.brainMaxChars;
  el.instrInput.maxLength = state.config.instructionsMaxChars;
  el.messageInput.maxLength = state.config.messageMaxChars;
  updateBrainCounter();
  updateInstrCounter();
  if (state.config.authRequired && !getToken()) showAuth('');
  else connect();
}

init();
