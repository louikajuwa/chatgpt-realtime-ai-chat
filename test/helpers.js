'use strict';

async function waitFor(fn, { timeout = 3000, interval = 10, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

function captureLogger() {
  const calls = [];
  const mk = (level) => (msg, meta) => calls.push({ level, msg, meta });
  return { calls, debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') };
}

function testConfig(over = {}) {
  return Object.freeze({
    port: 0,
    redis: { host: '127.0.0.1', port: 6379, password: undefined },
    openaiApiKey: 'test-key',
    openaiModel: 'test-model',
    openaiBaseUrl: 'http://127.0.0.1:1/v1',
    accessToken: undefined,
    allowedOrigins: [],
    maxConnections: 20,
    brainMaxChars: 20000,
    maxHistoryMessages: 40,
    messageMaxChars: 8000,
    instructionsMaxChars: 4000,
    ...over,
  });
}

module.exports = { waitFor, captureLogger, testConfig };
