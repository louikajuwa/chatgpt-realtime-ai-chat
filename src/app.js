'use strict';

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const { ChatError, buildInstructions, validateMessages } = require('./chatService');
const { ValidationError } = require('./brainStore');
const { createRateLimiter } = require('./rateLimiter');
const { errInfo } = require('./logger');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function digest(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

function tokenMatches(expected, given) {
  if (typeof given !== 'string') return false;
  return crypto.timingSafeEqual(digest(expected), digest(given));
}

function hostOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

function createServer({ config, store, chatService, logger }) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'microphone=(), camera=(), geolocation=()');
    next();
  });

  app.get('/healthz', async (req, res) => {
    let ok = false;
    try {
      ok = !!(await store.ping());
    } catch {
      ok = false;
    }
    res.status(ok ? 200 : 503).json(ok ? { status: 'ok', redis: true } : { status: 'degraded', redis: false });
  });

  app.get('/api/config', (req, res) => {
    res.json({
      authRequired: !!config.accessToken,
      brainMaxChars: config.brainMaxChars,
      instructionsMaxChars: config.instructionsMaxChars,
      messageMaxChars: config.messageMaxChars,
    });
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  const httpServer = http.createServer(app);
  const allowed = config.allowedOrigins || [];

  const ioOptions = {
    maxHttpBufferSize: 1024 * 1024,
    allowRequest: (req, cb) => {
      const origin = req.headers.origin;
      if (!origin) return cb(null, true);
      if (allowed.includes(origin)) return cb(null, true);
      const h = hostOf(origin);
      return cb(null, !!h && h === req.headers.host);
    },
  };
  if (allowed.length) ioOptions.cors = { origin: [...allowed] };
  const io = new Server(httpServer, ioOptions);

  io.use((socket, next) => {
    if (config.accessToken && !tokenMatches(config.accessToken, socket.handshake.auth && socket.handshake.auth.token)) {
      return next(new Error('unauthorized'));
    }
    if (io.engine.clientsCount > config.maxConnections) return next(new Error('server_busy'));
    next();
  });

  // Abort controllers of all in-flight streams, so close() can cancel them.
  const controllers = new Set();

  io.on('connection', (socket) => {
    const chatLimiter = createRateLimiter({ capacity: 5, refillPerSec: 0.5 });
    const controlLimiter = createRateLimiter({ capacity: 10, refillPerSec: 2 });
    let lastRateEmit = 0;
    let active = null; // { id, controller } for the stream in flight

    function abortActive() {
      if (active) active.controller.abort();
    }

    function rateLimited(limiter, ack) {
      if (limiter.take()) return false;
      const msg = 'Too many requests. Please slow down.';
      if (typeof ack === 'function') {
        ack(fail('RATE_LIMITED', msg));
      } else {
        const t = Date.now();
        if (t - lastRateEmit >= 1000) {
          lastRateEmit = t;
          socket.emit('app:error', { code: 'RATE_LIMITED', message: msg });
        }
      }
      return true;
    }

    // Wraps a handler: ack-safe, never throws.
    function handle(name, limiter, fn) {
      socket.on(name, async (...args) => {
        const ack = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
        const reply = (v) => { if (ack) { try { ack(v); } catch { /* ignore */ } } };
        try {
          if (limiter && rateLimited(limiter, ack)) return;
          await fn(args[0] === ack ? undefined : args[0], reply);
        } catch (err) {
          logger.error(`handler ${name} failed`, errInfo(err));
          reply(fail('INTERNAL', 'Something went wrong.'));
        }
      });
    }

    async function loadBrain() {
      try {
        return await store.get();
      } catch (err) {
        logger.warn('brain load failed', errInfo(err));
        return '';
      }
    }

    async function runChat(id, controller, instructionsText, messages) {
      try {
        const brain = await loadBrain();
        await chatService.stream({
          instructions: buildInstructions(brain, instructionsText),
          messages,
          signal: controller.signal,
          onDelta: (text) => socket.emit('chat:delta', { id, text }),
        });
        socket.emit('chat:done', { id });
      } catch (err) {
        if (err instanceof ChatError && err.code === 'ABORTED') {
          socket.emit('chat:done', { id, stopped: true });
        } else {
          if (!(err instanceof ChatError)) logger.error('chat failed', errInfo(err));
          socket.emit('chat:error', {
            id,
            code: err instanceof ChatError ? err.code : 'INTERNAL',
            message: err instanceof ChatError ? err.message : 'Something went wrong.',
          });
        }
      } finally {
        controllers.delete(controller);
        if (active && active.id === id) active = null;
      }
    }

    handle('chat:send', chatLimiter, (payload, reply) => {
      const p = payload && typeof payload === 'object' ? payload : {};
      const ins = p.instructions;
      if (ins !== undefined && (typeof ins !== 'string' || ins.length > config.instructionsMaxChars)) {
        return reply(fail('INVALID_INSTRUCTIONS', `Instructions must be text (max ${config.instructionsMaxChars} characters).`));
      }
      const v = validateMessages(p.messages, {
        maxMessages: config.maxHistoryMessages,
        maxChars: config.messageMaxChars,
      });
      if (!v.ok) return reply(fail(v.code, v.message));

      abortActive();
      const id = crypto.randomUUID();
      const controller = new AbortController();
      active = { id, controller };
      controllers.add(controller);
      reply({ ok: true, id });
      // Not awaited: the ack above has already gone out; events follow.
      runChat(id, controller, ins, v.messages);
    });

    handle('chat:stop', controlLimiter, (_p, reply) => {
      abortActive();
      reply({ ok: true });
    });

    handle('brain:save', controlLimiter, async (payload, reply) => {
      if (!payload || typeof payload !== 'object' || typeof payload.value !== 'string') {
        return reply(fail('INVALID_BRAIN', 'Brain content must be text.'));
      }
      let saved;
      try {
        saved = await store.set(payload.value);
      } catch (err) {
        if (err instanceof ValidationError) return reply(fail(err.code, err.message));
        logger.error('brain save failed', errInfo(err));
        return reply(fail('STORAGE_ERROR', 'Could not save. Please try again.'));
      }
      reply({ ok: true, savedAt: saved.savedAt });
    });

    handle('brain:load', controlLimiter, async (_p, reply) => {
      try {
        reply({ ok: true, value: await store.get() });
      } catch (err) {
        logger.error('brain load failed', errInfo(err));
        reply(fail('STORAGE_ERROR', 'Could not load. Please try again.'));
      }
    });

    socket.on('disconnect', abortActive);
  });

  async function close() {
    for (const c of controllers) c.abort();
    io.disconnectSockets(true);
    await new Promise((resolve) => io.close(() => resolve()));
  }

  return { app, httpServer, io, close };
}

module.exports = { createServer };
