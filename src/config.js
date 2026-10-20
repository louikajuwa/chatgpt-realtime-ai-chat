'use strict';

function int(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return def;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) throw new Error(`Invalid ${name}: expected a non-negative integer, got "${s}"`);
  return parseInt(s, 10);
}

function str(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return def;
  return String(raw).trim();
}

function loadConfig(env = process.env) {
  const origins = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return Object.freeze({
    port: int(env, 'PORT', 3000),
    redis: Object.freeze({
      host: str(env, 'REDIS_HOST', '127.0.0.1'),
      port: int(env, 'REDIS_PORT', 6379),
      password: str(env, 'REDIS_PASSWORD', undefined),
    }),
    openaiApiKey: str(env, 'OPENAI_API_KEY', undefined),
    openaiModel: str(env, 'OPENAI_MODEL', 'gpt-5-mini'),
    openaiBaseUrl: str(env, 'OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
    accessToken: str(env, 'APP_ACCESS_TOKEN', undefined),
    allowedOrigins: Object.freeze(origins),
    maxConnections: int(env, 'MAX_CONNECTIONS', 20),
    brainMaxChars: int(env, 'BRAIN_MAX_CHARS', 20000),
    maxHistoryMessages: int(env, 'MAX_HISTORY_MESSAGES', 40),
    messageMaxChars: int(env, 'MESSAGE_MAX_CHARS', 8000),
    instructionsMaxChars: int(env, 'INSTRUCTIONS_MAX_CHARS', 4000),
  });
}

module.exports = { loadConfig };
