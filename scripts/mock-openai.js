'use strict';

// Minimal mock of the OpenAI Responses API (POST /v1/responses, streaming).
// Echoes the last user message back as word-sized SSE deltas.
// Usage: OPENAI_BASE_URL=http://host:8089/v1

const http = require('http');

function lastUserText(input) {
  if (!Array.isArray(input)) return '';
  for (let i = input.length - 1; i >= 0; i--) {
    if (input[i] && input[i].role === 'user' && typeof input[i].content === 'string') return input[i].content;
  }
  return '';
}

function sse(res, evt) {
  res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
}

function handleResponses(req, res) {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'invalid JSON' } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const words = `Echo: ${lastUserText(body.input)}`.split(/(?<=\s)/);
    let i = 0;
    const timer = setInterval(() => {
      if (i < words.length) {
        sse(res, { type: 'response.output_text.delta', delta: words[i++] });
        return;
      }
      clearInterval(timer);
      sse(res, { type: 'response.completed', response: { status: 'completed' } });
      res.end();
    }, 80);
    res.on('close', () => clearInterval(timer));
  });
}

function startMockOpenAI({ port = 8089 } = {}) {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/responses') return handleResponses(req, res);
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(port, () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}/v1`,
      close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }),
    }));
  });
}

module.exports = { startMockOpenAI };

if (require.main === module) {
  startMockOpenAI({ port: Number(process.env.MOCK_PORT) || 8089 }).then((m) => {
    console.log(`mock OpenAI listening at ${m.url}`);
  });
}
