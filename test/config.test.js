'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadConfig } = require('../src/config');

test('defaults', () => {
  const c = loadConfig({});
  assert.strictEqual(c.port, 3000);
  assert.deepStrictEqual({ ...c.redis }, { host: '127.0.0.1', port: 6379, password: undefined });
  assert.strictEqual(c.openaiApiKey, undefined);
  assert.strictEqual(c.openaiModel, 'gpt-5-mini');
  assert.strictEqual(c.openaiBaseUrl, 'https://api.openai.com/v1');
  assert.strictEqual(c.maxHistoryMessages, 40);
  assert.strictEqual(c.messageMaxChars, 8000);
  assert.strictEqual(c.instructionsMaxChars, 4000);
  assert.strictEqual(c.realtimeModel, undefined);
  assert.strictEqual(c.accessToken, undefined);
  assert.deepStrictEqual([...c.allowedOrigins], []);
  assert.strictEqual(c.maxConnections, 20);
  assert.strictEqual(c.brainMaxChars, 20000);
});

test('overrides and parsing', () => {
  const c = loadConfig({
    PORT: '8080',
    REDIS_HOST: 'redis',
    REDIS_PORT: '6380',
    REDIS_PASSWORD: 'pw',
    OPENAI_API_KEY: 'k',
    APP_ACCESS_TOKEN: 't',
    ALLOWED_ORIGINS: 'http://a.com, http://b.com ,',
    MAX_CONNECTIONS: '5',
    BRAIN_MAX_CHARS: '100',
    OPENAI_MODEL: 'm',
    OPENAI_BASE_URL: 'http://x:8089/v1//',
    MAX_HISTORY_MESSAGES: '6',
    MESSAGE_MAX_CHARS: '50',
    INSTRUCTIONS_MAX_CHARS: '20',
  });
  assert.strictEqual(c.port, 8080);
  assert.strictEqual(c.redis.host, 'redis');
  assert.strictEqual(c.redis.port, 6380);
  assert.strictEqual(c.redis.password, 'pw');
  assert.strictEqual(c.openaiApiKey, 'k');
  assert.strictEqual(c.accessToken, 't');
  assert.deepStrictEqual([...c.allowedOrigins], ['http://a.com', 'http://b.com']);
  assert.strictEqual(c.maxConnections, 5);
  assert.strictEqual(c.brainMaxChars, 100);
  assert.strictEqual(c.openaiModel, 'm');
  assert.strictEqual(c.openaiBaseUrl, 'http://x:8089/v1');
  assert.strictEqual(c.maxHistoryMessages, 6);
  assert.strictEqual(c.messageMaxChars, 50);
  assert.strictEqual(c.instructionsMaxChars, 20);
});

test('empty api key is undefined', () => {
  assert.strictEqual(loadConfig({ OPENAI_API_KEY: '  ' }).openaiApiKey, undefined);
});

test('invalid ints throw', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ REDIS_PORT: '-1' }), /REDIS_PORT/);
  assert.throws(() => loadConfig({ MAX_CONNECTIONS: '1.5' }), /MAX_CONNECTIONS/);
});

test('config is frozen', () => {
  const c = loadConfig({});
  assert.ok(Object.isFrozen(c));
});
