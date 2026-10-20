'use strict';

const { errInfo } = require('./logger');

const BASE_INSTRUCTIONS = 'You are a helpful, friendly AI assistant. Answer clearly and concisely.';

// Error with a stable code so callers can map it to a client-facing event.
class ChatError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChatError';
    this.code = code;
  }
}

function buildInstructions(brain, chatInstructions) {
  let out = BASE_INSTRUCTIONS;
  if (typeof brain === 'string' && brain.trim()) {
    out += `\n\nSaved knowledge (use when relevant):\n${brain.trim()}`;
  }
  if (typeof chatInstructions === 'string' && chatInstructions.trim()) {
    out += `\n\nInstructions for this chat:\n${chatInstructions.trim()}`;
  }
  return out;
}

function invalid(message) {
  return { ok: false, code: 'INVALID_MESSAGES', message };
}

function validateMessages(msgs, { maxMessages, maxChars }) {
  if (!Array.isArray(msgs) || msgs.length === 0) return invalid('Messages must be a non-empty list.');
  const clean = [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') return invalid('Each message must be an object.');
    if (m.role !== 'user' && m.role !== 'assistant') return invalid('Message role must be "user" or "assistant".');
    if (typeof m.content !== 'string') return invalid('Message content must be text.');
    if (m.content.length > maxChars) return invalid(`Message is too long (max ${maxChars} characters).`);
    if (m.role === 'user' && !m.content.trim()) return invalid('Message content must not be empty.');
    clean.push({ role: m.role, content: m.content });
  }
  const messages = clean.slice(-maxMessages);
  if (messages[messages.length - 1].role !== 'user') return invalid('The last message must be from the user.');
  return { ok: true, messages };
}

// Parses one SSE event block (lines up to a blank line) into its JSON payload.
function parseEvent(block) {
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  const text = data.join('\n').trim();
  if (!text || text === '[DONE]') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Yields parsed events from a fetch Response body (async iterable of bytes).
async function* readEvents(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      const evt = parseEvent(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
      if (evt) yield evt;
    }
  }
  buf += decoder.decode();
  const last = parseEvent(buf);
  if (last) yield last;
}

function upstreamMessage(evt) {
  const err = evt.error || (evt.response && evt.response.error) || {};
  return `The AI service reported an error${err.message ? `: ${String(err.message).slice(0, 200)}` : '.'}`;
}

function createChatService({ config, fetchImpl = globalThis.fetch, logger }) {
  async function stream({ instructions, messages, signal, onDelta }) {
    if (!config.openaiApiKey) throw new ChatError('NO_API_KEY', 'OPENAI_API_KEY is not configured.');
    try {
      const res = await fetchImpl(`${config.openaiBaseUrl}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openaiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.openaiModel,
          instructions,
          input: messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
        }),
        signal,
      });
      if (!res.ok) {
        let body = '';
        try { body = (await res.text()).slice(0, 500); } catch { /* ignore */ }
        logger.error('upstream error', { status: res.status, body });
        throw new ChatError('UPSTREAM_ERROR', `The AI service returned an error (status ${res.status}).`);
      }
      for await (const evt of readEvents(res.body)) {
        if (evt.type === 'response.output_text.delta') {
          if (typeof evt.delta === 'string' && evt.delta) onDelta(evt.delta);
        } else if (evt.type === 'response.completed') {
          return;
        } else if (evt.type === 'error' || evt.type === 'response.failed') {
          logger.error('upstream stream error', { type: evt.type });
          throw new ChatError('UPSTREAM_ERROR', upstreamMessage(evt));
        }
      }
    } catch (err) {
      if (err instanceof ChatError) throw err;
      if (err && err.name === 'AbortError') throw new ChatError('ABORTED', 'Request was stopped.');
      logger.error('chat stream failed', errInfo(err));
      throw new ChatError('UPSTREAM_ERROR', 'Could not reach the AI service.');
    }
  }

  return { stream };
}

module.exports = { ChatError, buildInstructions, validateMessages, createChatService };
