'use strict';

const express = require('express');
const { spawn, execSync } = require('child_process');

const app = express();

// Kill a process and all its descendants to prevent MCP/plugin orphans
function killTree(pid) {
  try {
    // Find all descendant PIDs via pgrep
    const children = execSync(`pgrep -P ${pid} 2>/dev/null`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const cpid of children) killTree(parseInt(cpid, 10));
    process.kill(pid, 'SIGTERM');
  } catch (_) { /* already dead */ }
}
app.use(express.json({ limit: '50mb' }));

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT       = parseInt(process.env.PORT || '11436', 10);
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// ─── Stats ───────────────────────────────────────────────────────────────────

const proxyStats = { requests: 0, errors: 0, totalInputTokens: 0, totalOutputTokens: 0 };

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(level, msg) {
  console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`);
}

// ─── Core proxy function ──────────────────────────────────────────────────────
// Shells out to `claude -p` which routes through Claude Code's own auth.

function buildPrompt(messages) {
  // messages is an array of {role, content} objects (system messages already extracted)
  const parts = [];

  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'Assistant' : 'User';
    const content = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
        : String(msg.content ?? '');
    parts.push(`[${role}: ${content}]`);
  }

  return parts.join('\n\n');
}

function runClaude(prompt, modelAlias, systemPrompt) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'json', '--model', modelAlias, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }
    log('info', `Spawning: ${CLAUDE_BIN} -p <prompt> --output-format json --model ${modelAlias}${systemPrompt ? ' --system-prompt <sys>' : ''}`);

    // Run from /tmp to avoid loading any project CLAUDE.md
    const child = spawn(CLAUDE_BIN, args, { timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], detached: false, cwd: '/tmp' });
    const pid = child.pid;
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => {
      proxyStats.errors++;
      log('warn', `claude spawn error: ${err.message}`);
      killTree(pid);
      resolve({ error: err.message });
    });

    child.on('close', (code) => {
      // Kill any orphaned child processes (MCP servers, plugins)
      killTree(pid);
      if (code !== 0) {
        proxyStats.errors++;
        log('warn', `claude exited with code ${code}`);
        if (stderr) log('warn', `claude stderr: ${stderr.slice(0, 500)}`);
        resolve({ error: `claude exited with code ${code}: ${stderr.slice(0, 200)}` });
        return;
      }

      try {
        const data = JSON.parse(stdout.trim());
        if (data.is_error || data.subtype === 'error') {
          proxyStats.errors++;
          const errMsg = data.result || data.error || 'claude returned an error';
          log('warn', `claude error result: ${errMsg}`);
          resolve({ error: errMsg });
          return;
        }

        // Strip markdown JSON fences if present
        let text = data.result || '';
        text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

        const usage = data.usage || {};
        proxyStats.totalInputTokens  += usage.input_tokens  || 0;
        proxyStats.totalOutputTokens += usage.output_tokens || 0;

        resolve({ text, usage });
      } catch (parseErr) {
        proxyStats.errors++;
        log('warn', `Failed to parse claude output: ${parseErr.message}`);
        log('warn', `Raw stdout: ${stdout.slice(0, 500)}`);
        resolve({ error: `Failed to parse claude output: ${parseErr.message}` });
      }
    });
  });
}

// ─── Claude proxy routes ──────────────────────────────────────────────────────
// Four prefixes, each routing to a different Claude model.
// Clients point at this service instead of a real Ollama instance.

for (const [prefix, modelAlias, modelLabel] of [
  ['/api',        'sonnet', 'claude-sonnet'],
  ['/sonnet/api', 'sonnet', 'claude-sonnet'],
  ['/opus/api',   'opus',   'claude-opus'],
  ['/haiku/api',  'haiku',  'claude-haiku'],
]) {
  // POST {prefix}/generate — completion-style proxy
  app.post(`${prefix}/generate`, async (req, res) => {
    res.set('X-Proxy-Backend', 'claude-cli');
    const start = Date.now();
    proxyStats.requests++;
    const { prompt, system, options = {}, format, images } = req.body || {};

    let systemText = system || '';
    if (format === 'json') {
      systemText = (systemText + '\nRespond only with valid JSON, no markdown.').trim();
    }

    log('info', `generate: model=${modelAlias}, tokens=${options.num_predict || 1024}`);

    // Build a single user message; images not supported via claude -p text prompt
    const userContent = prompt || '';
    if (images && images.length > 0) {
      log('warn', 'generate: images not supported with claude -p, ignoring');
    }

    const fullPrompt = buildPrompt([{ role: 'user', content: userContent }]);

    try {
      const result = await runClaude(fullPrompt, modelAlias, systemText || undefined);

      const elapsed = Date.now() - start;
      if (result.error) {
        log('warn', `generate error (${elapsed}ms): ${result.error}`);
        return res.status(502).json({ error: result.error, done: true });
      }

      log('info', `generate done (${elapsed}ms): in=${result.usage?.input_tokens} out=${result.usage?.output_tokens}`);
      res.json({
        model: modelLabel,
        response: result.text,
        done: true,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      proxyStats.errors++;
      res.status(500).json({ error: err.message, done: true });
    }
  });

  // POST {prefix}/chat — chat-style proxy
  app.post(`${prefix}/chat`, async (req, res) => {
    res.set('X-Proxy-Backend', 'claude-cli');
    const start = Date.now();
    proxyStats.requests++;
    const { messages = [], options = {}, format } = req.body || {};

    const systemMessages    = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    let systemText = systemMessages.map((m) => m.content).join('\n').trim();
    if (format === 'json') {
      systemText = (systemText + '\nRespond only with valid JSON, no markdown.').trim();
    }

    log('info', `chat: model=${modelAlias}, messages=${nonSystemMessages.length}`);

    const fullPrompt = buildPrompt(nonSystemMessages);

    try {
      const result = await runClaude(fullPrompt, modelAlias, systemText || undefined);

      const elapsed = Date.now() - start;
      if (result.error) {
        log('warn', `chat error (${elapsed}ms): ${result.error}`);
        return res.status(502).json({ error: result.error, done: true });
      }

      log('info', `chat done (${elapsed}ms): in=${result.usage?.input_tokens} out=${result.usage?.output_tokens}`);
      res.json({
        model: modelLabel,
        message: { role: 'assistant', content: result.text },
        done: true,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      proxyStats.errors++;
      res.status(500).json({ error: err.message, done: true });
    }
  });

  // GET {prefix}/tags — model list (so clients can discover available models)
  app.get(`${prefix}/tags`, (req, res) => {
    res.json({
      models: [
        {
          name: modelLabel,
          model: modelLabel,
          modified_at: new Date().toISOString(),
          size: 0,
        },
      ],
    });
  });

  // GET {prefix}/version — Ollama version (for clients that check connectivity)
  app.get(`${prefix}/version`, (req, res) => {
    res.json({ version: '0.6.2' });
  });

  // POST {prefix}/show — model info (Frigate OllamaClient._init_provider calls this to verify model exists)
  app.post(`${prefix}/show`, (req, res) => {
    res.json({
      license: '',
      modelfile: `FROM ${modelLabel}`,
      parameters: '',
      template: '{{ .Prompt }}',
      details: {
        parent_model: '',
        format: 'gguf',
        family: 'claude',
        families: ['claude'],
        parameter_size: 'unknown',
        quantization_level: 'unknown',
      },
      model_info: {},
      modified_at: new Date().toISOString(),
    });
  });

  // HEAD/GET catch-all for this prefix — return 200 so init checks don't fail
  app.get(`${prefix}`, (req, res) => {
    res.json({ status: 'ok' });
  });
}

// ─── Ollama passthrough routes ────────────────────────────────────────────────
// Routes /cogito/api and /gpt-oss/api straight through to the real local Ollama.

const OLLAMA_PASSTHROUGH_MODELS = {
  cogito:    'cogito:8b',
  'gpt-oss': 'gpt-oss:20b',
};

for (const [slug, ollamaModel] of Object.entries(OLLAMA_PASSTHROUGH_MODELS)) {
  const prefix = `/${slug}/api`;

  // POST {prefix}/generate — passthrough to real Ollama
  app.post(`${prefix}/generate`, async (req, res) => {
    res.set('X-Proxy-Backend', 'local-ollama');
    proxyStats.requests++;
    const body = { ...req.body, model: ollamaModel, stream: false };
    log('info', `Ollama passthrough generate: model=${ollamaModel}`);

    try {
      const response = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });

      if (!response.ok) {
        proxyStats.errors++;
        const text = await response.text();
        return res.status(response.status).json({ error: text, done: true });
      }

      const data = await response.json();
      res.json(data);
    } catch (err) {
      proxyStats.errors++;
      res.status(502).json({ error: err.message, done: true });
    }
  });

  // POST {prefix}/chat — passthrough to real Ollama
  app.post(`${prefix}/chat`, async (req, res) => {
    res.set('X-Proxy-Backend', 'local-ollama');
    proxyStats.requests++;
    const body = { ...req.body, model: ollamaModel, stream: false };
    log('info', `Ollama passthrough chat: model=${ollamaModel}`);

    try {
      const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });

      if (!response.ok) {
        proxyStats.errors++;
        const text = await response.text();
        return res.status(response.status).json({ error: text, done: true });
      }

      const data = await response.json();
      res.json(data);
    } catch (err) {
      proxyStats.errors++;
      res.status(502).json({ error: err.message, done: true });
    }
  });

  // GET {prefix}/tags — report the local model
  app.get(`${prefix}/tags`, (req, res) => {
    res.json({
      models: [{ name: ollamaModel, model: ollamaModel, modified_at: new Date().toISOString(), size: 0 }],
    });
  });
}

// ─── Health / Stats ───────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    stats: proxyStats,
    claudeBin: CLAUDE_BIN,
    ollamaUrl: OLLAMA_URL,
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  log('info', `Claude-Ollama proxy listening on port ${PORT}`);
  log('info', `Claude binary: ${CLAUDE_BIN}`);
  log('info', `Ollama passthrough URL: ${OLLAMA_URL}`);
});
