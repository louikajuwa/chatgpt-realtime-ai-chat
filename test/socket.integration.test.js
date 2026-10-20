'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: ioc } = require('socket.io-client');
const { createServer } = require('../src/app');
const { createBrainStore } = require('../src/brainStore');
const { ChatError } = require('../src/chatService');
const { waitFor, captureLogger, testConfig } = require('./helpers');

function fakeRedis() {
  const data = new Map();
  return {
    down: false,
    async get(k) { return data.has(k) ? data.get(k) : null; },
    async set(k, v) { data.set(k, v); return 'OK'; },
    async ping() { if (this.down) throw new Error('down'); return 'PONG'; },
  };
}

// Fake chat service: records calls, streams the words of "reply" as deltas.
// With hang:true it waits until aborted; with fail set it throws that error.
function fakeChatService() {
  const svc = {
    calls: [],
    aborted: 0,
    hang: false,
    fail: null,
    async stream({ instructions, messages, signal, onDelta }) {
      svc.calls.push({ instructions, messages });
      if (svc.fail) throw svc.fail;
      if (svc.hang) {
        await new Promise((res) => signal.addEventListener('abort', res, { once: true }));
        svc.aborted += 1;
        throw new ChatError('ABORTED', 'Request was stopped.');
      }
      onDelta('Hello ');
      onDelta('world');
    },
  };
  return svc;
}

async function start(configOver = {}) {
  const redis = fakeRedis();
  const chat = fakeChatService();
  const config = testConfig({ brainMaxChars: 50, ...configOver });
  const logger = captureLogger();
  const server = createServer({ config, store: createBrainStore(redis, { maxChars: config.brainMaxChars }), chatService: chat, logger });
  await new Promise((r) => server.httpServer.listen(0, '127.0.0.1', r));
  const port = server.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  const clients = [];
  const t = {
    chat, redis, server, base, logger,
    client(opts = {}) {
      const c = ioc(base, { reconnection: false, forceNew: true, transports: ['websocket'], ...opts });
      c.events = [];
      c.onAny((name, payload) => c.events.push({ name, payload }));
      c.find = (name, pred = () => true) => c.events.find((e) => e.name === name && pred(e.payload));
      clients.push(c);
      return c;
    },
    async connected(opts) {
      const c = t.client(opts);
      await new Promise((res, rej) => { c.on('connect', res); c.on('connect_error', rej); });
      return c;
    },
    async stop() {
      for (const c of clients) c.close();
      await server.close();
    },
  };
  return t;
}

const emitAck = (c, ev, ...args) => new Promise((res) => c.emit(ev, ...args, res));
const connectError = (c) => new Promise((res) => c.on('connect_error', (e) => res(e.message)));
const userMsg = (content) => [{ role: 'user', content }];

test('auth: rejected without/with wrong token, accepted with right one', async () => {
  const t = await start({ accessToken: 's3cret' });
  try {
    assert.strictEqual(await connectError(t.client()), 'unauthorized');
    assert.strictEqual(await connectError(t.client({ auth: { token: 'wrong' } })), 'unauthorized');
    assert.strictEqual(await connectError(t.client({ auth: { token: 5 } })), 'unauthorized');
    const c = await t.connected({ auth: { token: 's3cret' } });
    assert.ok(c.connected);
  } finally { await t.stop(); }
});

test('connection cap', async () => {
  const t = await start({ maxConnections: 1 });
  try {
    await t.connected();
    assert.strictEqual(await connectError(t.client()), 'server_busy');
  } finally { await t.stop(); }
});

test('brain save -> load round trip with acks', async () => {
  const t = await start();
  try {
    const c = await t.connected();
    const saved = await emitAck(c, 'brain:save', { value: 'remember pie' });
    assert.strictEqual(saved.ok, true);
    assert.ok(saved.savedAt);
    assert.deepStrictEqual(await emitAck(c, 'brain:load'), { ok: true, value: 'remember pie' });
  } finally { await t.stop(); }
});

test('invalid brain payloads return error acks and server survives', async () => {
  const t = await start();
  try {
    const c = await t.connected();
    for (const bad of [null, 42, 'str', {}, { value: 5 }]) {
      const r = await emitAck(c, 'brain:save', bad);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error.code, 'INVALID_BRAIN');
    }
    const long = await emitAck(c, 'brain:save', { value: 'x'.repeat(51) });
    assert.strictEqual(long.error.code, 'BRAIN_TOO_LONG');
    // no ack function supplied must not crash
    c.emit('brain:save', null);
    c.emit('chat:stop');
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(c.connected);
    assert.strictEqual((await emitAck(c, 'brain:load')).ok, true);
  } finally { await t.stop(); }
});

test('storage failure gives STORAGE_ERROR', async () => {
  const t = await start();
  try {
    const c = await t.connected();
    t.redis.set = async () => { throw new Error('boom secret'); };
    const r = await emitAck(c, 'brain:save', { value: 'a' });
    assert.deepStrictEqual(r, { ok: false, error: { code: 'STORAGE_ERROR', message: 'Could not save. Please try again.' } });
  } finally { await t.stop(); }
});

test('chat:send acks first, then streams deltas and done', async () => {
  const t = await start();
  try {
    const c = await t.connected();
    await emitAck(c, 'brain:save', { value: 'remember pie' });
    const ack = await emitAck(c, 'chat:send', { messages: userMsg('hi'), instructions: ' be brief ' });
    assert.strictEqual(ack.ok, true);
    assert.ok(ack.id);
    await waitFor(() => c.find('chat:done'), { label: 'done' });
    const deltas = c.events.filter((e) => e.name === 'chat:delta').map((e) => e.payload);
    assert.deepStrictEqual(deltas, [{ id: ack.id, text: 'Hello ' }, { id: ack.id, text: 'world' }]);
    assert.deepStrictEqual(c.find('chat:done').payload, { id: ack.id });
    const call = t.chat.calls[0];
    assert.deepStrictEqual(call.messages, userMsg('hi'));
    assert.ok(call.instructions.includes('remember pie'));
    assert.ok(call.instructions.includes('Instructions for this chat:\nbe brief'));
  } finally { await t.stop(); }
});

test('chat:send invalid payloads return error acks', async () => {
  const t = await start({ instructionsMaxChars: 10 });
  try {
    const c = await t.connected();
    const r1 = await emitAck(c, 'chat:send', { messages: [] });
    assert.deepStrictEqual([r1.ok, r1.error.code], [false, 'INVALID_MESSAGES']);
    const r2 = await emitAck(c, 'chat:send', { messages: [{ role: 'assistant', content: 'x' }] });
    assert.strictEqual(r2.error.code, 'INVALID_MESSAGES');
    const r3 = await emitAck(c, 'chat:send', { messages: userMsg('hi'), instructions: 5 });
    assert.strictEqual(r3.error.code, 'INVALID_INSTRUCTIONS');
    const r4 = await emitAck(c, 'chat:send', { messages: userMsg('hi'), instructions: 'x'.repeat(11) });
    assert.strictEqual(r4.error.code, 'INVALID_INSTRUCTIONS');
    const r5 = await emitAck(c, 'chat:send', null);
    assert.strictEqual(r5.error.code, 'INVALID_MESSAGES');
    assert.strictEqual(t.chat.calls.length, 0);
  } finally { await t.stop(); }
});

test('chat:stop aborts the stream and emits done with stopped', async () => {
  const t = await start();
  try {
    t.chat.hang = true;
    const c = await t.connected();
    const ack = await emitAck(c, 'chat:send', { messages: userMsg('hi') });
    await waitFor(() => t.chat.calls.length === 1, { label: 'stream started' });
    assert.deepStrictEqual(await emitAck(c, 'chat:stop'), { ok: true });
    await waitFor(() => c.find('chat:done'), { label: 'done' });
    assert.deepStrictEqual(c.find('chat:done').payload, { id: ack.id, stopped: true });
  } finally { await t.stop(); }
});

test('a new chat:send aborts the previous stream', async () => {
  const t = await start();
  try {
    t.chat.hang = true;
    const c = await t.connected();
    const first = await emitAck(c, 'chat:send', { messages: userMsg('one') });
    await waitFor(() => t.chat.calls.length === 1);
    t.chat.hang = false;
    const second = await emitAck(c, 'chat:send', { messages: userMsg('two') });
    await waitFor(() => c.find('chat:done', (p) => p.id === second.id), { label: 'second done' });
    assert.deepStrictEqual(c.find('chat:done', (p) => p.id === first.id).payload, { id: first.id, stopped: true });
  } finally { await t.stop(); }
});

test('chat errors: ChatError message passed through, others masked', async () => {
  const t = await start();
  try {
    const c = await t.connected();
    t.chat.fail = new ChatError('NO_API_KEY', 'OPENAI_API_KEY is not configured.');
    const a = await emitAck(c, 'chat:send', { messages: userMsg('hi') });
    await waitFor(() => c.find('chat:error', (p) => p.id === a.id));
    assert.deepStrictEqual(c.find('chat:error', (p) => p.id === a.id).payload,
      { id: a.id, code: 'NO_API_KEY', message: 'OPENAI_API_KEY is not configured.' });
    t.chat.fail = new Error('secret internals');
    const b = await emitAck(c, 'chat:send', { messages: userMsg('hi') });
    await waitFor(() => c.find('chat:error', (p) => p.id === b.id));
    assert.deepStrictEqual(c.find('chat:error', (p) => p.id === b.id).payload,
      { id: b.id, code: 'INTERNAL', message: 'Something went wrong.' });
  } finally { await t.stop(); }
});

test('brain load failure during chat falls back to empty brain', async () => {
  const t = await start();
  try {
    const c = await t.connected();
    t.redis.get = async () => { throw new Error('boom'); };
    const ack = await emitAck(c, 'chat:send', { messages: userMsg('hi') });
    await waitFor(() => c.find('chat:done'));
    assert.ok(ack.ok);
    assert.ok(!t.chat.calls[0].instructions.includes('Saved knowledge'));
    assert.ok(t.logger.calls.some((l) => l.level === 'warn' && l.msg === 'brain load failed'));
  } finally { await t.stop(); }
});

test('disconnect aborts the active stream', async () => {
  const t = await start();
  try {
    t.chat.hang = true;
    const c = await t.connected();
    await emitAck(c, 'chat:send', { messages: userMsg('hi') });
    await waitFor(() => t.chat.calls.length === 1);
    c.close();
    await waitFor(() => t.chat.aborted === 1, { label: 'abort on disconnect' });
  } finally { await t.stop(); }
});

test('rate limit on rapid chat:send', async () => {
  const t = await start();
  try {
    const c = await t.connected();
    const results = await Promise.all(Array.from({ length: 12 }, () => emitAck(c, 'chat:send', { messages: userMsg('hi') })));
    assert.ok(results.some((r) => r.ok));
    assert.ok(results.some((r) => !r.ok && r.error.code === 'RATE_LIMITED'));
  } finally { await t.stop(); }
});

test('/healthz ok and degraded; never needs OpenAI', async () => {
  const t = await start({ openaiApiKey: undefined });
  try {
    let res = await fetch(`${t.base}/healthz`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { status: 'ok', redis: true });
    t.redis.down = true;
    res = await fetch(`${t.base}/healthz`);
    assert.strictEqual(res.status, 503);
    assert.deepStrictEqual(await res.json(), { status: 'degraded', redis: false });
  } finally { await t.stop(); }
});

test('/api/config', async () => {
  const t = await start({ accessToken: 'x', brainMaxChars: 123, messageMaxChars: 77, instructionsMaxChars: 55 });
  try {
    const res = await fetch(`${t.base}/api/config`);
    assert.deepStrictEqual(await res.json(), { authRequired: true, brainMaxChars: 123, instructionsMaxChars: 55, messageMaxChars: 77 });
  } finally { await t.stop(); }
});

test('security headers present, x-powered-by absent', async () => {
  const t = await start();
  try {
    const res = await fetch(`${t.base}/healthz`);
    const h = res.headers;
    assert.strictEqual(h.get('x-powered-by'), null);
    assert.ok(h.get('content-security-policy').startsWith("default-src 'self'; script-src 'self'"));
    assert.ok(h.get('content-security-policy').includes("frame-ancestors 'none'"));
    assert.ok(!/media-src|worker-src/.test(h.get('content-security-policy')));
    assert.strictEqual(h.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(h.get('referrer-policy'), 'no-referrer');
    assert.strictEqual(h.get('x-frame-options'), 'DENY');
    assert.strictEqual(h.get('permissions-policy'), 'microphone=(), camera=(), geolocation=()');
  } finally { await t.stop(); }
});

test('cross-origin handshake rejected; same-origin and no-origin allowed', async () => {
  const t = await start();
  try {
    const bad = t.client({ extraHeaders: { Origin: 'http://evil.example' } });
    await connectError(bad);
    assert.ok(!bad.connected);
    const same = await t.connected({ extraHeaders: { Origin: t.base } });
    assert.ok(same.connected);
    const none = await t.connected();
    assert.ok(none.connected);
  } finally { await t.stop(); }
});

test('allowedOrigins permits listed cross-origin', async () => {
  const t = await start({ allowedOrigins: ['http://app.example'] });
  try {
    const ok = await t.connected({ extraHeaders: { Origin: 'http://app.example' } });
    assert.ok(ok.connected);
    await connectError(t.client({ extraHeaders: { Origin: 'http://evil.example' } }));
  } finally { await t.stop(); }
});
