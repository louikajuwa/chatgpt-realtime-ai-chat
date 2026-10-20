'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ChatError, buildInstructions, validateMessages, createChatService } = require('../src/chatService');
const { captureLogger, testConfig } = require('./helpers');

const BASE = 'You are a helpful, friendly AI assistant. Answer clearly and concisely.';
const LIMITS = { maxMessages: 3, maxChars: 10 };

test('buildInstructions: base only, with brain, with chat instructions, both', () => {
  assert.strictEqual(buildInstructions('', ''), BASE);
  assert.strictEqual(buildInstructions('  ', undefined), BASE);
  assert.strictEqual(buildInstructions(' pie ', ''), `${BASE}\n\nSaved knowledge (use when relevant):\npie`);
  assert.strictEqual(buildInstructions('', ' be brief '), `${BASE}\n\nInstructions for this chat:\nbe brief`);
  assert.strictEqual(buildInstructions('pie', 'be brief'),
    `${BASE}\n\nSaved knowledge (use when relevant):\npie\n\nInstructions for this chat:\nbe brief`);
});

test('validateMessages: accepts and cleans', () => {
  const r = validateMessages([{ role: 'user', content: 'a', extra: 1 }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }], LIMITS);
  assert.deepStrictEqual(r, { ok: true, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] });
});

test('validateMessages: keeps only the last maxMessages', () => {
  const msgs = ['1', '2', '3', '4', '5'].map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content }));
  const r = validateMessages(msgs, LIMITS);
  assert.deepStrictEqual(r.messages.map((m) => m.content), ['3', '4', '5']);
});

test('validateMessages: rejects bad input', () => {
  const bad = [
    undefined, 'x', [], [null], ['x'],
    [{ role: 'system', content: 'x' }],
    [{ role: 'user', content: 5 }],
    [{ role: 'user', content: '   ' }],
    [{ role: 'user', content: 'x'.repeat(11) }],
    [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }],
  ];
  for (const b of bad) {
    const r = validateMessages(b, LIMITS);
    assert.strictEqual(r.ok, false, JSON.stringify(b));
    assert.strictEqual(r.code, 'INVALID_MESSAGES');
    assert.ok(r.message);
  }
});

test('validateMessages: assistant content may be empty', () => {
  const r = validateMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: '' }, { role: 'user', content: 'b' }], LIMITS);
  assert.strictEqual(r.ok, true);
});

const enc = new TextEncoder();
function sseBody(text, size = 7) {
  const bytes = enc.encode(text);
  return (async function* () {
    for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size);
  })();
}
const evt = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;

function setup(fetchImpl, configOver) {
  const logger = captureLogger();
  const svc = createChatService({ config: testConfig({ openaiBaseUrl: 'http://api.test/v1', ...configOver }), fetchImpl, logger });
  return { svc, logger };
}

test('stream: sends request, parses SSE split mid-event, ignores [DONE]', async () => {
  let seen;
  const body = evt({ type: 'response.created' })
    + evt({ type: 'response.output_text.delta', delta: 'Hel' })
    + evt({ type: 'response.output_text.delta', delta: 'lo' })
    + evt({ type: 'response.completed', response: {} })
    + 'data: [DONE]\n\n';
  const { svc } = setup(async (url, init) => { seen = { url, init }; return { ok: true, body: sseBody(body) }; });
  const out = [];
  await svc.stream({ instructions: 'ins', messages: [{ role: 'user', content: 'hi' }], onDelta: (d) => out.push(d) });
  assert.deepStrictEqual(out, ['Hel', 'lo']);
  assert.strictEqual(seen.url, 'http://api.test/v1/responses');
  assert.strictEqual(seen.init.method, 'POST');
  assert.strictEqual(seen.init.headers.Authorization, 'Bearer test-key');
  assert.deepStrictEqual(JSON.parse(seen.init.body), {
    model: 'test-model', instructions: 'ins', input: [{ role: 'user', content: 'hi' }], stream: true,
  });
});

test('stream: handles CRLF framing and a final event without trailing blank line', async () => {
  const body = 'data: {"type":"response.output_text.delta","delta":"a"}\r\n\r\ndata: {"type":"response.output_text.delta","delta":"b"}';
  const { svc } = setup(async () => ({ ok: true, body: sseBody(body, 5) }));
  const out = [];
  await svc.stream({ instructions: '', messages: [], onDelta: (d) => out.push(d) });
  assert.deepStrictEqual(out, ['a', 'b']);
});

test('stream: non-2xx throws UPSTREAM_ERROR with status, logs body, hides it from message', async () => {
  const { svc, logger } = setup(async () => ({ ok: false, status: 429, text: async () => 'rate limited secret' }));
  await assert.rejects(svc.stream({ instructions: '', messages: [], onDelta() {} }), (e) => {
    assert.ok(e instanceof ChatError);
    assert.strictEqual(e.code, 'UPSTREAM_ERROR');
    assert.ok(e.message.includes('429'));
    assert.ok(!e.message.includes('secret'));
    return true;
  });
  assert.ok(logger.calls.some((c) => c.level === 'error' && c.meta.body === 'rate limited secret'));
});

test('stream: response.failed and error events throw UPSTREAM_ERROR', async () => {
  for (const type of ['response.failed', 'error']) {
    const { svc } = setup(async () => ({ ok: true, body: sseBody(evt({ type, error: { message: 'bad' } })) }));
    await assert.rejects(svc.stream({ instructions: '', messages: [], onDelta() {} }), (e) => e.code === 'UPSTREAM_ERROR');
  }
});

test('stream: abort maps to ABORTED', async () => {
  const ac = new AbortController();
  const { svc } = setup((url, init) => new Promise((_res, rej) => {
    init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const p = svc.stream({ instructions: '', messages: [], signal: ac.signal, onDelta() {} });
  ac.abort();
  await assert.rejects(p, (e) => e instanceof ChatError && e.code === 'ABORTED');
});

test('stream: abort while reading the body maps to ABORTED', async () => {
  const body = (async function* () {
    yield enc.encode(evt({ type: 'response.output_text.delta', delta: 'x' }));
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  })();
  const { svc } = setup(async () => ({ ok: true, body }));
  await assert.rejects(svc.stream({ instructions: '', messages: [], onDelta() {} }), (e) => e.code === 'ABORTED');
});

test('stream: network failure maps to UPSTREAM_ERROR', async () => {
  const { svc } = setup(async () => { throw new Error('ECONNREFUSED'); });
  await assert.rejects(svc.stream({ instructions: '', messages: [], onDelta() {} }), (e) => e.code === 'UPSTREAM_ERROR');
});

test('stream: missing API key throws NO_API_KEY without calling fetch', async () => {
  let called = false;
  const { svc } = setup(async () => { called = true; }, { openaiApiKey: undefined });
  await assert.rejects(svc.stream({ instructions: '', messages: [], onDelta() {} }),
    (e) => e.code === 'NO_API_KEY' && e.message === 'OPENAI_API_KEY is not configured.');
  assert.strictEqual(called, false);
});
