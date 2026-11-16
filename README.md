# AI Chat

A text chat app on the OpenAI Responses API with streamed replies. A "brain" stored in Redis (key `vbrain:content`) is added to the model instructions for every chat, and each chat can carry its own extra instructions.

```
Browser  <--Socket.IO-->  Node server (Express)  <--HTTPS SSE-->  OpenAI /v1/responses
                               |
                             Redis (brain)
```

## Features

- Streaming replies (`chat:delta`), with stop/cancel of the reply in progress.
- Conversation history is held by the browser and sent with each request (server keeps the last `MAX_HISTORY_MESSAGES`).
- Persistent brain (shared knowledge) in Redis, used on every request.
- Per-chat instructions.
- Optional access token, same-origin check, per-socket rate limits, strict CSP.

## Prerequisites

- Docker with Compose v2
- Host ports `3005` and `6381` free (bound to 127.0.0.1 only)
- An OpenAI API key

## Quick start

```bash
cp .env.example .env      # then edit .env and set OPENAI_API_KEY
docker compose up -d --build -V
```

Open http://localhost:3005. `-V` renews the anonymous `node_modules` volume; without it, stale modules persist after dependency changes. The project directory is bind-mounted and `nodemon --legacy-watch` hot-reloads code edits.

## Configuration (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `OPENAI_API_KEY` | none | Required for live responses. Never commit it. |
| `OPENAI_MODEL` | `gpt-5-mini` | Model used with the Responses API. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Override for mock testing. Trailing slash is stripped. |
| `REDIS_HOST` / `REDIS_PORT` | `redis` / `6379` | Compose forces these for the app. |
| `REDIS_PASSWORD` | empty | Optional; Redis then starts with `--requirepass`. |
| `PORT` | `3000` | In-container port (host `3005`). |
| `APP_ACCESS_TOKEN` | empty | When set, the browser must enter it. |
| `ALLOWED_ORIGINS` | empty | Comma list; empty means same-origin only. |
| `MAX_CONNECTIONS` | `20` | |
| `BRAIN_MAX_CHARS` | `20000` | |
| `MAX_HISTORY_MESSAGES` | `40` | Most recent messages sent to the model. |
| `MESSAGE_MAX_CHARS` | `8000` | Per message. |
| `INSTRUCTIONS_MAX_CHARS` | `4000` | Per-chat instructions. |

See `.env.example` for comments.

## Socket.IO events

Client to server (all take an ack callback):

| Event | Payload | Ack |
|---|---|---|
| `chat:send` | `{ messages: [{role, content}], instructions? }` | `{ ok: true, id }` or `{ ok: false, error: { code, message } }` |
| `chat:stop` | none | `{ ok: true }` |
| `brain:save` | `{ value }` | `{ ok: true, savedAt }` or error |
| `brain:load` | none | `{ ok: true, value }` or error |

`messages` roles are `user` or `assistant`; the last one must be a `user` message. Sending a new `chat:send` aborts the previous reply of that socket.

Server to client:

| Event | Payload |
|---|---|
| `chat:delta` | `{ id, text }` (a piece of the reply) |
| `chat:done` | `{ id }`, or `{ id, stopped: true }` when stopped |
| `chat:error` | `{ id, code, message }` (e.g. `NO_API_KEY`, `UPSTREAM_ERROR`) |
| `app:error` | `{ code: 'RATE_LIMITED', message }` for rate-limited events sent without an ack |

Ack error codes: `INVALID_MESSAGES`, `INVALID_INSTRUCTIONS`, `INVALID_BRAIN`, `BRAIN_TOO_LONG`, `STORAGE_ERROR`, `RATE_LIMITED`, `INTERNAL`.

HTTP: `GET /healthz`, `GET /api/config` (`authRequired`, `brainMaxChars`, `instructionsMaxChars`, `messageMaxChars`).

## How to extend

- Model call: `src/chatService.js` (`createChatService().stream`). To change the request (tools, temperature, another provider), edit the JSON body and the SSE event handling there.
- System prompt: `buildInstructions` in the same file.
- Socket handlers: `src/app.js`; add a new event with `handle(name, limiter, fn)`.
- Limits and env vars: `src/config.js`, then `.env.example` and this table.
- Tests inject a fake `chatService` into `createServer`, so no network is needed.

## Security notes

- Ports are published on `127.0.0.1` only. Set `APP_ACCESS_TOKEN` (and ideally `REDIS_PASSWORD`) before exposing the app through a proxy or other interface, and add the public origin to `ALLOWED_ORIGINS`.
- Never commit `.env` (it is git- and docker-ignored).
- Containers run with `no-new-privileges`; the app runs as the unprivileged `node` user.

## Tests

```bash
docker compose run --rm --build app npm test
```

## Mock mode

Run the mock OpenAI server (`scripts/mock-openai.js`, port `MOCK_PORT` or `8089`) with `npm run mock:openai`, then set `OPENAI_BASE_URL=http://<host>:8089/v1` in `.env` (from inside a container, use a host reachable from it, e.g. `host.docker.internal`). It replies "Echo: <your last message>".

## Production image

```bash
docker build --target prod -t ai-chat:prod .
docker run -d --name ai-chat --env-file .env -e REDIS_HOST=redis \
  --network <network-with-redis> -p 127.0.0.1:3005:3000 ai-chat:prod
```

The prod image has production dependencies only, runs `node server.js`, and has a built-in HEALTHCHECK.

## Health check

`GET /healthz` returns 200 when healthy, 503 if Redis is down.

```bash
curl -i http://localhost:3005/healthz
docker compose ps
```

## Backup / restore the brain

```bash
# text backup
docker compose exec redis redis-cli GET vbrain:content > brain-backup.txt

# full snapshot
docker compose exec redis redis-cli BGSAVE        # wait a moment (add -a "$REDIS_PASSWORD" if set)
docker compose cp redis:/data/dump.rdb ./dump.rdb
```

To restore a snapshot: stop Redis, copy `dump.rdb` into the `ai_chat_redis` volume at `/data/dump.rdb`, start Redis. Data lives in the named volume `ai_chat_redis`; `docker compose down -v` deletes it.

## Troubleshooting

- "NO_API_KEY" error: `OPENAI_API_KEY` is missing in `.env`; recreate with `docker compose up -d`.
- `UPSTREAM_ERROR` with a status: check the key, model name (`OPENAI_MODEL`) and base URL; the server log has the upstream response body.
- Module not found / stale dependencies: `docker compose up -d --build -V`.

## License

MIT — see [LICENSE](LICENSE).
