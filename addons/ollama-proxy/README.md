# Claude Ollama Proxy

An Ollama-compatible API proxy that routes requests to Claude models via the `claude -p` CLI. Any Ollama client can talk to Claude without modification.

## Why

The supervisor's AI evaluator uses Ollama as the primary backend (local LLM, independent trust boundary, zero API cost). When the local model fails, the proxy provides a fast fallback using Claude Haiku — still through the official CLI, still using your existing Claude authentication.

Without this proxy, a failed Ollama evaluation falls through to auto-approve with low confidence (0.5), which can let unsafe commands through. With it, you get a reliable second opinion from a different model.

## How it works

The proxy listens on port 11436 (configurable) and translates Ollama API calls (`/api/generate`, `/api/chat`) into `claude -p` CLI invocations. Route prefixes select the model:

| Route | Model |
|-------|-------|
| `/api/*` | claude-sonnet (default) |
| `/haiku/api/*` | claude-haiku |
| `/sonnet/api/*` | claude-sonnet |
| `/opus/api/*` | claude-opus |
| `/cogito/api/*` | cogito:8b (Ollama passthrough) |
| `/gpt-oss/api/*` | gpt-oss:20b (Ollama passthrough) |

The supervisor calls `/haiku/api/chat` for fast, cheap evaluations as a fallback.

Each prefix exposes: `POST /generate`, `POST /chat`, `GET /tags`, `GET /version`, `POST /show`.

## Quick Start

```bash
cd addons/ollama-proxy
npm install
node server.js
```

The proxy starts on port 11436. The supervisor automatically uses it as a fallback when configured with `SUPERVISOR_OLLAMA_URL` pointing to a local Ollama instance.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `11436` | Listen port |
| `CLAUDE_BIN` | `claude` | Path to claude CLI (or full path if not on PATH) |
| `OLLAMA_URL` | `http://localhost:11434` | Real Ollama for passthrough routes |

## Running as a Service

```bash
# systemd user service (recommended)
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/claude-ollama-proxy.service << 'EOF'
[Unit]
Description=Claude Ollama Proxy
After=network.target

[Service]
WorkingDirectory=/path/to/claude-supervisor/addons/ollama-proxy
ExecStart=/usr/bin/node server.js
Environment=PORT=11436
Restart=on-failure

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now claude-ollama-proxy
```

## Health Check

```
GET /health
```

Returns uptime, per-model stats, and current config.

## Compliance

This proxy uses only the official `claude -p` pipe mode CLI interface. It runs locally on your machine using your own Claude authentication. It does not extract tokens, share credentials, or expose Claude to the public internet. Review Anthropic's terms at https://www.anthropic.com/legal before deploying.
