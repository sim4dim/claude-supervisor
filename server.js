/**
 * Claude Code Remote Supervisor Server
 *
 * Receives requests from Claude Code hooks (PreToolUse, PermissionRequest, etc.)
 * and serves a mobile-friendly web UI for remote monitoring and override.
 *
 * Features an AI supervisor agent that autonomously evaluates tool call safety
 * using a second Claude Code CLI instance (claude -p). High-confidence decisions
 * are auto-resolved; low-confidence ones are escalated to the human dashboard.
 *
 * Modes:
 *   - auto:     AI decides autonomously, human can override (default)
 *   - assisted: AI recommends, human must confirm
 *   - manual:   No AI, human approves everything (original behavior)
 */

import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { spawn, execFileSync, execFile } from "child_process";
import { createInterface } from "readline";
import { randomUUID, createHmac, randomBytes } from "crypto";
import { readFile, readdir, stat, open as fsOpen, writeFile, mkdir } from "fs/promises";
import { openSync, statSync, existsSync, readdirSync, readlinkSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, symlinkSync } from "fs";
import { resolve, dirname, basename, join } from "path";
import { fileURLToPath } from "url";
import os from "os";
import pty from "node-pty";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR_VERSION = (() => {
  // 1. git describe (always fresh, works in any clone with tags)
  try { return execFileSync("git", ["describe", "--tags", "--always"], { cwd: __dirname, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
  // 2. VERSION file fallback (for environments without git)
  try { const v = readFileSync(resolve(__dirname, "VERSION"), "utf-8").trim(); if (v) return v; } catch {}
  // 3. package.json fallback
  return JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8")).version;
})();
// Capture git commit at startup so we can diff against HEAD later
const STARTUP_COMMIT = (() => {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: __dirname, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; }
})();
const PORT = process.env.SUPERVISOR_PORT || 3847;
const devNull = openSync("/dev/null", "r");

// ─── Authentication ───────────────────────────────────────────────────────────

const SUPERVISOR_PASSWORD = process.env.SUPERVISOR_PASSWORD || "";
const AUTH_ENABLED = !!SUPERVISOR_PASSWORD;
const SESSION_SECRET = randomBytes(32).toString("hex");
const HOOK_TOKEN = process.env.SUPERVISOR_HOOK_TOKEN || randomBytes(24).toString("hex");

// Write hook token to file so hooks can read it
if (AUTH_ENABLED) {
  const tokenPath = join(os.homedir(), ".claude", ".supervisor-hook-token");
  try {
    writeFileSync(tokenPath, HOOK_TOKEN, { mode: 0o600 });
  } catch (e) {
    console.error(`[auth] Warning: could not write hook token to ${tokenPath}: ${e.message}`);
  }
}

// Cookie helpers
function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifySession(cookie) {
  if (!cookie) return false;
  const dot = cookie.lastIndexOf(".");
  if (dot === -1) return false;
  const data = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");
  if (sig !== expected) return false;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString());
    return payload.authenticated === true;
  } catch {
    return false;
  }
}

function parseCookieHeader(header) {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map(p => {
      const eq = p.indexOf("=");
      if (eq === -1) return [p.trim(), ""];
      return [p.slice(0, eq).trim(), p.slice(eq + 1).trim()];
    })
  );
}

// Login page HTML
const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Supervisor — Login</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 2.5rem; width: 100%; max-width: 380px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
  h1 { font-size: 1.4rem; font-weight: 600; color: #58a6ff; margin-bottom: 0.4rem; }
  .subtitle { font-size: 0.85rem; color: #8b949e; margin-bottom: 2rem; }
  label { display: block; font-size: 0.85rem; color: #8b949e; margin-bottom: 0.4rem; }
  input[type=password] { width: 100%; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #e6edf3; font-size: 1rem; padding: 0.6rem 0.8rem; outline: none; transition: border-color 0.2s; }
  input[type=password]:focus { border-color: #58a6ff; }
  button { width: 100%; margin-top: 1.2rem; background: #238636; border: none; border-radius: 6px; color: #fff; font-size: 1rem; font-weight: 600; padding: 0.7rem; cursor: pointer; transition: background 0.2s; }
  button:hover { background: #2ea043; }
  .error { background: #3d1f1f; border: 1px solid #6e3535; border-radius: 6px; color: #f85149; font-size: 0.85rem; padding: 0.6rem 0.8rem; margin-bottom: 1rem; }
</style>
</head>
<body>
<div class="card">
  <h1>Claude Supervisor</h1>
  <p class="subtitle">Enter your password to access the dashboard</p>
  {{ERROR}}
  <form method="POST" action="/login">
    <label for="password">Password</label>
    <input type="password" id="password" name="password" autofocus autocomplete="current-password" placeholder="••••••••">
    <button type="submit">Sign in</button>
  </form>
</div>
</body>
</html>`;

// ─── Supervisor AI Configuration ────────────────────────────────────────────

const SUPERVISOR_MODE = process.env.SUPERVISOR_MODE || "auto";
const SUPERVISOR_FAST_MODEL = process.env.SUPERVISOR_FAST_MODEL || "claude-haiku-4-5-20251001";
const SUPERVISOR_MODEL = process.env.SUPERVISOR_MODEL || "claude-sonnet-4-20250514";
const EVAL_ESCALATION_THRESHOLD = parseInt(process.env.SUPERVISOR_EVAL_ESCALATION_THRESHOLD || "70");
const SUPERVISOR_CONFIDENCE_THRESHOLD = parseFloat(
  process.env.SUPERVISOR_CONFIDENCE_THRESHOLD || "0.8"
);
const SUPERVISOR_EVAL_TIMEOUT = parseInt(
  process.env.SUPERVISOR_EVAL_TIMEOUT || "60000"
);
const SUPERVISOR_MAX_CONCURRENT = parseInt(
  process.env.SUPERVISOR_MAX_CONCURRENT || "3"
);
const SUPERVISOR_POLICY_PATH =
  process.env.SUPERVISOR_POLICY_PATH || resolve(__dirname, "supervisor-policy.md");
const EVAL_BACKEND = process.env.SUPERVISOR_EVAL_BACKEND || 'ollama';  // 'ollama' or 'claude'
const OLLAMA_URL = process.env.SUPERVISOR_OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.SUPERVISOR_OLLAMA_MODEL || 'mistral-nemo';
const OLLAMA_TRUSTED_MODELS = (process.env.SUPERVISOR_OLLAMA_TRUSTED_MODELS || 'gpt-oss:20b,mistral-nemo:latest,mistral-nemo,gemma3:27b,phi4,phi4-mini,magistral,cogito:70b,llama3.3:70b,mistral-small3.1').split(',').map(s => s.trim());

// ─── Peer Supervisors (for cross-instance doc sharing) ──────────────────────
// Format: "name=url,name=url" e.g. "alice=http://192.168.x.x:3847,bob=http://192.168.x.x:3848"
const SUPERVISOR_PEERS = (process.env.SUPERVISOR_PEERS || "").split(",").filter(Boolean).reduce((m, entry) => {
  const [name, url] = entry.split("=");
  if (name && url) m.set(name.trim(), url.trim());
  return m;
}, new Map());

// ─── MQTT Configuration ──────────────────────────────────────────────────────

const MQTT_HOST = process.env.SUPERVISOR_MQTT_HOST || "localhost";
const MQTT_BACKUP_HOST = process.env.SUPERVISOR_MQTT_BACKUP_HOST || "";
const MQTT_BACKUP_USER = process.env.SUPERVISOR_MQTT_BACKUP_USER || "";
const MQTT_BACKUP_PASS = process.env.SUPERVISOR_MQTT_BACKUP_PASS || "";

function mqttPublish(args, callback) {
  execFile("mosquitto_pub", ["-h", MQTT_HOST, ...args], (err) => {
    if (!err) {
      // Primary succeeded — replicate to backup (fire and forget)
      if (MQTT_BACKUP_HOST) {
        const backupArgs = ["-h", MQTT_BACKUP_HOST];
        if (MQTT_BACKUP_USER) backupArgs.push("-u", MQTT_BACKUP_USER);
        if (MQTT_BACKUP_PASS) backupArgs.push("-P", MQTT_BACKUP_PASS);
        execFile("mosquitto_pub", [...backupArgs, ...args], () => {});
      }
      if (callback) callback(null);
    } else if (MQTT_BACKUP_HOST) {
      // Primary failed — try backup only
      const backupArgs = ["-h", MQTT_BACKUP_HOST];
      if (MQTT_BACKUP_USER) backupArgs.push("-u", MQTT_BACKUP_USER);
      if (MQTT_BACKUP_PASS) backupArgs.push("-P", MQTT_BACKUP_PASS);
      execFile("mosquitto_pub", [...backupArgs, ...args], callback || (() => {}));
    } else {
      if (callback) callback(err);
    }
  });
}

// ─── State ───────────────────────────────────────────────────────────────────

let approvalIdCounter = 0;
const pendingApprovals = new Map();
let questionIdCounter = 0;
const pendingQuestions = new Map();
const logs = [];
const MAX_LOGS = 500;
const agentMessages = [];         // Bounded buffer of recent MQTT agent messages
const MAX_AGENT_MESSAGES = 200;
const teamChatMessages = new Map(); // Cross-instance human chat: project -> messages[]

// ─── Coordinator / broker ────────────────────────────────────────────────────
const COORDINATOR_ENABLED = process.env.SUPERVISOR_COORDINATOR !== "false";
const SV_INSTANCE = process.env.SV_INSTANCE || os.hostname().split(".")[0];
const coordinatorRequests = new Map(); // id -> { request, status, dispatchedTo, response, createdAt, updatedAt, timeoutTimer }
const MAX_COORDINATOR_HISTORY = 100;
const coordinatorHistory = []; // completed/timed-out requests moved here

// Strip non-serializable fields (e.g. Timeout handles) before sending coordinator entries over JSON/WS
function serializeCoordinatorEntry(id, entry) {
  const { timeoutTimer, ...rest } = entry; // eslint-disable-line no-unused-vars
  return { id, ...rest };
}

const sessions = new Map();
const wsClients = new Set();

// ─── Delegation Enforcement ──────────────────────────────────────────────────
const delegationTrackers = new Map(); // session_id -> tracker (kept for logging/hints)
const DELEGATION_ENFORCEMENT = process.env.SUPERVISOR_DELEGATION_ENFORCEMENT !== "false";
// Enforcement is now context-percentage-based, not turn-count-based:
//   < 50%  → no enforcement
//   50-70% → warn (hint in eval prompt, never deny)
//   > 70%  → strict enforcement (deny implementation calls from main agent)

// AI evaluation queue state
let activeEvaluations = 0;
const evaluationQueue = [];

const serverStartedAt = Date.now();
let evalStats = { totalRequests: 0, aiEvals: 0, aiApproved: 0, aiDenied: 0, humanDecisions: 0 };

// ─── Eval Pattern Analysis ────────────────────────────────────────────────────
const evalPatternSuggestions = [];   // ephemeral, in-memory only, max 10
const MAX_EVAL_PATTERN_SUGGESTIONS = 10;
let evalCountSinceLastAnalysis = 0;
const EVAL_ANALYSIS_INTERVAL = 20;  // run analysis every N evals

// ─── Per-Session Usage Tracking (from statusLine hook) ──────────────────────
const sessionUsage = new Map(); // session_id → { model, totalInputTokens, totalOutputTokens, contextPct, lastUpdate }
let aggregateUsage = { totalInputTokens: 0, totalOutputTokens: 0, sessions: 0 };

// ─── Terminal Configuration & State ─────────────────────────────────────────

const PROJECT_ROOT = process.env.SUPERVISOR_PROJECT_ROOT || resolve(process.env.HOME, "projects");
const MAX_TERMINALS = parseInt(process.env.SUPERVISOR_MAX_TERMINALS || "5");

// Cache of known project directories under PROJECT_ROOT (refreshed periodically)
let ownProjectsCache = new Set();
let ownProjectsCacheTime = 0;
const OWN_PROJECTS_CACHE_TTL = 30000; // 30s

function isOwnProject(projectName) {
  const now = Date.now();
  if (now - ownProjectsCacheTime > OWN_PROJECTS_CACHE_TTL) {
    try {
      const entries = readdirSync(PROJECT_ROOT, { withFileTypes: true });
      ownProjectsCache = new Set(
        entries.filter(e => e.isDirectory() && !e.name.startsWith(".")).map(e => e.name)
      );
    } catch {
      ownProjectsCache = new Set();
    }
    ownProjectsCacheTime = now;
  }
  return ownProjectsCache.has(projectName);
}

let terminalIdCounter = 0;
const terminals = new Map(); // terminalId -> TerminalSession

// ─── Claude API Status ──────────────────────────────────────────────────────

const STATUS_POLL_INTERVAL = 2 * 60 * 1000; // 2 minutes
let claudeApiStatus = { indicator: "unknown", description: "Checking...", incidents: [], lastChecked: null };

async function pollClaudeStatus() {
  try {
    const [statusRes, incidentsRes] = await Promise.all([
      fetch("https://status.claude.com/api/v2/status.json", { signal: AbortSignal.timeout(5000) }),
      fetch("https://status.claude.com/api/v2/incidents.json", { signal: AbortSignal.timeout(5000) }),
    ]);
    const statusData = await statusRes.json();
    const incidentsData = await incidentsRes.json();

    // Active incidents = not resolved
    const active = (incidentsData.incidents || [])
      .filter(i => !["resolved", "postmortem", "monitoring"].includes(i.status))
      .slice(0, 5)
      .map(i => ({
        name: i.name,
        status: i.status,
        impact: i.impact,
        updatedAt: i.updated_at,
        shortlink: i.shortlink,
        latestUpdate: i.incident_updates?.[0]?.body || "",
      }));

    const prev = claudeApiStatus.indicator;
    claudeApiStatus = {
      indicator: statusData.status?.indicator || "unknown",
      description: statusData.status?.description || "Unknown",
      incidents: active,
      lastChecked: new Date().toISOString(),
    };

    // Notify on status change
    if (prev !== "unknown" && prev !== claudeApiStatus.indicator) {
      const msg = claudeApiStatus.indicator === "none"
        ? "Claude API status: All systems operational"
        : `Claude API status: ${claudeApiStatus.description}`;
      const level = claudeApiStatus.indicator === "none" ? "info" : "warning";
      log(level === "info" ? "ok" : "warn", msg);
      broadcast({ type: "notification", message: msg, level });
    }
  } catch (e) {
    claudeApiStatus.lastChecked = new Date().toISOString();
    // Don't spam logs on network errors
  }
}

// ─── Claude Code Version ──────────────────────────────────────────────────
const VERSION_POLL_INTERVAL = 30 * 60 * 1000; // 30 minutes
const CLAUDE_BINARY = process.env.CLAUDE_BINARY || resolve(process.env.HOME, ".local/bin/claude");

let claudeVersion = {
  installed: null,
  latest: null,
  updateAvailable: false,
  releaseNotes: null,
  releaseUrl: null,
  lastChecked: null,
};

function getInstalledVersion() {
  try {
    const target = readlinkSync(CLAUDE_BINARY);
    const version = basename(target);
    if (/^\d+\.\d+\.\d+/.test(version)) return version;
  } catch {}
  try {
    const out = execFileSync(CLAUDE_BINARY, ["--version"], {
      env: { ...process.env, CLAUDECODE: "" },
      timeout: 5000,
      encoding: "utf-8",
    });
    const match = out.match(/(\d+\.\d+\.\d+)/);
    if (match) return match[1];
  } catch {}
  return null;
}

function getVersionAtTime(timestamp) {
  // Scan versions directory to find which version was installed at a given time
  const versionsDir = resolve(process.env.HOME, ".local/share/claude/versions");
  try {
    const entries = readdirSync(versionsDir);
    const versions = [];
    for (const name of entries) {
      if (!/^\d+\.\d+\.\d+/.test(name)) continue;
      try {
        const st = statSync(resolve(versionsDir, name));
        versions.push({ name, mtime: st.mtimeMs });
      } catch {}
    }
    versions.sort((a, b) => a.mtime - b.mtime);
    // Find the latest version that existed before the given timestamp
    let result = null;
    for (const v of versions) {
      if (v.mtime <= timestamp) result = v.name;
    }
    return result || versions[0]?.name || null;
  } catch {}
  return null;
}

async function writeProgressSnapshot(term) {
  const dir = resolve(term.projectDir, ".claude");
  const snapshotPath = resolve(dir, "progress-snapshot.md");
  try { await mkdir(dir, { recursive: true }); } catch {}

  const lines = [
    "# Progress Snapshot",
    "",
    `Auto-generated at ${new Date().toISOString()} (turn ${term.turnCount}) for **${term.project}**.`,
    "**Read this file after compaction to recover working state.**",
    "",
  ];

  // Git state
  try {
    const status = execFileSync("git", ["status", "--short"], { cwd: term.projectDir, encoding: "utf-8", timeout: 5000 });
    lines.push("## Uncommitted Changes", "", "```", status.trim() || "(clean)", "```", "");
  } catch {}

  try {
    const gitLog = execFileSync("git", ["log", "--oneline", "-10"], { cwd: term.projectDir, encoding: "utf-8", timeout: 5000 });
    lines.push("## Recent Commits", "", "```", gitLog.trim(), "```", "");
  } catch {}

  try {
    const diffStat = execFileSync("git", ["diff", "--stat", "HEAD"], { cwd: term.projectDir, encoding: "utf-8", timeout: 5000 });
    if (diffStat.trim()) {
      lines.push("## Uncommitted Diff Summary", "", "```", diffStat.trim(), "```", "");
    }
  } catch {}

  // Agent activity for this project
  const projectMsgs = agentMessages.filter(m => m.project === term.project).slice(-15);
  if (projectMsgs.length) {
    lines.push("## Recent Agent Activity", "");
    for (const m of projectMsgs) {
      const text = m.payload?.message || m.payload?.description || m.payload?.status || m.payload?.finding || "";
      lines.push(`- **${m.taskId || "agent"}** [${m.msgType || "?"}] ${text.slice(0, 120)}`);
    }
    lines.push("");
  }

  // Pending approvals for this project
  const projectApprovals = [...pendingApprovals.values()].filter(
    a => a.status === "pending" && a.project === term.project
  );
  lines.push("## Pending Approvals", "");
  if (projectApprovals.length) {
    for (const a of projectApprovals) {
      lines.push(`- [${a.tool}] ${(a.summary || "").slice(0, 120)}`);
    }
  } else {
    lines.push("None");
  }
  lines.push("");

  // Session info
  lines.push("## Session Info", "");
  lines.push(`- Turn count: ${term.turnCount}`);
  lines.push(`- Claude version: ${term.claudeVersion || "unknown"}`);
  lines.push(`- Session started: ${term.createdAt}`);
  lines.push("");

  await writeFile(snapshotPath, lines.join("\n"), "utf-8");
  log("info", `Progress snapshot written (turn ${term.turnCount})`, { project: term.project });
}

let _versionChecking = false;
let _lastFetchedNotes = null;

async function pollClaudeVersion() {
  if (_versionChecking) return;
  _versionChecking = true;
  try {
    claudeVersion.installed = getInstalledVersion();
    const npmRes = await fetch(
      "https://registry.npmjs.org/@anthropic-ai/claude-code/latest",
      { signal: AbortSignal.timeout(10000) }
    );
    const npmData = await npmRes.json();
    const latest = npmData.version;
    const wasAvailable = claudeVersion.updateAvailable;
    claudeVersion.latest = latest;
    claudeVersion.updateAvailable = !!(claudeVersion.installed && latest && latest !== claudeVersion.installed);
    claudeVersion.lastChecked = new Date().toISOString();

    if (claudeVersion.updateAvailable && latest !== _lastFetchedNotes) {
      try {
        const ghRes = await fetch(
          `https://api.github.com/repos/anthropics/claude-code/releases/tags/v${latest}`,
          { signal: AbortSignal.timeout(10000) }
        );
        if (ghRes.ok) {
          const release = await ghRes.json();
          claudeVersion.releaseNotes = release.body || null;
          claudeVersion.releaseUrl = release.html_url || null;
          _lastFetchedNotes = latest;
        }
      } catch {}
    }

    if (claudeVersion.updateAvailable && !wasAvailable) {
      log("info", `Claude Code update available: ${claudeVersion.installed} → ${latest}`);
    }
  } catch (e) {
    log("warn", `Version check failed: ${e.message}`);
  } finally {
    _versionChecking = false;
  }
}

// ─── Policy Loader ──────────────────────────────────────────────────────────

let supervisorPolicy = "";

async function loadPolicy() {
  try {
    supervisorPolicy = await readFile(SUPERVISOR_POLICY_PATH, "utf-8");
    log("info", `Loaded supervisor policy from ${SUPERVISOR_POLICY_PATH}`);
  } catch {
    log("warn", "No policy file found, using built-in default");
    supervisorPolicy = [
      "You are a security-focused supervisor evaluating tool calls from an AI coding assistant.",
      "Approve safe development operations. Deny dangerous or suspicious operations.",
      'Respond with ONLY: {"approved": true|false, "confidence": 0.0-1.0, "reason": "brief"}',
    ].join("\n");
  }
}

function checkClaudeCli() {
  if (SUPERVISOR_MODE === "manual") return;
  try {
    statSync(CLAUDE_BINARY);
    log("info", `AI supervisor active (mode=${SUPERVISOR_MODE}, fast=${SUPERVISOR_FAST_MODEL}, full=${SUPERVISOR_MODEL}, escalation=${EVAL_ESCALATION_THRESHOLD}%, threshold=${SUPERVISOR_CONFIDENCE_THRESHOLD})`);
  } catch {
    log("warn", "Claude CLI not in PATH -- AI evaluation will fail, falling back to human approval");
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function mapSessionToTerminal(sessionId, project) {
  if (!sessionId || sessionId === "unknown") return;
  for (const [tid, term] of terminals) {
    if (term.project === project && term.status === "running") {
      if (!term.sessionIds) term.sessionIds = new Set();
      if (term.sessionIds.size === 0 && !term.mainSessionId) {
        term.mainSessionId = sessionId;
      }
      term.sessionIds.add(sessionId);
    }
  }
}

// ─── Delegation Enforcement Helpers ──────────────────────────────────────────

function isImplementationTool(tool, summary) {
  if (["Write", "Edit", "NotebookEdit", "WebSearch", "WebFetch"].includes(tool)) return true;
  // MCP tools: stateful/action ones count as implementation
  if (tool.startsWith("mcp__")) {
    // Read-only MCP tools don't count
    if (/_(list|get|info|status|system_info|get_history|get_sse_stats|scan|analyze)/.test(tool)) return false;
    return true;
  }
  if (tool === "Bash") {
    const cmd = (summary || "").trim();
    // Read-only bash commands don't count as implementation
    if (/^(ls|echo|pwd|which|whoami|date|uname|cat|head|tail|wc|file|stat|diff|ps|pgrep|tree|git\s+(status|log|diff|show|branch|tag))(\s|$)/.test(cmd)) return false;
    // Agent communication doesn't count
    if (/^(mosquitto_(pub|sub)|sv)\s/.test(cmd)) return false;
    // Diagnostic/research commands don't count
    if (/^curl\s.*localhost/.test(cmd) || /^curl\s.*127\.0\.0\.1/.test(cmd)) return false;
    if (/^(node|python3?)\s+-(e|c)\s/.test(cmd)) return false;
    if (/^(grep|rg|find|ag)\s/.test(cmd)) return false;
    // Package installs don't count — long ML/data-science workflows need many sequential installs
    if (/^(\.?\.?\.?venv\/bin\/)?(pip3?|pip3?\s+install|npm\s+(install|i|ci)|cargo\s+(add|install)|apt(-get)?\s+install|brew\s+install)(\s|$)/.test(cmd)) return false;
    // Quick git coordination doesn't count
    if (/^git\s+(add|commit|push|stash)(\s|$)/.test(cmd)) return false;
    // Read-only database queries don't count as implementation work
    if (/\b(psql|mysql|mariadb|sqlite3)\b/.test(cmd)) {
      const sqlReadOnly = /\b(SELECT|SHOW|DESCRIBE|EXPLAIN|\\l|\\d[tinus]?|\\conninfo)\b/i.test(cmd);
      const sqlWrite = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE)\b/i.test(cmd);
      if (sqlReadOnly && !sqlWrite) return false;
    }
    return true;
  }
  return false;
}

function updateDelegationTracker(sessionId, project, tool, summary) {
  if (!DELEGATION_ENFORCEMENT || !sessionId || sessionId === "unknown") return;

  let tracker = delegationTrackers.get(sessionId);
  if (!tracker) {
    tracker = {
      sessionId,
      project,
      implCount: 0,
      isMainAgent: null,
      totalTaskCalls: 0,
      recentImplCalls: [],
      createdAt: new Date().toISOString(),
    };
    delegationTrackers.set(sessionId, tracker);
  }

  if (tool === "Task" || tool === "Agent") {
    // Task/Agent use resets the counter — agent is delegating correctly
    tracker.implCount = 0;
    tracker.isMainAgent = true;
    tracker.totalTaskCalls++;
    tracker.recentImplCalls = [];
    return;
  }

  if (isImplementationTool(tool, summary)) {
    // Track for logging and hint generation only — enforcement is context-% based
    tracker.implCount++;
    tracker.recentImplCalls.push(`${tool}: ${(summary || "").slice(0, 80)}`);
    if (tracker.recentImplCalls.length > 5) tracker.recentImplCalls.shift();
  }
}

function getSessionContextPercent(sessionId, project) {
  // Look up contextPercent from the terminal that owns this session
  for (const [, term] of terminals) {
    if (term.mainSessionId === sessionId) return term.contextPercent ?? null;
    if (term.project === project && term.sessionIds && term.sessionIds.has(sessionId)) {
      return term.contextPercent ?? null;
    }
  }
  return null;
}

function checkDelegation(sessionId, project, tool, summary) {
  if (!DELEGATION_ENFORCEMENT) return { allowed: true };

  const tracker = delegationTrackers.get(sessionId);
  if (!tracker) return { allowed: true };

  // Only enforce on confirmed main agents
  if (tracker.isMainAgent !== true) {
    // Try structural identification: first session on a terminal = main agent
    for (const [, term] of terminals) {
      if (term.project === project && term.mainSessionId === sessionId) {
        tracker.isMainAgent = true;
        break;
      }
    }
    if (tracker.isMainAgent !== true) return { allowed: true };
  }

  // Context-percentage-based enforcement
  const contextPct = getSessionContextPercent(sessionId, project);

  // Unknown context % → no enforcement (don't penalize sessions we can't measure)
  if (contextPct === null) return { allowed: true };

  // contextPct is REMAINING (e.g., 93 = 93% left, only 7% used)
  // Above 50% remaining → plenty of room, let agents work freely
  if (contextPct > 50) return { allowed: true };

  // Below 30% remaining → strict enforcement: deny implementation calls from main agent
  if (contextPct <= 30 && isImplementationTool(tool, summary)) {
    const recentList = tracker.recentImplCalls.map(c => `  - ${c}`).join("\n");
    const implCount = tracker.implCount;

    let corrective;
    if (["Write", "Edit", "NotebookEdit"].includes(tool)) {
      corrective = "Spawn an implementer subagent: use the Agent tool with subagent_type='implementer' and describe the file changes needed.";
    } else if (tool === "Bash") {
      corrective = "Spawn a subagent to run this command sequence, or use run_in_background: true for long-running commands.";
    } else if (["WebSearch", "WebFetch"].includes(tool)) {
      corrective = "Spawn a researcher subagent: use the Agent tool with subagent_type='researcher' to handle the research.";
    } else {
      corrective = "Use the Agent tool to spawn a subagent and describe the work needed.";
    }

    return {
      allowed: false,
      reason: `DELEGATION REQUIRED (${contextPct}% context remaining, threshold: 30%)\n\nContext is critically low. Continuing implementation work directly risks auto-compaction, which causes memory loss and interrupts ongoing work. Main agents must delegate to subagents to preserve the coordination context.\n\nDirect implementation calls since last delegation: ${implCount}\nRecent implementation calls:\n${recentList}\n\nCorrective action: ${corrective}`,
    };
  }

  // 30-50% remaining: warn only (hint injected via buildEvalPrompt), never deny here
  if (contextPct <= 50 && isImplementationTool(tool, summary)) {
    const implCount = tracker.implCount;
    return {
      allowed: true,
      warning: `${contextPct}% context remaining. Consider delegating implementation work to subagents soon. ${implCount} direct implementation call${implCount === 1 ? "" : "s"} since last delegation.`,
    };
  }

  return { allowed: true };
}

function trackSession(sessionId, project) {
  if (!sessionId || sessionId === "unknown") return;
  const existing = sessions.get(sessionId);
  sessions.set(sessionId, {
    project: project || existing?.project || "unknown",
    lastSeen: new Date().toISOString(),
    approvalCount: existing?.approvalCount || 0,
  });
}

function redactSecrets(str) {
  // Redact JWTs (eyJ...), long hex/base64 tokens (32+ chars), and key=value secrets
  return str
    .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, "eyJ***REDACTED***")
    .replace(/(?<=[\s'"`=:])[A-Za-z0-9+/]{40,}={0,2}(?=[\s'"`\n,;)}]|$)/g, "***REDACTED***")
    .replace(/(?:api[_-]?key|token|secret|password|auth)\s*[:=]\s*['"]?[^\s'"]{8,}/gi, (m) => m.slice(0, m.indexOf(m.match(/[:=]/)[0]) + 2) + "***REDACTED***");
}

function log(level, message, data = {}) {
  const safeMessage = redactSecrets(message);
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message: safeMessage,
    ...data,
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  broadcast({ type: "log", entry });

  const icons = { info: "i", warn: "!", error: "X", tool: "*", ok: "+", notify: "~", ai: "#" };
  const proj = data.project ? `[${data.project}] ` : "";
  console.log(`[${icons[level] || " "}] [${entry.timestamp.slice(11, 19)}] ${proj}${safeMessage}`);
}

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function broadcastEvalStats() {
  broadcast({ type: "eval_stats", stats: evalStats, serverStartedAt });
}

// ─── AI Evaluation Queue ────────────────────────────────────────────────────

const EVAL_QUEUE_MAX_DEPTH = 50;

function enqueueEvaluation(approvalId) {
  if (evaluationQueue.length >= EVAL_QUEUE_MAX_DEPTH) {
    return Promise.reject(new Error(`Eval queue full (${EVAL_QUEUE_MAX_DEPTH} pending), falling through to manual`));
  }
  return new Promise((resolvePromise) => {
    evaluationQueue.push({ approvalId, resolve: resolvePromise });
    processQueue();
  });
}

function processQueue() {
  while (activeEvaluations < SUPERVISOR_MAX_CONCURRENT && evaluationQueue.length > 0) {
    const { approvalId, resolve } = evaluationQueue.shift();
    const approval = pendingApprovals.get(approvalId);

    if (!approval || approval.status !== "pending") {
      resolve({ skipped: true });
      continue;
    }

    activeEvaluations++;
    evalStats.aiEvals++;
    runEvaluation(approval)
      .then((result) => resolve(result))
      .catch((err) => resolve({ error: err.message }))
      .finally(() => {
        activeEvaluations--;
        processQueue();
      });
  }
}

// ─── AI Evaluation ──────────────────────────────────────────────────────────

function buildEvalPrompt(approval) {
  const projectLogs = logs
    .filter((l) => l.project === approval.project)
    .slice(-15)
    .map((l) => `[${l.timestamp.slice(11, 19)}] ${l.message}`)
    .join("\n");

  // Prepare raw input display (truncate large payloads)
  let rawInputDisplay = typeof approval.rawInput === "string"
    ? approval.rawInput
    : JSON.stringify(approval.rawInput, null, 2);
  if (rawInputDisplay.length > 3000) {
    rawInputDisplay = rawInputDisplay.slice(0, 3000) + "\n... (truncated, total " + rawInputDisplay.length + " chars)";
  }

  // Pre-compute supervisor hints for subagent enforcement
  const hints = [];

  if (approval.tool === "Write" && approval.rawInput) {
    const content = typeof approval.rawInput === "string"
      ? approval.rawInput
      : (approval.rawInput.content || "");
    const lineCount = (content.match(/\n/g) || []).length + 1;
    if (lineCount > 100) {
      hints.push(`**Content size**: ~${lineCount} lines (large file write)`);
    }
  }

  if (approval.tool === "Bash" && approval.rawInput) {
    const cmd = typeof approval.rawInput === "string"
      ? approval.rawInput
      : (approval.rawInput.command || "");
    const chainCount = (cmd.match(/&&/g) || []).length;
    if (chainCount >= 2) {
      hints.push(`**Command chains**: ${chainCount + 1} chained operations (${chainCount} && operators)`);
    }
  }

  // Context-percentage-aware delegation hints
  if (DELEGATION_ENFORCEMENT) {
    const contextPct = getSessionContextPercent(approval.sessionId, approval.project);
    const tracker = delegationTrackers.get(approval.sessionId);
    const isMain = tracker && tracker.isMainAgent;
    if (contextPct !== null && isMain) {
      // contextPct is REMAINING (e.g., 30 = 30% left, 70% used)
      if (contextPct <= 30) {
        hints.push(`**Context ${contextPct}% remaining**: Main agent must delegate implementation work to subagents to preserve context window. Deny implementation tool calls and instruct use of Task tool.`);
      } else if (contextPct <= 35) {
        hints.push(`**Context ${contextPct}% remaining**: STRONGLY recommend delegation. Direct implementation (Write/Edit/Bash) should be denied unless trivial (single-line edits, quick reads). Encourage Task tool use.`);
      } else if (contextPct <= 50) {
        hints.push(`**Context ${contextPct}% remaining**: Agent context is filling up. Encourage delegation but allow direct tool use for now.`);
      }
    }
  }

  const parts = [
    "## Tool Call Evaluation Request",
    "",
    `**Tool**: ${approval.tool}`,
    `**Hook Type**: ${approval.hookType}`,
    `**Project**: ${approval.project}`,
    `**Summary**: ${approval.summary}`,
    "",
    "### Raw Input",
    "```json",
    rawInputDisplay,
    "```",
  ];

  if (hints.length > 0) {
    parts.push("", "### Supervisor Hints", ...hints);
  }

  parts.push(
    "",
    "### Recent Activity in This Project",
    "```",
    projectLogs || "(no recent activity)",
    "```",
    "",
    "Evaluate this tool call. Respond with ONLY a JSON object:",
    '{"approved": true|false, "confidence": 0.0-1.0, "reason": "brief explanation"}',
    'The "confidence" field is a float 0.0-1.0 indicating how certain you are of your decision. Use 0.90+ for clear-cut cases, 0.50-0.89 for ambiguous ones, and below 0.50 if you are unsure.',
  );

  return parts.join("\n");
}

function runEvalWithModel(prompt, model) {
  return new Promise((resolveP, reject) => {
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--system-prompt", supervisorPolicy,
      "--model", model,
      "--max-turns", "1",
    ];

    // Minimal env: strip MCP configs to avoid slow server startup in eval subprocess
    const evalEnv = { ...process.env, CLAUDECODE: "" };
    delete evalEnv.MCP_SERVERS;
    delete evalEnv.CLAUDE_MCP_SERVERS;
    const child = spawn(CLAUDE_BINARY, args, {
      env: evalEnv,
      stdio: [devNull, "pipe", "pipe"],
      cwd: __dirname,
    });

    let stdout = "";
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    child.stdout.on("data", (d) => { if (stdout.length < 1048576) stdout += d; });
    child.stderr.on("data", () => {});

    child.on("error", (err) => {
      clearTimeout(timer);
      settle(reject, new Error(`claude CLI spawn error: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (code !== 0 && !stdout) {
        return settle(reject, new Error(`claude CLI exited with code ${code}`));
      }

      try {
        // claude --output-format json returns a JSON wrapper
        let text = stdout;
        try {
          const cliOutput = JSON.parse(stdout);
          text = cliOutput.result ||
            (Array.isArray(cliOutput.content)
              ? cliOutput.content.map((c) => c.text || "").join("")
              : String(cliOutput.content || stdout));
        } catch {
          // stdout might be raw text, use as-is
        }

        // Extract JSON from response (AI might wrap in markdown fences)
        const jsonMatch = text.match(/\{[\s\S]*?"approved"[\s\S]*?\}/);
        if (!jsonMatch) {
          return settle(reject, new Error(`No JSON in AI response: ${text.slice(0, 200)}`));
        }

        const decision = JSON.parse(jsonMatch[0]);
        if (typeof decision.approved !== "boolean") {
          return settle(reject, new Error("Invalid decision: 'approved' must be boolean"));
        }

        // Normalize confidence: prompt asks for 0.0-1.0; guard against models that return 0-100
        let rawConf = parseFloat(decision.confidence ?? decision.conf ?? 50);
        if (rawConf > 1) rawConf = rawConf / 100; // treat >1 as 0-100 scale, convert to 0.0-1.0
        const confidence = Math.max(0, Math.min(1, rawConf));

        settle(resolveP, {
          approved: decision.approved,
          confidence,
          reason: String(decision.reason || "No reason provided"),
          model,
        });
      } catch (parseErr) {
        settle(reject, new Error(`Parse failure: ${parseErr.message}`));
      }
    });

    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      settle(reject, new Error("Evaluation timed out"));
    }, SUPERVISOR_EVAL_TIMEOUT);
  });
}

/**
 * Check Ollama /api/ps to find the best model already loaded in VRAM.
 * Prefers larger models from the trusted list. Falls back to OLLAMA_MODEL if nothing loaded.
 */
async function selectOllamaModel() {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/ps`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return OLLAMA_MODEL;

    const data = await response.json();
    const loaded = data.models || [];

    // Prefer the configured eval model if it's already loaded
    const configuredLoaded = loaded.find(m => m.name === OLLAMA_MODEL || m.name === OLLAMA_MODEL + ':latest');
    if (configuredLoaded) return configuredLoaded.name;

    // Otherwise pick any loaded trusted model (smallest first — faster eval)
    const trusted = loaded
      .filter(m => OLLAMA_TRUSTED_MODELS.includes(m.name))
      .sort((a, b) => (a.size || 0) - (b.size || 0));

    if (trusted.length > 0) {
      return trusted[0].name;
    }

    // Nothing trusted loaded — fall back to default (will trigger a model load)
    return OLLAMA_MODEL;
  } catch {
    return OLLAMA_MODEL;
  }
}

async function runEvalWithOllama(prompt, model) {
  const selectedModel = await selectOllamaModel();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SUPERVISOR_EVAL_TIMEOUT);

  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: selectedModel,
        messages: [
          { role: 'system', content: supervisorPolicy },
          { role: 'user', content: prompt },
        ],
        stream: false,
        format: 'json',
        options: {
          temperature: 0,
          num_predict: 256,  // Keep response short — we only need a JSON object
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    const content = data.message?.content || '';

    // Parse the JSON response — try multiple strategies for robustness
    const result = extractJsonResult(content);
    if (!result) {
      throw new Error(`No valid JSON in Ollama response: ${content.substring(0, 200)}`);
    }
    const confidence = (typeof result.confidence === 'number')
      ? (result.confidence > 1 ? result.confidence / 100 : result.confidence)
      : 0.5;

    return {
      approved: !!result.approved,
      confidence,
      reason: result.reason || 'No reason provided',
      model: selectedModel,
    };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error(`Ollama eval timed out after ${SUPERVISOR_EVAL_TIMEOUT}ms`);
    }
    throw err;
  }
}

/**
 * Extract a valid JSON result object from a model response string.
 * Tries three strategies:
 *   1. Parse the full response as JSON
 *   2. Extract JSON from a markdown code block (```json ... ```)
 *   3. Find the first {...} substring that parses as JSON with an "approved" key
 */
function extractJsonResult(content) {
  if (!content) return null;

  // Strategy 1: full content is JSON
  try {
    const parsed = JSON.parse(content.trim());
    if (typeof parsed.approved !== 'undefined') return parsed;
  } catch {}

  // Strategy 2: JSON in a markdown code block
  const codeBlock = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlock) {
    try {
      const parsed = JSON.parse(codeBlock[1]);
      if (typeof parsed.approved !== 'undefined') return parsed;
    } catch {}
  }

  // Strategy 3: find any {...} that parses as a JSON object with "approved"
  // Walk through the string looking for '{' and try to parse from there
  let depth = 0;
  let start = -1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (content[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = content.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (typeof parsed.approved !== 'undefined') return parsed;
        } catch {}
        start = -1;
      }
    }
  }

  return null;
}

async function runEvalWithHaiku(prompt) {
  // Use the local Ollama proxy for Haiku — avoids direct Anthropic API calls
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch('http://localhost:11436/haiku/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        messages: [
          { role: 'system', content: supervisorPolicy },
          { role: 'user', content: prompt },
        ],
        stream: false,
        options: { temperature: 0, num_predict: 256 },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Haiku proxy returned ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    // Proxy may return Ollama-style or Anthropic-style response
    const content = data.message?.content || data.content?.[0]?.text || '';
    const result = extractJsonResult(content);
    if (!result) throw new Error(`No valid JSON from Haiku proxy: ${content.substring(0, 200)}`);

    const confidence = (typeof result.confidence === 'number')
      ? (result.confidence > 1 ? result.confidence / 100 : result.confidence)
      : 0.5;

    return {
      approved: !!result.approved,
      confidence,
      reason: result.reason || 'No reason provided',
      model: 'claude-haiku (proxy fallback)',
    };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function runEvaluation(approval) {
  const prompt = buildEvalPrompt(approval);

  if (EVAL_BACKEND === 'ollama') {
    // Primary: local Ollama (gpt-oss:20b or best loaded model)
    try {
      return await runEvalWithOllama(prompt, OLLAMA_MODEL);
    } catch (ollamaErr) {
      log("warn", `Ollama eval failed (${ollamaErr.message}), falling back to Haiku proxy`, { project: approval.project });
    }

    // Fallback: Haiku via local proxy
    try {
      const haikusResult = await runEvalWithHaiku(prompt);
      haikusResult.fallbackFrom = 'ollama';
      return haikusResult;
    } catch (haikuErr) {
      log("warn", `Haiku proxy eval failed (${haikuErr.message}), approving with low confidence`, { project: approval.project });
      // Both evals failed — approve with low confidence rather than blocking work
      return { approved: true, confidence: 0.5, reason: 'Both eval backends failed; approving with low confidence', model: 'fallback' };
    }
  } else {
    // Claude CLI: Haiku only (Sonnet removed — too paranoid)
    return await runEvalWithModel(prompt, SUPERVISOR_FAST_MODEL);
  }
}

function analyzeEvalPatterns() {
  // Read recent eval history from the JSONL file (last 50 entries)
  let entries = [];
  try {
    const historyPath = join(__dirname, "logs", "eval-history.jsonl");
    const raw = readFileSync(historyPath, "utf-8");
    entries = raw.trim().split("\n").filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean).slice(-50);
  } catch (e) {
    return; // No history yet, nothing to analyze
  }

  if (entries.length < 5) return; // Not enough data

  const denied = entries.filter(e => e.decision === "denied");
  const newSuggestions = [];

  // Pattern 1: Same command denied 2+ times
  const commandDenials = new Map(); // "tool|command" -> entries[]
  for (const e of denied) {
    const key = `${e.tool}|${(e.command || "").trim()}`;
    if (!commandDenials.has(key)) commandDenials.set(key, []);
    commandDenials.get(key).push(e);
  }
  for (const [key, matches] of commandDenials) {
    if (matches.length >= 2) {
      const [tool, command] = key.split("|");
      newSuggestions.push({
        type: "memory_suggestion",
        pattern: "repeated_command_denial",
        project: matches[matches.length - 1].project,
        count: matches.length,
        suggestion: `The command "${command || tool}" was denied ${matches.length} times. Consider adding a hook rule or CLAUDE.md note to prevent this pattern.`,
        examples: matches.map(e => e.command || e.tool).slice(0, 3),
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Pattern 2: 3+ delegation violations for same project
  const delegationByProject = new Map(); // project -> entries[]
  for (const e of denied) {
    if (e.reason && /delegation|subagent|Task tool/i.test(e.reason)) {
      if (!delegationByProject.has(e.project)) delegationByProject.set(e.project, []);
      delegationByProject.get(e.project).push(e);
    }
  }
  for (const [project, matches] of delegationByProject) {
    if (matches.length >= 3) {
      newSuggestions.push({
        type: "memory_suggestion",
        pattern: "repeated_delegation_violation",
        project,
        count: matches.length,
        suggestion: `Project "${project}" has ${matches.length} delegation violations in recent evals. Consider adding concrete delegation examples to its CLAUDE.md.`,
        examples: matches.map(e => e.command || e.tool).slice(0, 3),
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Pattern 3: 3+ denials with similar reasons (keyword clustering)
  const reasonKeywords = new Map(); // keyword -> entries[]
  const keywordRe = /\b(rm -rf|curl \| sh|wget \| bash|\/etc\/|\/sys\/|force.push|credential|secret|\.env)\b/i;
  for (const e of denied) {
    const match = e.reason && e.reason.match(keywordRe);
    if (match) {
      const kw = match[0].toLowerCase();
      if (!reasonKeywords.has(kw)) reasonKeywords.set(kw, []);
      reasonKeywords.get(kw).push(e);
    }
  }
  for (const [kw, matches] of reasonKeywords) {
    if (matches.length >= 3) {
      newSuggestions.push({
        type: "memory_suggestion",
        pattern: "repeated_denial_same_reason",
        project: matches[matches.length - 1].project,
        count: matches.length,
        suggestion: `${matches.length} recent denials mention "${kw}". Consider adding a memory entry about this recurring pattern.`,
        examples: matches.map(e => e.command || e.tool).slice(0, 3),
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Deduplicate against existing suggestions (same pattern+project) and add new ones
  for (const s of newSuggestions) {
    const alreadyExists = evalPatternSuggestions.some(
      existing => existing.pattern === s.pattern && existing.project === s.project
    );
    if (!alreadyExists) {
      evalPatternSuggestions.push(s);
      if (evalPatternSuggestions.length > MAX_EVAL_PATTERN_SUGGESTIONS) {
        evalPatternSuggestions.shift();
      }
      broadcast(s);
    }
  }
}

async function triggerAIEvaluation(approvalId) {
  const approval = pendingApprovals.get(approvalId);
  if (!approval || approval.status !== "pending") return;

  try {
    log("ai", `AI evaluating #${approvalId}: ${approval.tool}...`,
      { project: approval.project });

    const result = await enqueueEvaluation(approvalId);

    // Re-check: human may have decided while we waited
    const current = pendingApprovals.get(approvalId);
    if (!current || current.status !== "pending") {
      log("info", `AI eval #${approvalId} moot: already decided`);
      return;
    }

    if (result.skipped) return;
    if (result.error) throw new Error(result.error);

    // Store AI recommendation
    current.aiDecision = result;
    current.aiStatus = "decided";
    current.evaluatedBy = result.model;
    current.evalConfidence = result.confidence;
    if (result.escalatedFrom) current.escalatedFrom = result.escalatedFrom;

    const modelShort = result.model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
    const confPct = (result.confidence * 100).toFixed(0);
    const escalateTag = result.escalatedFrom ? " [escalated]" : "";

    if (SUPERVISOR_MODE === "auto" && result.confidence >= SUPERVISOR_CONFIDENCE_THRESHOLD) {
      current.status = result.approved ? "approved" : "denied";
      current.reason = `[AI ${confPct}% ${modelShort}${escalateTag}] ${result.reason}`;
      current.decidedBy = "ai";
      current.decidedAt = new Date().toISOString();

      log(result.approved ? "ok" : "warn",
        `AI auto-${current.status} #${approvalId}: ${current.tool} (${confPct}% by ${modelShort}${escalateTag})`,
        { project: current.project });

      try {
        const historyLine = JSON.stringify({
          ts: new Date().toISOString(),
          project: current.project,
          tool: current.tool,
          command: current.summary,
          rawInput: current.rawInput,
          decision: current.status,
          confidence: result.confidence,
          reason: result.reason,
          model: result.model,
          hookType: current.hookType,
        });
        appendFileSync(join(__dirname, "logs", "eval-history.jsonl"), historyLine + "\n");
      } catch (e) {
        // Don't let history persistence failure break eval flow
      }

      // Periodically analyze eval patterns for recurring issues
      evalCountSinceLastAnalysis++;
      if (evalCountSinceLastAnalysis >= EVAL_ANALYSIS_INTERVAL) {
        evalCountSinceLastAnalysis = 0;
        try { analyzeEvalPatterns(); } catch (e) { /* non-critical */ }
      }

      if (result.approved) evalStats.aiApproved++; else evalStats.aiDenied++;
      broadcast({ type: "approval_resolved", id: approvalId, status: current.status, decidedBy: "ai", evaluatedBy: result.model, confidence: result.confidence });
      broadcastEvalStats();
    } else {
      const reason = SUPERVISOR_MODE === "assisted"
        ? "assisted mode requires human confirmation"
        : `confidence ${confPct}% below threshold`;

      log("info",
        `AI recommends ${result.approved ? "APPROVE" : "DENY"} #${approvalId} (${reason}, ${modelShort}${escalateTag})`,
        { project: current.project });

      if (result.approved) evalStats.aiApproved++; else evalStats.aiDenied++;
      broadcast({ type: "ai_recommendation", id: approvalId, aiDecision: result });
      broadcastEvalStats();
    }
  } catch (err) {
    const current = pendingApprovals.get(approvalId);
    if (current) {
      current.aiStatus = err.message.includes("timed out") ? "timeout" : "error";
      current.aiError = err.message;
    }
    log("warn", `AI eval failed #${approvalId}: ${err.message}`, { project: current?.project });
    broadcast({ type: "ai_error", id: approvalId, error: err.message });
    broadcastEvalStats();
  }
}

// ─── Question Handling Stubs ─────────────────────────────────────────────────

async function injectQuestionAnswers(question) {
  const terminal = terminals.get(question.terminalId);
  if (!terminal || terminal.status !== "running") {
    question.status = "failed";
    log("warn", `Question #${question.id}: terminal not found or not running`, { project: question.project });
    broadcast({ type: "question_failed", id: question.id, reason: "Terminal not available" });
    return;
  }

  try {
    for (let i = 0; i < question.answers.length; i++) {
      const answer = question.answers[i];
      const q = question.questions[i];

      // Wait for the question UI to render in the terminal
      await waitForQuestionRender(terminal, q, 4000);
      await sleep(300);

      if (answer.freeformText != null) {
        // Navigate to "Other" option (after all predefined options)
        const downPresses = (q.options || []).length;
        for (let d = 0; d < downPresses; d++) {
          terminal.pty.write("\x1b[B");
          await sleep(60);
        }
        terminal.pty.write("\r");
        await sleep(200);
        terminal.pty.write(answer.freeformText);
        await sleep(100);
        terminal.pty.write("\r");
      } else {
        // Navigate to the chosen option index
        const downPresses = answer.optionIndex || 0;
        for (let d = 0; d < downPresses; d++) {
          terminal.pty.write("\x1b[B");
          await sleep(60);
        }
        terminal.pty.write("\r");
      }

      // Wait before next question
      await sleep(400);
    }

    question.status = "completed";
    log("ok", `Question #${question.id}: answered ${question.answers.length} question(s) via keystrokes`,
      { project: question.project });
    broadcast({ type: "question_completed", id: question.id });
  } catch (err) {
    question.status = "failed";
    log("warn", `Question #${question.id}: injection failed: ${err.message}`,
      { project: question.project });
    broadcast({ type: "question_failed", id: question.id, reason: err.message });
  }
}

function waitForQuestionRender(terminal, question, timeoutMs) {
  return new Promise((resolve) => {
    const searchText = (question.question || question.header || "").slice(0, 40);
    if (!searchText) {
      setTimeout(resolve, 1000);
      return;
    }

    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (disposable) disposable.dispose();
    };

    // Check recent scrollback first — question may have already rendered
    const recent = terminal.scrollback.slice(-10).map(b => b.toString()).join("");
    const plainRecent = recent.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    if (plainRecent.includes(searchText)) {
      resolve();
      return;
    }

    // Watch for new terminal output containing the question text
    let accumulated = "";
    const disposable = terminal.pty.onData((data) => {
      if (resolved) return;
      accumulated += data;
      const plain = accumulated.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
      if (plain.includes(searchText)) {
        finish();
        resolve();
      }
    });

    const timer = setTimeout(() => {
      finish();
      resolve(); // Resolve anyway on timeout — question may have rendered before listener
    }, timeoutMs);
  });
}

async function evaluateQuestionWithAI(question) {
  return new Promise((resolveP, reject) => {
    const questionsText = question.questions.map((q, i) => {
      const opts = (q.options || []).map((o, j) =>
        `  ${j}: "${o.label}"${o.description ? " — " + o.description : ""}`
      );
      return `Question ${i + 1}${q.header ? " (" + q.header + ")" : ""}:\n${q.question}\nOptions:\n${opts.join("\n")}`;
    }).join("\n\n");

    const prompt = [
      "You are assisting an AI coding agent by answering its planning questions.",
      "The agent needs a decision to continue working autonomously.",
      `Project: ${question.project}`,
      "",
      questionsText,
      "",
      "For each question, choose the best option for an autonomous coding workflow.",
      "Prefer actionable, specific options. Avoid overly cautious choices that would stall progress.",
      "Respond with ONLY a JSON array, no other text:",
      "[{\"questionIndex\": 0, \"optionIndex\": N}, ...]",
      "",
      "If none of the options are appropriate, use freeformText instead of optionIndex:",
      "[{\"questionIndex\": 0, \"freeformText\": \"your answer\"}]",
    ].join("\n");

    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--model", process.env.SUPERVISOR_QUESTION_MODEL || "claude-sonnet-4-20250514",
      "--max-turns", "1",
    ];

    const evalEnv = { ...process.env, CLAUDECODE: "" };
    delete evalEnv.MCP_SERVERS;
    delete evalEnv.CLAUDE_MCP_SERVERS;
    const child = spawn(CLAUDE_BINARY, args, {
      env: evalEnv,
      stdio: [devNull, "pipe", "pipe"],
      cwd: __dirname,
    });

    let stdout = "";
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    child.stdout.on("data", (d) => { if (stdout.length < 1048576) stdout += d; });
    child.stderr.on("data", () => {});

    child.on("error", (err) => {
      clearTimeout(timer);
      settle(reject, new Error(`claude CLI spawn error: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (code !== 0 && !stdout) {
        return settle(reject, new Error(`claude CLI exited with code ${code}`));
      }

      try {
        let text = stdout;
        try {
          const cliOutput = JSON.parse(stdout);
          text = cliOutput.result ||
            (Array.isArray(cliOutput.content)
              ? cliOutput.content.map((c) => c.text || "").join("")
              : String(cliOutput.content || stdout));
        } catch {
          // stdout might be raw text
        }

        const jsonMatch = text.match(/\[[\s\S]*?\]/);
        if (!jsonMatch) {
          return settle(reject, new Error(`No JSON array in AI response: ${text.slice(0, 200)}`));
        }

        const answers = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(answers)) {
          return settle(reject, new Error("AI response is not an array"));
        }

        // Validate answers
        for (const a of answers) {
          if (typeof a.questionIndex !== "number") {
            return settle(reject, new Error("Invalid answer: missing questionIndex"));
          }
          if (a.optionIndex == null && a.freeformText == null) {
            return settle(reject, new Error("Invalid answer: needs optionIndex or freeformText"));
          }
        }

        settle(resolveP, answers);
      } catch (parseErr) {
        settle(reject, new Error(`Parse failure: ${parseErr.message}`));
      }
    });

    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      settle(reject, new Error("AI question evaluation timed out"));
    }, 60000);
  });
}

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({
  server,
  verifyClient: (info) => {
    if (!AUTH_ENABLED) return true;
    const cookie = parseCookieHeader(info.req.headers.cookie || "");
    return verifySession(cookie.supervisor_session);
  }
});

app.use(express.json({ limit: '50mb' }));

// ── Auth routes (no middleware applied) ────────────────────────────────────

app.get("/login", (req, res) => {
  res.type("html").send(LOGIN_PAGE.replace("{{ERROR}}", ""));
});

app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
  if (!AUTH_ENABLED) return res.redirect("/");
  const pw = req.body?.password || "";
  if (pw === SUPERVISOR_PASSWORD) {
    const value = signSession({ authenticated: true, ts: Date.now() });
    res.setHeader("Set-Cookie", `supervisor_session=${value}; Path=/; HttpOnly; SameSite=Strict`);
    return res.redirect("/");
  }
  res.type("html").send(LOGIN_PAGE.replace("{{ERROR}}", '<div class="error">Incorrect password. Please try again.</div>'));
});

app.get("/logout", (req, res) => {
  res.setHeader("Set-Cookie", "supervisor_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
  res.redirect("/login");
});

// ── Auth middleware ─────────────────────────────────────────────────────────

app.use((req, res, next) => {
  if (!AUTH_ENABLED) return next();

  // Hook routes use bearer token auth
  if (req.path.startsWith("/api/hook/")) {
    const auth = req.headers.authorization;
    if (auth === `Bearer ${HOOK_TOKEN}`) return next();
    return res.status(401).json({ error: "Invalid hook token" });
  }

  // All other routes use cookie auth
  const cookie = parseCookieHeader(req.headers.cookie || "");
  if (verifySession(cookie.supervisor_session)) return next();

  // API calls get 401, browser requests get redirected
  const wantsJson = req.headers.accept?.includes("application/json") || req.path.startsWith("/api/");
  if (wantsJson) return res.status(401).json({ error: "Authentication required" });
  return res.redirect("/login");
});

// ── Hook Endpoints ──────────────────────────────────────────────────────────

app.post("/api/hook/approval", (req, res) => {
  const { tool, summary, session_id, raw_input, hook_type, project } = req.body;
  const id = ++approvalIdCounter;
  evalStats.totalRequests++;

  trackSession(session_id, project);
  mapSessionToTerminal(session_id, project);
  if (sessions.has(session_id)) {
    sessions.get(session_id).approvalCount++;
  }

  const approval = {
    id,
    tool: tool || "unknown",
    summary: summary || "",
    hookType: hook_type || "PreToolUse",
    sessionId: session_id,
    project: project || sessions.get(session_id)?.project || "unknown",
    rawInput: raw_input,
    status: "pending",
    createdAt: new Date().toISOString(),
    aiStatus: SUPERVISOR_MODE === "manual" ? "skipped" : "evaluating",
    aiDecision: null,
    decidedBy: null,
  };

  pendingApprovals.set(id, approval);

  log("tool", `Approval #${id}: ${tool} -> ${summary.slice(0, 120)}`,
    { project: approval.project, sessionId: session_id });
  broadcast({ type: "approval_request", approval });

  if (SUPERVISOR_MODE !== "manual") {
    triggerAIEvaluation(id);
  }

  res.json({ id, status: "pending" });
});

app.get("/api/hook/decision/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const approval = pendingApprovals.get(id);

  if (!approval) return res.json({ status: "not_found" });

  if (approval.status !== "pending" && !approval.polledDecisionAt) {
    approval.polledDecisionAt = new Date().toISOString();
  }

  res.json({
    status: approval.status,
    reason: approval.reason || "",
    decidedBy: approval.decidedBy || null,
  });
});

app.post("/api/hook/log", (req, res) => {
  const { tool, summary, session_id, event, project } = req.body;
  trackSession(session_id, project);
  const p = project || sessions.get(session_id)?.project || "unknown";
  updateDelegationTracker(session_id, p, tool, summary);
  log("ok", `${event || "tool"}: ${tool} -- ${summary}`, { sessionId: session_id, project: p });

  // Track turn count for terminal sessions on Stop events
  if (event === "Stop") {
    for (const [id, term] of terminals) {
      if (term.project === p && term.status === "running") {
        term.turnCount++;
        const msg = JSON.stringify({ type: "terminal_turn_count", terminalId: id, turnCount: term.turnCount });
        for (const ws of term.clients) {
          if (ws.readyState === 1) ws.send(msg);
        }
        // Compaction warnings at key thresholds
        if (term.turnCount === 12) {
          const warn = `⚠️ ${p}: 12 turns — context getting large, compaction may happen soon`;
          log("warn", warn, { project: p });
          broadcast({ type: "notification", message: warn, project: p, level: "warning" });
        } else if (term.turnCount === 18) {
          const warn = `🔴 ${p}: 18 turns — context very large, compaction likely imminent. Consider starting a fresh session.`;
          log("warn", warn, { project: p });
          broadcast({ type: "notification", message: warn, project: p, level: "critical" });
        } else if (term.turnCount === 25) {
          const warn = `🔴 ${p}: 25 turns — session is very deep. Strongly recommend starting fresh.`;
          log("warn", warn, { project: p });
          broadcast({ type: "notification", message: warn, project: p, level: "critical" });
        }
        // Write progress snapshot every 5 turns starting at 10
        if (term.turnCount >= 10 && term.turnCount % 5 === 0) {
          writeProgressSnapshot(term).catch(() => {});
        }
      }
    }
  }

  res.json({ ok: true });
});

// ── Delegation Enforcement Endpoints ────────────────────────────────────────

app.post("/api/hook/delegation-check", (req, res) => {
  const { tool, summary, session_id, project } = req.body;
  const result = checkDelegation(session_id, project, tool, summary);
  // Include context percent in response for observability
  result.contextPercent = getSessionContextPercent(session_id, project);
  res.json(result);
});

app.post("/api/hook/delegation-reset", (req, res) => {
  const { session_id, project } = req.body;
  if (!session_id || session_id === "unknown") return res.json({ ok: true });

  let tracker = delegationTrackers.get(session_id);
  if (!tracker) {
    tracker = {
      sessionId: session_id,
      project: project || "unknown",
      implCount: 0,
      isMainAgent: true,
      totalTaskCalls: 1,
      recentImplCalls: [],
      createdAt: new Date().toISOString(),
    };
    delegationTrackers.set(session_id, tracker);
  } else {
    tracker.implCount = 0;
    tracker.isMainAgent = true;
    tracker.totalTaskCalls++;
    tracker.recentImplCalls = [];
  }
  res.json({ ok: true });
});

app.post("/api/hook/notify", (req, res) => {
  const { message, session_id, project } = req.body;
  trackSession(session_id, project);
  const p = project || sessions.get(session_id)?.project || "unknown";
  log("notify", `${message || "Notification"}`, { sessionId: session_id, project: p });
  broadcast({ type: "notification", message, project: p });
  res.json({ ok: true });
});

app.post("/api/hook/question", (req, res) => {
  const { session_id, tool_input, project } = req.body;
  const id = ++questionIdCounter;

  mapSessionToTerminal(session_id, project);

  // Find the terminal for this project/session
  let terminalId = null;
  for (const [tid, term] of terminals) {
    if (term.project === project && term.status === "running") {
      if (term.sessionIds && term.sessionIds.has(session_id)) {
        terminalId = tid;
        break;
      }
      if (terminalId === null) terminalId = tid;
    }
  }

  const questions = tool_input?.questions || [];
  if (questions.length === 0) {
    return res.json({ ok: true, ignored: true });
  }

  const question = {
    id,
    project: project || "unknown",
    sessionId: session_id,
    terminalId,
    questions,
    answers: [],
    currentQuestionIndex: 0,
    status: "waiting_render",
    createdAt: new Date().toISOString(),
    answeredBy: null,
  };

  pendingQuestions.set(id, question);

  log("info", `Question #${id}: ${questions.length} question(s) from AskUserQuestion`,
    { project: question.project });
  broadcast({ type: "question_request", question });

  // Auto-route to AI if configured, with delay for human override
  if (process.env.SUPERVISOR_AUTO_ANSWER_QUESTIONS === "ai") {
    const delayMs = parseInt(process.env.SUPERVISOR_QUESTION_DELAY || "30") * 1000;
    question._aiTimer = setTimeout(() => {
      if (question.status !== "answering" && question.status !== "completed") {
        log("info", `Question #${id}: no human response after ${delayMs/1000}s, routing to AI`, { project: question.project });
        evaluateQuestionWithAI(question)
          .then(answers => {
            if (question.status !== "answering" && question.status !== "completed") {
              question.answers = answers;
              question.answeredBy = "ai";
              question.status = "answering";
              broadcast({ type: "question_ai_answered", id: question.id, answers });
              return injectQuestionAnswers(question);
            }
          })
          .catch(err => {
            log("warn", `Auto AI question eval failed: ${err.message}`, { project: question.project });
            broadcast({ type: "question_ai_error", id: question.id, error: err.message });
          });
      }
    }, delayMs);
  }

  res.json({ id, ok: true });
});

// ─── Usage tracking from Claude Code statusLine hook ────────────────────────
app.post("/api/hook/usage", (req, res) => {
  const data = req.body;
  const sessionId = data.session_id || "unknown";
  const model = data.model?.display_name || data.model?.id || "unknown";
  const ctxWindow = data.context_window || {};
  const totalIn = ctxWindow.total_input_tokens || 0;
  const totalOut = ctxWindow.total_output_tokens || 0;
  const ctxUsed = ctxWindow.used_percentage ?? null;
  const ctxPct = ctxUsed != null ? Math.max(0, 100 - ctxUsed) : null;  // Convert used% → remaining%
  const ctxSize = ctxWindow.context_window_size || 0;
  const cost = data.cost || {};
  const project = data.project || null;

  // Map session to terminal so context % can be matched
  if (project) mapSessionToTerminal(sessionId, project);

  // Update per-session
  sessionUsage.set(sessionId, {
    model, totalInputTokens: totalIn, totalOutputTokens: totalOut,
    contextPct: ctxPct, contextSize: ctxSize,
    linesAdded: cost.total_lines_added || 0,
    linesRemoved: cost.total_lines_removed || 0,
    lastUpdate: Date.now(),
  });

  // Recalculate aggregate (sum across all sessions)
  let aggIn = 0, aggOut = 0;
  for (const [, s] of sessionUsage) {
    aggIn += s.totalInputTokens;
    aggOut += s.totalOutputTokens;
  }
  aggregateUsage = { totalInputTokens: aggIn, totalOutputTokens: aggOut, sessions: sessionUsage.size };

  // Broadcast to web UI
  broadcast({
    type: "usage_update",
    session: { id: sessionId, model, totalInputTokens: totalIn, totalOutputTokens: totalOut, contextPct: ctxPct },
    aggregate: aggregateUsage,
  });

  // Update contextPercent on the matching terminal session so the tab badge shows context %
  if (ctxPct !== null && typeof ctxPct === "number") {
    for (const [, term] of terminals) {
      if (term.mainSessionId === sessionId || (term.sessionIds && term.sessionIds.has(sessionId))) {
        // Detect new session in same terminal — reset stale context percent before applying new value
        if (sessionId && term.mainSessionId && sessionId !== term.mainSessionId && term.sessionIds && term.sessionIds.has(sessionId)) {
          term.contextPercent = null;
          term.mainSessionId = sessionId;
          try { writeFileSync(join(term.projectDir, ".claude", "context-percent.txt"), ""); } catch (e) {}
          console.log(`[usage] ${term.project}: new session ${sessionId} detected in terminal, reset stale context%`);
        }
        term.contextPercent = ctxPct;
        // Persist to disk (same path as the terminal regex path)
        const ctxFile = resolve(term.projectDir, ".claude", "context-percent.txt");
        writeFile(ctxFile, String(ctxPct), "utf-8").catch(() => {});
        // Broadcast terminal_context so the web UI tab badge updates
        broadcast({ type: "terminal_context", terminalId: term.id, project: term.project, contextPercent: ctxPct, snapshotSaved: !!term._snapshotWritten });

        // Predictive context warnings — fire once per threshold per session
        if (!term.contextWarnings) term.contextWarnings = new Set();
        const usedPct = ctxUsed; // ctxUsed is the used percentage (0-100)
        if (usedPct !== null) {
          const THRESHOLDS = [
            {
              pct: 80,
              msg: `Context at 80% used — critical. Commit any uncommitted work. Compaction imminent. Only coordination and Task delegation from here.`,
            },
            {
              pct: 65,
              msg: `Context at 65% used — delegate all new implementation work to subagents. Direct Write/Edit/Bash calls will be denied above 70%.`,
            },
            {
              pct: 50,
              msg: `Context at 50% used — you have room but start planning delegation for heavy implementation work.`,
            },
          ];
          for (const { pct, msg } of THRESHOLDS) {
            if (usedPct >= pct && !term.contextWarnings.has(pct)) {
              term.contextWarnings.add(pct);
              log("warn", `⚠️ ${term.project}: ${msg}`, { project: term.project, sessionId });
              break; // only warn for the highest crossed threshold this update
            }
          }
        }

        break;
      }
    }
  }

  res.json({ ok: true });
});

// ─── Compaction notification ──────────────────────────────────────────────
app.post("/api/hook/compact", (req, res) => {
  const { trigger, session_id, project } = req.body;

  const notification = {
    type: "compaction",
    trigger: trigger || "unknown",
    session_id: session_id || "unknown",
    project: project || "unknown",
    timestamp: new Date().toISOString(),
  };

  console.log(`[compact] ${project}: ${trigger} compaction (session ${session_id})`);

  // Broadcast to web UI
  broadcast({ type: "compaction_warning", ...notification });

  // Add to activity log
  const logEntry = {
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    project: project || "unknown",
    tool: "compaction",
    summary: `Context ${trigger} compaction`,
    session_id: session_id || "unknown",
  };
  logs.push(logEntry);
  if (logs.length > MAX_LOGS) logs.shift();
  broadcast({ type: "log_entry", entry: logEntry });

  // Clear stale context percentage — compaction gives the session a fresh context window
  const compactProject = project || "unknown";
  const session = [...terminals.values()].find(t => t.project === compactProject);
  if (session) {
    session.contextPercent = null;
    session._snapshotWritten = false;
    session._ctxBuf = "";
    writeFile(resolve(session.projectDir, ".claude", "context-percent.txt"), "", "utf-8").catch(() => {});
    broadcast({ type: "terminal_context", terminalId: session.id, project: session.project, contextPercent: null, snapshotSaved: false });
    console.log(`[compact] ${compactProject}: cleared context percentage and snapshot state`);
  }

  res.json({ ok: true });
});

// ── Session Start Hook ───────────────────────────────────────────────────────

app.post("/api/hook/session-start", (req, res) => {
  const { session_id: sessionId, project } = req.body;
  const matchProject = project || null;
  for (const [, term] of terminals) {
    if (matchProject && term.project !== matchProject) continue;
    if (term.contextPercent !== null && term.contextPercent !== undefined) {
      term.contextPercent = null;
      term._snapshotWritten = false;
      try { writeFileSync(join(term.projectDir, ".claude", "context-percent.txt"), ""); } catch (e) {}
      broadcast({ type: "terminal_context", terminalId: term.id, project: term.project, contextPercent: null, snapshotSaved: false });
      console.log(`[session-start] ${term.project}: cleared stale context% on new session${sessionId ? ` (${sessionId})` : ""}`);
    }
    // Update mainSessionId if provided and differs from current
    if (sessionId && term.mainSessionId && sessionId !== term.mainSessionId) {
      term.mainSessionId = sessionId;
      if (term.sessionIds) term.sessionIds.clear();
      term.sessionIds = new Set([sessionId]);
      console.log(`[session-start] ${term.project}: updated mainSessionId to ${sessionId}`);
    }
  }
  res.json({ ok: true });
});

// ── UI Endpoints ────────────────────────────────────────────────────────────

app.post("/api/respond/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const { approved, reason } = req.body;
  const approval = pendingApprovals.get(id);

  if (!approval) return res.status(404).json({ error: "Not found" });

  const wasAiDecided = approval.decidedBy === "ai";
  if (approval.status !== "pending" && !wasAiDecided) {
    return res.status(409).json({ error: "Already decided" });
  }

  const previousStatus = approval.status;
  approval.status = approved ? "approved" : "denied";
  approval.reason = reason || (approved ? "Approved by human" : "Denied by human");
  approval.decidedBy = "human";
  approval.decidedAt = new Date().toISOString();
  evalStats.humanDecisions++;

  if (wasAiDecided) {
    approval.overriddenAi = true;
    log("warn", `Human OVERRODE AI on #${id}: was ${previousStatus}, now ${approval.status}`,
      { project: approval.project });
  } else {
    log(approved ? "ok" : "warn", `#${id} ${approval.status} by human: ${approval.tool}`,
      { project: approval.project });
  }

  broadcast({ type: "approval_resolved", id, status: approval.status, decidedBy: "human" });
  broadcastEvalStats();

  if (pendingApprovals.size > 100) {
    const oldest = [...pendingApprovals.keys()].slice(0, pendingApprovals.size - 100);
    oldest.forEach((k) => pendingApprovals.delete(k));
  }

  res.json({ status: approval.status });
});

app.get("/api/state", (req, res) => {
  const projectFilter = req.query.project;
  let pending = [...pendingApprovals.values()].filter((a) => a.status === "pending");
  let aiResolved = [...pendingApprovals.values()]
    .filter((a) => a.decidedBy === "ai" && !a.polledDecisionAt)
    .slice(-10);
  let recentLogs = logs.slice(-50);

  if (projectFilter) {
    pending = pending.filter((a) => a.project === projectFilter);
    aiResolved = aiResolved.filter((a) => a.project === projectFilter);
    recentLogs = recentLogs.filter((l) => !l.project || l.project === projectFilter);
  }

  res.json({
    pending, aiResolved, recentLogs, agentMessages,
    evalStats, serverStartedAt,
    totalApprovals: approvalIdCounter,
    sessions: Object.fromEntries(sessions),
    supervisor: {
      version: SUPERVISOR_VERSION,
      mode: SUPERVISOR_MODE, model: SUPERVISOR_MODEL, fastModel: SUPERVISOR_FAST_MODEL,
      confidenceThreshold: SUPERVISOR_CONFIDENCE_THRESHOLD,
      escalationThreshold: EVAL_ESCALATION_THRESHOLD,
      activeEvaluations, queueLength: evaluationQueue.length,
      evalBackend: EVAL_BACKEND, ollamaModel: OLLAMA_MODEL, ollamaUrl: OLLAMA_URL,
    },
    claudeVersion,
    coordinatorRequests: Array.from(coordinatorRequests.entries()).map(([id, e]) => serializeCoordinatorEntry(id, e)),
    coordinatorHistory,
    coordinatorInstance: SV_INSTANCE,
    usage: { sessions: Object.fromEntries(sessionUsage), aggregate: aggregateUsage },
    globalRateLimits,
  });
});

app.get("/api/sessions", (req, res) => {
  res.json({
    sessions: [...sessions.entries()].map(([id, info]) => ({ sessionId: id, ...info })),
    projects: [...new Set([...sessions.values()].map((s) => s.project))],
  });
});

// ── Terminal Management ─────────────────────────────────────────────────────

// ─── hook symlink setup ───────────────────────────────────────────────────────

/**
 * Ensure a project has symlinks to the canonical supervisor hooks.
 * Called before spawning a new terminal — safe to call on every launch since
 * it exits early if dynamic-approvals.sh already exists as any file or symlink.
 */
function ensureProjectHooks(projectDir) {
  const canonicalHooks = join(__dirname, "hooks");
  const targetHooksDir = resolve(projectDir, ".claude", "hooks");
  const sentinel = resolve(targetHooksDir, "dynamic-approvals.sh");

  // Already set up — skip
  if (existsSync(sentinel)) return;

  try {
    mkdirSync(targetHooksDir, { recursive: true });

    const hookFiles = readdirSync(canonicalHooks).filter(f => f.endsWith(".sh"));
    for (const file of hookFiles) {
      const src = join(canonicalHooks, file);
      const dest = join(targetHooksDir, file);
      if (!existsSync(dest)) {
        symlinkSync(src, dest);
      }
    }

    console.log(`[hooks] Auto-linked ${hookFiles.length} hook(s) for ${projectDir}`);
  } catch (e) {
    console.warn(`[hooks] Auto-link failed for ${projectDir}: ${e.message}`);
    // Hook setup failure must not prevent terminal spawn
  }
}

// ─── dtach-backed terminal management ────────────────────────────────────────

const DTACH_DIR = process.env.SUPERVISOR_DTACH_DIR || "/tmp";
const SCROLLBACK_LIMIT = 2 * 1024 * 1024; // 2MB ring buffer per terminal

function dtachSocketPath(project) {
  const prefix = `sv${PORT}-`;
  let path = resolve(DTACH_DIR, `${prefix}${project}.sock`);
  let suffix = 1;
  while (existsSync(path)) {
    suffix++;
    path = resolve(DTACH_DIR, `${prefix}${project}-${suffix}.sock`);
  }
  return path;
}

function createDtachSession(project, projectDir, cols, rows, sessionId) {
  const socketPath = dtachSocketPath(project);
  // dtach -c creates + attaches; we use -n to create detached, then attach via PTY
  // -E disables detach character, -z disables suspend
  // detached:true + unref() lets dtach escape the systemd cgroup so it survives server restarts
  const args = ["-n", socketPath, "-Ez", CLAUDE_BINARY];
  if (sessionId) {
    args.push("--session-id", sessionId);
  }
  const child = spawn("dtach", args, {
    cwd: projectDir,
    env: { ...process.env, TERM: "xterm-256color", CLAUDECODE: "", CLAUDE_CODE_TASK_LIST_ID: `task-${project}` },
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  return socketPath;
}

function killDtachSession(socketPath) {
  // Find and kill the dtach process by its socket
  try {
    const out = execFileSync("fuser", [socketPath], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    const pids = out.split(/\s+/).filter(Boolean);
    for (const pid of pids) {
      try { process.kill(parseInt(pid), "SIGTERM"); } catch {}
    }
  } catch {}
  // Clean up socket file
  try { execFileSync("rm", ["-f", socketPath], { stdio: "ignore" }); } catch {}
}

function attachToDtach(session) {
  // Kill stale dtach attach processes from previous server instances
  let stalePids = "";
  try {
    stalePids = execFileSync("pgrep", ["-f", `dtach -a ${session.socketPath}`], { encoding: "utf8" });
  } catch {
    // pgrep exits non-zero when no matches found
  }
  const pids = stalePids.trim().split("\n").filter(Boolean);
  for (const pid of pids) {
    const p = parseInt(pid);
    if (isNaN(p) || p <= 0) continue;
    try {
      process.kill(p, "SIGTERM");
      log("info", `Killed stale dtach attach (PID ${pid}) for ${session.socketPath}`);
    } catch {}
  }

  const shell = pty.spawn("dtach", ["-a", session.socketPath, "-Ez"], {
    name: "xterm-256color",
    cols: session.cols,
    rows: session.rows,
    env: { ...process.env, TERM: "xterm-256color" },
  });

  shell.onData((data) => {
    session.lastOutputAt = Date.now();
    // Accumulate in ring buffer for late-joining clients
    const buf = Buffer.from(data);
    session.scrollback.push(buf);
    session.scrollbackBytes += buf.length;
    while (session.scrollbackBytes > SCROLLBACK_LIMIT && session.scrollback.length > 1) {
      session.scrollbackBytes -= session.scrollback.shift().length;
    }
    const msg = JSON.stringify({ type: "terminal_data", terminalId: session.id, data });
    for (const ws of session.clients) {
      if (ws.readyState === 1) ws.send(msg);
    }

    // Detect context window percentage from Claude Code status line
    // Buffer partial lines to handle fragmented PTY chunks
    session._ctxBuf = (session._ctxBuf || "") + data;
    if (session._ctxBuf.length > 500) session._ctxBuf = session._ctxBuf.slice(-500);
    const stripped = session._ctxBuf.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    const ctxMatch = stripped.match(/Context left[^:]*:\s*(\d+)%/i);
    if (ctxMatch) {
      const pct = parseInt(ctxMatch[1]);
      session.contextPercent = pct;
      session._ctxBuf = "";

      // Persist to disk and broadcast to web UI
      const ctxFile = resolve(session.projectDir, ".claude", "context-percent.txt");
      writeFile(ctxFile, String(pct), "utf-8").catch(() => {});
      broadcast({ type: "terminal_context", terminalId: session.id, project: session.project, contextPercent: pct, snapshotSaved: !!session._snapshotWritten });

      // Write snapshot ONCE on first context percentage detection — if Claude is showing % at all, context is already low
      if (!session._snapshotWritten) {
        session._snapshotWritten = true;
        const level = pct <= 10 ? "critical" : "warning";
        log(level === "critical" ? "warn" : "info", `${session.project}: context at ${pct}% — writing snapshot`, { project: session.project });
        broadcast({ type: "notification", message: `${session.project}: context at ${pct}% — snapshot saved`, project: session.project, level });
        writeProgressSnapshot(session).catch(() => {});
        // Re-broadcast with updated flag
        broadcast({ type: "terminal_context", terminalId: session.id, project: session.project, contextPercent: pct, snapshotSaved: true });
      }
    }

    // Detect /usage rate limit data from Claude Code TUI output
    // Use a separate larger buffer since the /usage TUI is multi-line
    session._usageBuf = (session._usageBuf || "") + data;
    if (session._usageBuf.length > 2000) session._usageBuf = session._usageBuf.slice(-2000);
    const usageStripped = session._usageBuf.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/[█▌░▏▎▍▋▊▉]/g, "");

    // Look for the /usage panel pattern: multiple "X% used" lines
    const usedMatches = [...usageStripped.matchAll(/(\d+)%\s+used/g)];
    const resetMatches = [...usageStripped.matchAll(/Resets?\s+(.+?)(?:\n|$)/g)];

    if (usedMatches.length >= 2) { // At least session + weekly
      const usageData = {
        session: { pct: parseInt(usedMatches[0][1]), reset: resetMatches[0]?.[1]?.trim() || null },
        weekAll: { pct: parseInt(usedMatches[1][1]), reset: resetMatches[1]?.[1]?.trim() || null },
      };
      if (usedMatches[2]) {
        usageData.weekSonnet = { pct: parseInt(usedMatches[2][1]), reset: resetMatches[2]?.[1]?.trim() || null };
      }

      session.rateLimits = usageData;
      session._usageBuf = ""; // Clear after successful parse

      broadcast({
        type: "rate_limits",
        terminalId: session.id,
        project: session.project,
        rateLimits: usageData,
      });
    }
  });

  shell.onExit(({ exitCode }) => {
    // Skip if this PTY belongs to a restarting session (new PTY already attached)
    if (session._restarting) return;

    // Check if dtach socket still exists (session might still be alive)
    if (existsSync(session.socketPath)) {
      // dtach session alive, just our attach died — auto-reattach
      const now = Date.now();
      const lastAttach = session._lastAttachAt || 0;
      if (now - lastAttach < 5000) {
        // Reattach loop detected — give up to avoid infinite recursion
        log("warn", `Terminal #${session.id} attach loop detected, marking as exited`, { project: session.project });
        session.status = "exited";
        session.exitCode = exitCode;
        const msg = JSON.stringify({ type: "terminal_exit", terminalId: session.id, exitCode });
        for (const ws of session.clients) {
          if (ws.readyState === 1) ws.send(msg);
        }
        return;
      }

      try {
        log("warn", `Terminal #${session.id} attach died but dtach alive, reattaching...`, { project: session.project });
        session._lastAttachAt = now;
        session.pty = attachToDtach(session);
        // Force a screen redraw via resize
        setTimeout(() => {
          try { session.pty.resize(session.cols, session.rows); } catch {}
        }, 300);
      } catch (e) {
        log("warn", `Terminal #${session.id} reattach failed: ${e.message}, marking as exited`, { project: session.project });
        session.status = "exited";
        session.exitCode = exitCode;
        const msg = JSON.stringify({ type: "terminal_exit", terminalId: session.id, exitCode });
        for (const ws of session.clients) {
          if (ws.readyState === 1) ws.send(msg);
        }
      }
      return;
    }
    session.status = "exited";
    session.exitCode = exitCode;
    const msg = JSON.stringify({ type: "terminal_exit", terminalId: session.id, exitCode });
    for (const ws of session.clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
    log("info", `Terminal #${session.id} exited (code=${exitCode})`, { project: session.project });
  });

  return shell;
}

function parseDtachProjectName(socketFile) {
  const prefix = `sv${PORT}-`;
  const withoutPrefix = socketFile.slice(prefix.length, -5); // remove prefix and .sock
  // Check if full name matches a project dir
  try { statSync(resolve(PROJECT_ROOT, withoutPrefix)); return withoutPrefix; } catch {}
  // Try removing trailing -N suffix (handles "av-remote-2" → "av-remote")
  const match = withoutPrefix.match(/^(.+)-(\d+)$/);
  if (match) {
    try { statSync(resolve(PROJECT_ROOT, match[1])); return match[1]; } catch {}
  }
  return withoutPrefix;
}

function recoverDtachSessions() {
  const prefix = `sv${PORT}-`;
  let files;
  try {
    files = readdirSync(DTACH_DIR);
  } catch { return; }

  const sockets = files.filter(f => f.startsWith(prefix) && f.endsWith(".sock"));
  for (const f of sockets) {
    const socketPath = resolve(DTACH_DIR, f);
    // Verify socket is alive by checking the file type
    try {
      const s = statSync(socketPath);
      if (!s.isSocket()) continue;
    } catch { continue; }

    const project = parseDtachProjectName(f);
    const projectDir = resolve(PROJECT_ROOT, project);
    try { statSync(projectDir); } catch { continue; }

    // Use socket mtime as session creation time and infer version
    const socketStat = statSync(socketPath);
    const socketCreated = socketStat.birthtimeMs || socketStat.mtimeMs;

    // Note: _snapshotWritten is intentionally NOT recovered from disk.
    // It's a per-context-window flag that prevents duplicate snapshot writes.
    // After server restart, we start fresh — if context gets low again, a new
    // snapshot will be written (which is correct, capturing the current state).

    const ctxFile = resolve(projectDir, ".claude", "context-percent.txt");
    let savedContextPct = null;
    try {
      const ctxStat = statSync(ctxFile);
      const ctxMtime = ctxStat.mtimeMs;
      // If the context file is older than the dtach socket, the Claude Code session
      // was restarted (new context window) and this value is stale — discard it
      if (ctxMtime < socketCreated) {
        log("info", `Discarding stale context-percent.txt for ${project} (file mtime ${new Date(ctxMtime).toISOString()} < socket created ${new Date(socketCreated).toISOString()})`, { project });
        writeFile(ctxFile, "", "utf-8").catch(() => {});
      } else {
        const raw = readFileSync(ctxFile, "utf-8").trim();
        const n = parseInt(raw);
        if (!isNaN(n) && n >= 0 && n <= 100) savedContextPct = n;
      }
    } catch {}

    const id = ++terminalIdCounter;
    const session = {
      id, project, projectDir, socketPath,
      pty: null, clients: new Set(), controller: null,
      createdAt: new Date(socketCreated).toISOString(),
      status: "running", exitCode: null,
      scrollback: [], scrollbackBytes: 0,
      cols: 120, rows: 30,
      turnCount: 0,
      lastOutputAt: Date.now(),
      lastInputAt: null,
      claudeVersion: getVersionAtTime(socketCreated) || claudeVersion.installed,
      contextPercent: savedContextPct,
      _snapshotWritten: false,
    };

    try {
      session.pty = attachToDtach(session);
      terminals.set(id, session);
      // Force a screen redraw by sending SIGWINCH after a brief delay
      // This makes Claude (and any shell prompt) redraw, populating the ring buffer
      setTimeout(() => {
        try { session.pty.resize(session.cols, session.rows); } catch {}
      }, 500);
      log("info", `Recovered dtach session ${f} as terminal #${id}` + (savedContextPct != null ? ` (ctx: ${savedContextPct}%)` : ''), { project });
    } catch (e) {
      log("warn", `Failed to recover dtach session ${f}: ${e.message}`, { project });
    }
  }
}

// Sync hooks + CLAUDE.md for all projects that already have hooks installed
function syncProjectHooks() {
  const setupScript = resolve(__dirname, "setup-project.sh");
  try {
    const entries = readdirSync(PROJECT_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const projectDir = resolve(PROJECT_ROOT, entry.name);
      const hookFile = resolve(projectDir, ".claude", "hooks", "pre-tool-use.sh");
      try {
        statSync(hookFile);
      } catch {
        continue; // No hooks installed — skip
      }
      try {
        execFileSync("bash", [setupScript, projectDir, String(PORT)], {
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        log("info", `Synced hooks + CLAUDE.md for ${entry.name}`);
      } catch (e) {
        log("warn", `Failed to sync ${entry.name}: ${e.message}`);
      }
    }
  } catch (e) {
    log("warn", `Could not scan projects for sync: ${e.message}`);
  }
}

app.get("/api/projects", async (req, res) => {
  try {
    const entries = await readdir(PROJECT_ROOT, { withFileTypes: true });
    const projects = [];
    for (const entry of entries) {
      if ((entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith(".")) {
        projects.push(entry.name);
      }
    }
    projects.sort();
    res.json({ projects, projectRoot: PROJECT_ROOT });
  } catch (err) {
    res.status(500).json({ error: "Failed to list projects: " + err.message });
  }
});

app.post("/api/projects", (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== "string") return res.status(400).json({ error: "Project name is required" });
  if (!name || name.startsWith(".") || name.includes("..") || name.includes("/")) {
    return res.status(400).json({ error: "Invalid project name" });
  }
  const projectDir = resolve(PROJECT_ROOT, name);
  if (existsSync(projectDir)) return res.status(409).json({ error: "Project already exists" });
  try {
    mkdirSync(projectDir, { recursive: true });
    res.json({ success: true, project: name });
  } catch (err) {
    res.status(500).json({ error: "Failed to create project: " + err.message });
  }
});

app.get("/api/terminals", (req, res) => {
  res.json({
    terminals: [...terminals.values()].map((t) => ({
      id: t.id, project: t.project, status: t.status,
      createdAt: t.createdAt, exitCode: t.exitCode, turnCount: t.turnCount,
      claudeVersion: t.claudeVersion || null,
      claudeSessionId: t.claudeSessionId || null,
      contextPercent: t.contextPercent ?? null,
      snapshotSaved: !!t._snapshotWritten,
      rateLimits: t.rateLimits || null,
      clientCount: t.clients.size, hasController: !!t.controller,
      lastOutputAt: t.lastOutputAt || null,
      lastInputAt: t.lastInputAt || null,
    })),
    maxTerminals: MAX_TERMINALS,
  });
});

app.post("/api/terminals", async (req, res) => {
  const { project } = req.body;
  if (!project || project.includes("..") || project.includes("/")) {
    return res.status(400).json({ error: "Invalid project name" });
  }
  if (terminals.size >= MAX_TERMINALS) {
    return res.status(429).json({ error: `Max ${MAX_TERMINALS} terminals reached` });
  }

  const projectDir = resolve(PROJECT_ROOT, project);

  // Verify directory exists
  try {
    const s = statSync(projectDir);
    if (!s.isDirectory()) throw new Error("Not a directory");
  } catch {
    return res.status(404).json({ error: `Project directory not found: ${project}` });
  }

  // Symlink canonical supervisor hooks if missing
  ensureProjectHooks(projectDir);

  // Auto-setup hooks config if settings.json missing (hook scripts alone aren't enough)
  try {
    statSync(resolve(projectDir, ".claude", "settings.json"));
  } catch {
    log("info", `Auto-setting up supervisor hooks...`, { project });
    try {
      const setupScript = resolve(__dirname, "setup-project.sh");
      execFileSync("bash", [setupScript, projectDir, String(PORT)], { timeout: 10000 });
      log("info", `Hooks installed`, { project });
    } catch (e) {
      log("warn", `Auto-setup failed: ${e.message}`, { project });
      // Continue anyway — terminal still works, just without supervisor
    }
  }

  const id = ++terminalIdCounter;
  const cols = 120, rows = 30;
  const claudeSessionId = randomUUID();
  let socketPath;
  try {
    socketPath = createDtachSession(project, projectDir, cols, rows, claudeSessionId);
  } catch (e) {
    return res.status(500).json({ error: "Failed to create dtach session: " + e.message });
  }

  const session = {
    id, project, projectDir, socketPath,
    pty: null, clients: new Set(), controller: null,
    createdAt: new Date().toISOString(),
    status: "running", exitCode: null,
    scrollback: [], scrollbackBytes: 0,
    cols, rows,
    turnCount: 0,
    lastOutputAt: Date.now(),
    lastInputAt: null,
    claudeVersion: claudeVersion.installed,
    claudeSessionId,
    sessionIds: new Set([claudeSessionId]),
    mainSessionId: claudeSessionId,
  };

  // Small delay for dtach to initialize before attaching
  await new Promise(r => setTimeout(r, 200));
  session.pty = attachToDtach(session);
  terminals.set(id, session);
  log("info", `Terminal #${id} launched (dtach: ${socketPath}, session: ${claudeSessionId})`, { project });

  // Notify all WS clients about new terminal
  broadcast({ type: "terminal_opened", terminal: { id, project, status: "running", createdAt: session.createdAt, claudeSessionId } });

  res.json({ id, project, status: "running", claudeSessionId });
});

app.post("/api/terminals/:id/restart", async (req, res) => {
  const id = parseInt(req.params.id);
  const session = terminals.get(id);
  if (!session) return res.status(404).json({ error: "Terminal not found" });

  const snapshotPath = resolve(session.projectDir, ".claude", "progress-snapshot.md");
  const snapshotBefore = await stat(snapshotPath).then(s => s.mtimeMs).catch(() => 0);

  // Write server-side snapshot before restart (agent PTY injection is unreliable)
  if (session.pty && session.status === "running") {
    log("info", `Writing progress snapshot before restart`, { project: session.project });
    broadcast({ type: "notification", message: `${session.project}: saving context before restart...`, project: session.project, level: "info" });
    try { await writeProgressSnapshot(session); } catch {}
  } else {
    try { await writeProgressSnapshot(session); } catch {}
  }

  // Fail any pending questions for this terminal — the old Claude process is going away
  for (const [qid, q] of pendingQuestions) {
    if (q.terminalId === id && q.status !== "completed" && q.status !== "failed") {
      if (q._aiTimer) { clearTimeout(q._aiTimer); q._aiTimer = null; }
      q.status = "failed";
      log("info", `Question #${qid} failed: terminal restarted`, { project: session.project });
      broadcast({ type: "question_failed", id: qid, reason: "Terminal restarted" });
    }
  }

  // Flag to prevent old PTY onExit/onData handlers from firing during restart
  session._restarting = true;

  // Kill existing dtach session and PTY attach
  killDtachSession(session.socketPath);
  try { session.pty.kill(); } catch {}

  // Reset state
  session.status = "running";
  session.exitCode = null;
  session.scrollback = [];
  session.scrollbackBytes = 0;
  session.turnCount = 0;
  session.contextPercent = null;
  session._snapshotWritten = false;
  session._ctxBuf = "";
  session.claudeVersion = claudeVersion.installed;
  session.createdAt = new Date().toISOString();
  session.claudeSessionId = randomUUID();
  session.sessionIds = new Set([session.claudeSessionId]);
  session.mainSessionId = session.claudeSessionId;
  // Clear persisted context file for fresh session
  const ctxResetFile = resolve(session.projectDir, ".claude", "context-percent.txt");
  writeFile(ctxResetFile, "", "utf-8").catch(() => {});

  // Create fresh dtach session and reattach
  try {
    session.socketPath = createDtachSession(session.project, session.projectDir, session.cols, session.rows, session.claudeSessionId);
  } catch (e) {
    return res.status(500).json({ error: "Failed to create dtach session: " + e.message });
  }
  await new Promise(r => setTimeout(r, 200));
  session.pty = attachToDtach(session);
  session._restarting = false;
  log("info", `Terminal #${id} restarted (dtach: ${session.socketPath}, session: ${session.claudeSessionId})`, { project: session.project });

  // SessionStart hook handles snapshot injection natively — no PTY injection needed

  // Notify all clients with updated terminal metadata
  broadcast({
    type: "terminal_restarted",
    terminalId: id,
    claudeVersion: session.claudeVersion,
    claudeSessionId: session.claudeSessionId,
    turnCount: session.turnCount,
    createdAt: session.createdAt,
  });

  res.json({ id, project: session.project, status: "running", claudeVersion: session.claudeVersion, claudeSessionId: session.claudeSessionId });
});

app.delete("/api/terminals/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const session = terminals.get(id);
  if (!session) return res.status(404).json({ error: "Terminal not found" });

  // Kill dtach session and PTY attach
  killDtachSession(session.socketPath);
  try { session.pty.kill(); } catch {}

  // Notify clients
  const msg = JSON.stringify({ type: "terminal_closed", terminalId: id });
  for (const ws of session.clients) {
    if (ws.readyState === 1) ws.send(msg);
  }

  terminals.delete(id);
  log("info", `Terminal #${id} closed`, { project: session.project });
  res.json({ ok: true });
});

app.post("/api/projects/:name/teardown", (req, res) => {
  const project = req.params.name;
  if (!project || project.includes("..") || project.includes("/")) {
    return res.status(400).json({ error: "Invalid project name" });
  }

  const projectDir = resolve(PROJECT_ROOT, project);
  try {
    const s = statSync(projectDir);
    if (!s.isDirectory()) throw new Error("Not a directory");
  } catch {
    return res.status(404).json({ error: `Project directory not found: ${project}` });
  }

  try {
    const teardownScript = resolve(__dirname, "teardown-project.sh");
    execFileSync("bash", [teardownScript, projectDir], { timeout: 10000 });
    log("info", `Supervisor hooks removed`, { project });
    res.json({ ok: true, project });
  } catch (e) {
    log("warn", `Teardown failed: ${e.message}`, { project });
    res.status(500).json({ error: "Teardown failed: " + e.message });
  }
});

// ─── Atomic Chat Sequence Numbers ────────────────────────────────────────────

const chatSeqCounters = new Map(); // room -> current seq (0-based, next call returns 1)

app.post("/api/chat/seq", (req, res) => {
  const { room } = req.body;
  if (!room || typeof room !== "string") {
    return res.status(400).json({ error: "room (string) required" });
  }
  const current = chatSeqCounters.get(room) || 0;
  const next = current + 1;
  chatSeqCounters.set(room, next);
  res.json({ seq: next });
});

// ─── MQTT Publish ────────────────────────────────────────────────────────────

app.post("/api/mqtt/publish", (req, res) => {
  const { topic, payload } = req.body;
  if (!topic || payload === undefined) {
    return res.status(400).json({ error: "topic and payload required" });
  }
  const message = typeof payload === "string" ? payload : JSON.stringify(payload);
  mqttPublish(["-t", topic, "-m", message], (err) => {
    if (err) {
      log("warn", `MQTT publish failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
    res.json({ ok: true });
  });
});

// ─── Team Chat API ───────────────────────────────────────────────────────────

app.get("/api/team-chat", (req, res) => {
  const project = req.query.project || "general";
  const messages = teamChatMessages.get(project) || [];
  res.json({ messages, rooms: [...teamChatMessages.keys()] });
});

app.post("/api/team-chat", (req, res) => {
  const { user, message, project } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: "Message required" });

  const room = project || "general";
  const entry = {
    id: randomUUID(),
    user: user || SV_INSTANCE,
    message: message.trim(),
    project: room,
    instance: SV_INSTANCE,
    timestamp: new Date().toISOString(),
  };

  // Publish to MQTT (retained so other instances get it on connect)
  mqttPublish(["-r", "-t", `teamchat/${room}/${entry.id}`, "-m", JSON.stringify(entry)], (err) => {
    if (err) log("warn", `Failed to publish team chat: ${err.message}`);
  });

  res.json(entry);
});

// ─── Document Viewer API ─────────────────────────────────────────────────────

app.get("/api/projects/all", async (req, res) => {
  const all = new Set();
  // Local projects
  try {
    const entries = await readdir(PROJECT_ROOT, { withFileTypes: true });
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".")) all.add(e.name);
  } catch {}
  // Peer projects
  for (const [, peerUrl] of SUPERVISOR_PEERS) {
    try {
      const r = await fetch(`${peerUrl}/api/projects`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) { const d = await r.json(); (d.projects || []).forEach(p => all.add(p)); }
    } catch {}
  }
  res.json({ projects: [...all].sort() });
});

function resolveProjectDir(project) {
  // Check running terminals first
  for (const [, term] of terminals) {
    if (term.project === project) return term.projectDir;
  }
  // Fall back to project root
  const dir = resolve(PROJECT_ROOT, project);
  try { statSync(dir); return dir; } catch { return null; }
}

app.get("/api/docs/:project", async (req, res) => {
  const project = req.params.project;
  const projectDir = resolveProjectDir(project);
  if (projectDir) {
    const docsDir = resolve(projectDir, "docs");
    try {
      const files = readdirSync(docsDir)
        .filter(f => f.endsWith(".md"))
        .map(f => ({ name: f, path: `docs/${f}` }));
      return res.json({ project, docs: files });
    } catch {
      return res.json({ project, docs: [] });
    }
  }
  // Try peer supervisors
  for (const [, peerUrl] of SUPERVISOR_PEERS) {
    try {
      const r = await fetch(`${peerUrl}/api/docs/${encodeURIComponent(project)}`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return res.json(await r.json());
    } catch {}
  }
  res.status(404).json({ error: "Project not found" });
});

app.get("/api/docs/:project/:filename", async (req, res) => {
  const { project, filename } = req.params;
  // Sanitize filename - no path traversal
  if (filename.includes("..") || filename.includes("/") || !filename.endsWith(".md")) {
    return res.status(400).json({ error: "Invalid filename" });
  }
  const projectDir = resolveProjectDir(project);
  if (projectDir) {
    const filePath = resolve(projectDir, "docs", filename);
    try {
      const content = readFileSync(filePath, "utf-8");
      return res.json({ project, filename, content });
    } catch {}
  }
  // Try peer supervisors
  for (const [, peerUrl] of SUPERVISOR_PEERS) {
    try {
      const r = await fetch(`${peerUrl}/api/docs/${encodeURIComponent(project)}/${encodeURIComponent(filename)}`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return res.json(await r.json());
    } catch {}
  }
  res.status(404).json({ error: "Document not found" });
});

// ─── Coordinator API ─────────────────────────────────────────────────────────

app.get("/api/coordinator/requests", (req, res) => {
  const active = Array.from(coordinatorRequests.entries()).map(([id, entry]) => serializeCoordinatorEntry(id, entry));
  res.json({ active, history: coordinatorHistory, instance: SV_INSTANCE });
});

app.get("/api/eval-history", async (req, res) => {
  const historyPath = join(__dirname, "logs", "eval-history.jsonl");
  try {
    const raw = await readFile(historyPath, "utf-8");
    let entries = raw.trim().split("\n").filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    const { project, decision } = req.query;
    if (project) entries = entries.filter(e => e.project === project);
    if (decision) entries = entries.filter(e => e.decision === decision);

    // Return newest first, capped at 200
    entries = entries.slice(-200).reverse();
    res.json(entries);
  } catch (e) {
    if (e.code === "ENOENT") return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/eval-patterns", (req, res) => {
  res.json(evalPatternSuggestions.slice(-10));
});

app.post("/api/coordinator/request", (req, res) => {
  if (!COORDINATOR_ENABLED) {
    return res.status(503).json({ error: "Coordinator not enabled" });
  }

  const { description, target_project, type, context, priority, timeout } = req.body;
  if (!description) {
    return res.status(400).json({ error: "description is required" });
  }

  const requestId = randomUUID();
  const request = {
    id: requestId,
    from: { instance: SV_INSTANCE, project: "web-ui", agent: "human" },
    type: type || "research",
    description,
    context: context || "",
    target_project: target_project || "",
    priority: priority || "normal",
    timeout: timeout || 300,
    timestamp: new Date().toISOString(),
  };

  // Publish to MQTT
  const mqttTopic = `coordinator/${SV_INSTANCE}/requests/${requestId}`;
  mqttPublish([
    "-r",
    "-t", mqttTopic,
    "-m", JSON.stringify(request),
  ], (err) => {
    if (err) {
      return res.status(500).json({ error: "Failed to publish request" });
    }
    res.json({ id: requestId, topic: mqttTopic });
  });
});

app.post("/api/coordinator/dispatch/:id", (req, res) => {
  const { id } = req.params;
  const entry = coordinatorRequests.get(id);
  if (!entry) {
    return res.status(404).json({ error: "Request not found" });
  }

  const { project } = req.body;
  if (project) {
    entry.request.target_project = project;
  }

  dispatchToAgent(id, entry.request);
  res.json({ status: "dispatched" });
});

app.post("/api/coordinator/cancel/:id", (req, res) => {
  const { id } = req.params;
  const entry = coordinatorRequests.get(id);
  if (!entry) {
    return res.status(404).json({ error: "Request not found" });
  }

  entry.status = "cancelled";
  entry.updatedAt = new Date().toISOString();

  broadcast({
    type: "coordinator_response",
    id,
    status: "cancelled",
  });

  // Clear retained MQTT message
  mqttPublish(["-r", "-n", "-t", `coordinator/${SV_INSTANCE}/requests/${id}`]);

  archiveRequest(id);
  res.json({ status: "cancelled" });
});

// ─── Housekeeping Endpoint ───────────────────────────────────────────────────
app.post("/api/housekeeping/run", (req, res) => {
  runHousekeeping();
  res.json({ status: "started" });
});

app.post("/api/reload-policy", async (req, res) => {
  await loadPolicy();
  broadcast({ type: "policy-reloaded", timestamp: new Date().toISOString() });
  res.json({ status: "reloaded" });
});

// ─── Version Endpoints ────────────────────────────────────────────────────
app.get("/api/version/pending", (req, res) => {
  if (!STARTUP_COMMIT) return res.json({ changes: [], behindBy: 0, startupCommit: "" });
  try {
    const currentHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: __dirname, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (currentHead === STARTUP_COMMIT) return res.json({ changes: [], behindBy: 0, startupCommit: STARTUP_COMMIT.slice(0, 7) });
    const log = execFileSync("git", ["log", "--oneline", `${STARTUP_COMMIT}..HEAD`], { cwd: __dirname, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const changes = log ? log.split("\n").map(line => {
      const spaceIdx = line.indexOf(" ");
      return { hash: line.slice(0, spaceIdx), message: line.slice(spaceIdx + 1) };
    }) : [];
    res.json({ changes, behindBy: changes.length, startupCommit: STARTUP_COMMIT.slice(0, 7), currentHead: currentHead.slice(0, 7) });
  } catch (err) {
    res.json({ changes: [], behindBy: 0, error: err.message });
  }
});

app.post("/api/version/check", async (req, res) => {
  await pollClaudeVersion();
  broadcast({ type: "claude_version", ...claudeVersion });
  res.json(claudeVersion);
});

app.get("/api/version/release-notes", async (req, res) => {
  const version = req.query.version || claudeVersion.latest;
  if (!version) return res.json({ notes: null });
  try {
    const ghRes = await fetch(
      `https://api.github.com/repos/anthropics/claude-code/releases/tags/v${version}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!ghRes.ok) return res.json({ notes: null, version });
    const release = await ghRes.json();
    res.json({
      version,
      notes: release.body || null,
      url: release.html_url || null,
      publishedAt: release.published_at || null,
    });
  } catch {
    res.json({ notes: null, version });
  }
});

app.post("/api/version/update", async (req, res) => {
  log("info", "Starting Claude Code update...");
  broadcast({ type: "notification", message: "Starting Claude Code update. Active sessions will be stopped.", level: "warning" });

  const running = [...terminals.values()].filter(t => t.status === "running" && t.pty);
  for (const term of running) {
    try {
      term.pty.write("\x03");
      await new Promise(r => setTimeout(r, 500));
      term.pty.write("/exit\r");
      log("info", `Sent /exit to terminal #${term.id} (${term.project})`);
    } catch (e) {
      log("warn", `Failed to stop terminal #${term.id}: ${e.message}`);
    }
  }

  if (running.length > 0) await new Promise(r => setTimeout(r, 5000));

  try {
    const out = execFileSync(CLAUDE_BINARY, ["update"], {
      env: { ...process.env, CLAUDECODE: "" },
      timeout: 120000,
      encoding: "utf-8",
    });
    log("info", `Claude update output: ${out.trim()}`);
  } catch (e) {
    log("error", `Claude update failed: ${e.message}`);
    return res.status(500).json({ error: "Update failed: " + e.message });
  }

  const newVersion = getInstalledVersion();
  claudeVersion.installed = newVersion;
  claudeVersion.updateAvailable = !!(claudeVersion.latest && newVersion !== claudeVersion.latest);
  broadcast({ type: "claude_version", ...claudeVersion });
  broadcast({ type: "notification", message: `Claude Code updated to ${newVersion}. Restart sessions for the new version.`, level: "info" });
  log("info", `Claude Code updated to ${newVersion}`);
  res.json({ installed: newVersion, latest: claudeVersion.latest, updateAvailable: claudeVersion.updateAvailable });
});

app.get("/", (req, res) => res.type("html").send(WEB_UI));
app.get("/docs/usage-guide.html", (req, res) => res.type("html").send(USAGE_GUIDE));

// ── WebSocket ───────────────────────────────────────────────────────────────

wss.on("connection", (ws) => {
  wsClients.add(ws);
  log("info", `Client connected (${wsClients.size} total)`);

  const pending = [...pendingApprovals.values()].filter((a) => a.status === "pending");
  const aiResolved = [...pendingApprovals.values()]
    .filter((a) => a.decidedBy === "ai" && !a.polledDecisionAt).slice(-10);
  const projects = [...new Set([...sessions.values()].map((s) => s.project))];
  const pendingQs = [...pendingQuestions.values()].filter(q => q.status !== "completed" && q.status !== "failed");

  try {
    ws.send(JSON.stringify({
      type: "init", pending, aiResolved, recentLogs: logs.slice(-30), projects,
      pendingQuestions: pendingQs, agentMessages,
      teamChat: Object.fromEntries([...teamChatMessages.entries()].map(([room, msgs]) => [room, msgs.slice(-50)])),
      evalStats, serverStartedAt,
      supervisor: {
        version: SUPERVISOR_VERSION, startupCommit: STARTUP_COMMIT.slice(0, 7),
        mode: SUPERVISOR_MODE, model: SUPERVISOR_MODEL, fastModel: SUPERVISOR_FAST_MODEL,
        confidenceThreshold: SUPERVISOR_CONFIDENCE_THRESHOLD,
        escalationThreshold: EVAL_ESCALATION_THRESHOLD,
        evalBackend: EVAL_BACKEND, ollamaModel: OLLAMA_MODEL, ollamaUrl: OLLAMA_URL,
      },
      terminals: [...terminals.values()].map((t) => ({
        id: t.id, project: t.project, status: t.status,
        createdAt: t.createdAt, exitCode: t.exitCode, turnCount: t.turnCount,
        lastOutputAt: t.lastOutputAt || null,
        lastInputAt: t.lastInputAt || null,
        claudeVersion: t.claudeVersion || null,
        claudeSessionId: t.claudeSessionId || null,
        contextPercent: t.contextPercent ?? null,
        snapshotSaved: !!t._snapshotWritten,
        rateLimits: t.rateLimits || null,
      })),
      claudeStatus: claudeApiStatus,
      claudeVersion,
      coordinatorRequests: Array.from(coordinatorRequests.entries()).map(([id, e]) => serializeCoordinatorEntry(id, e)),
      coordinatorHistory,
      coordinatorInstance: SV_INSTANCE,
      usage: { sessions: Object.fromEntries(sessionUsage), aggregate: aggregateUsage },
      globalRateLimits,
    }));
  } catch (err) {
    log("warn", `Failed to send init: ${err.message}`);
  }

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      switch (msg.type) {
        case "respond": {
          const approval = pendingApprovals.get(msg.id);
          if (!approval) return;
          const wasAi = approval.decidedBy === "ai";
          if (approval.status !== "pending" && !wasAi) return;

          approval.status = msg.approved ? "approved" : "denied";
          approval.reason = msg.reason || (msg.approved ? "Approved by human" : "Denied by human");
          approval.decidedBy = "human";
          approval.decidedAt = new Date().toISOString();
          if (wasAi) approval.overriddenAi = true;
          evalStats.humanDecisions++;

          log(wasAi ? "warn" : (msg.approved ? "ok" : "warn"),
            `[${approval.project}] ${wasAi ? "Human OVERRODE AI" : "#" + msg.id + " " + approval.status}: ${approval.tool}`,
            { project: approval.project });
          broadcast({ type: "approval_resolved", id: msg.id, status: approval.status, decidedBy: "human" });
          broadcastEvalStats();
          break;
        }

        case "question_answer": {
          const question = pendingQuestions.get(msg.questionId);
          if (!question || question.status === "completed" || question.status === "answering") break;

          if (question._aiTimer) { clearTimeout(question._aiTimer); question._aiTimer = null; }
          question.answers = msg.answers;
          question.answeredBy = "human";
          question.status = "answering";

          log("info", `Question #${msg.questionId}: answered by human`, { project: question.project });
          broadcast({ type: "question_answered", id: msg.questionId, answers: msg.answers, answeredBy: "human" });
          injectQuestionAnswers(question).catch(err => log("warn", "Question injection failed", { error: err.message }));
          break;
        }

        case "question_ai_decide": {
          const question = pendingQuestions.get(msg.questionId);
          if (!question || question.status === "completed" || question.status === "answering") break;

          if (question._aiTimer) { clearTimeout(question._aiTimer); question._aiTimer = null; }
          broadcast({ type: "question_ai_evaluating", id: msg.questionId });

          evaluateQuestionWithAI(question)
            .then(answers => {
              if (question.status !== "answering" && question.status !== "completed") {
                question.answers = answers;
                question.answeredBy = "ai";
                question.status = "answering";
                broadcast({ type: "question_ai_answered", id: msg.questionId, answers });
                return injectQuestionAnswers(question);
              }
            })
            .catch(err => {
              log("warn", `AI question eval failed: ${err.message}`, { project: question.project });
              broadcast({ type: "question_ai_error", id: msg.questionId, error: err.message });
            });
          break;
        }

        case "terminal_subscribe": {
          const term = terminals.get(msg.terminalId);
          if (!term) break;
          // Verify current controller is still alive before assigning
          if (term.controller && term.controller.readyState !== 1) {
            term.controller = null;
          }
          const isController = !term.controller;
          if (isController) term.controller = ws;
          // Replay the ring buffer so late-joining clients see recent output.
          // With dtach, this is raw sequential terminal output (not cursor-addressed
          // tmux painting), so replaying into a fresh xterm.js works correctly.
          // Skip replay on reconnect if client already has content (prevents duplication + scroll reset).
          if (term.scrollback.length > 0 && !msg.skipScrollback) {
            const combined = Buffer.concat(term.scrollback).toString();
            ws.send(JSON.stringify({ type: "terminal_scrollback", terminalId: msg.terminalId, data: combined }));
          }
          // NOW add to clients so live terminal_data starts flowing
          term.clients.add(ws);
          ws.send(JSON.stringify({ type: "terminal_controller", terminalId: msg.terminalId, isController }));
          if (term.status === "exited") {
            ws.send(JSON.stringify({ type: "terminal_exit", terminalId: msg.terminalId, exitCode: term.exitCode }));
          }
          break;
        }

        case "terminal_unsubscribe": {
          const term = terminals.get(msg.terminalId);
          if (!term) break;
          term.clients.delete(ws);
          if (term.controller === ws) {
            term.controller = term.clients.values().next().value || null;
            if (term.controller) {
              term.controller.send(JSON.stringify({ type: "terminal_controller", terminalId: msg.terminalId, isController: true }));
            }
          }
          break;
        }

        case "terminal_input": {
          const term = terminals.get(msg.terminalId);
          if (term && term.status === "running" && term.controller === ws) {
            term.lastInputAt = Date.now();
            term.pty.write(msg.data);
          }
          break;
        }

        case "terminal_escape": {
          const term = terminals.get(msg.terminalId);
          if (term && term.status === "running") {
            term.pty.write("\x1b");
            log("warn", `Escape sent to terminal ${msg.terminalId} (session rescue)`, { project: term.project });
            broadcast({ type: "terminal_rescued", terminalId: msg.terminalId });
          }
          break;
        }

        case "image_drop": {
          try {
            if (!msg.data || typeof msg.data !== "string") break;
            if (msg.data.length > 10 * 1024 * 1024 * 4 / 3) { // ~10MB base64
              ws.send(JSON.stringify({ type: "error", message: "Image too large (max 10MB)" }));
              break;
            }
            // Determine project directory from the active terminal
            const dropTerm = msg.terminalId ? terminals.get(msg.terminalId) : null;
            const projectDir = dropTerm ? dropTerm.projectDir : null;
            if (!projectDir) {
              ws.send(JSON.stringify({ type: "error", message: "No active terminal to receive image" }));
              break;
            }
            // Sanitize filename: strip path components and non-safe chars
            const rawName = (msg.filename || "image.png").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "_");
            const safeName = rawName.slice(0, 80);
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const fileName = `${timestamp}-${safeName}`;
            const screenshotsDir = join(projectDir, "screenshots");
            mkdirSync(screenshotsDir, { recursive: true });
            const filePath = join(screenshotsDir, fileName);
            const imageBuffer = Buffer.from(msg.data, "base64");
            writeFileSync(filePath, imageBuffer);
            log("info", `Image saved: ${filePath}`, { project: dropTerm.project });
            // Inject file path into PTY (with trailing space so user can append prompt)
            if (dropTerm.status === "running" && dropTerm.pty) {
              dropTerm.pty.write(filePath + " ");
            }
            ws.send(JSON.stringify({ type: "image_drop_saved", filePath }));
          } catch (err) {
            log("error", `image_drop error: ${err.message}`);
            ws.send(JSON.stringify({ type: "error", message: "Failed to save image: " + err.message }));
          }
          break;
        }

        case "file_drop": {
          try {
            if (!msg.data || typeof msg.data !== "string") break;
            if (msg.data.length > 1 * 1024 * 1024) {
              ws.send(JSON.stringify({ type: "error", message: "Text file too large (max 1MB)" }));
              break;
            }
            const dropTerm = msg.terminalId ? terminals.get(msg.terminalId) : null;
            const projectDir = dropTerm ? dropTerm.projectDir : null;
            if (!projectDir) {
              ws.send(JSON.stringify({ type: "error", message: "No active terminal to receive file" }));
              break;
            }
            const rawName = (msg.filename || "file.txt").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "_");
            const safeName = rawName.slice(0, 80);
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const fileName = `${timestamp}-${safeName}`;
            const dropsDir = join(projectDir, "drops");
            mkdirSync(dropsDir, { recursive: true });
            const filePath = join(dropsDir, fileName);
            writeFileSync(filePath, msg.data, "utf8");
            log("info", `File saved: ${filePath}`, { project: dropTerm.project });
            if (dropTerm.status === "running" && dropTerm.pty) {
              dropTerm.pty.write(filePath + " ");
            }
            ws.send(JSON.stringify({ type: "file_drop_saved", filePath }));
          } catch (err) {
            log("error", `file_drop error: ${err.message}`);
            ws.send(JSON.stringify({ type: "error", message: "Failed to save file: " + err.message }));
          }
          break;
        }

        case "terminal_take_control": {
          const term = terminals.get(msg.terminalId);
          if (term && term.clients.has(ws)) {
            const prev = term.controller;
            term.controller = ws;
            ws.send(JSON.stringify({ type: "terminal_controller", terminalId: msg.terminalId, isController: true }));
            if (prev && prev !== ws && prev.readyState === 1) {
              prev.send(JSON.stringify({ type: "terminal_controller", terminalId: msg.terminalId, isController: false }));
            }
          }
          break;
        }

        case "terminal_resize": {
          const term = terminals.get(msg.terminalId);
          if (!term || !term.clients.has(ws)) break;
          if (term.status === "running") {
            const cols = Math.max(10, Math.min(300, msg.cols || 120));
            const rows = Math.max(5, Math.min(100, msg.rows || 30));
            term.pty.resize(cols, rows);
            term.cols = cols;
            term.rows = rows;
          }
          break;
        }

        case "coordinator_cancel": {
          const cancelEntry = coordinatorRequests.get(msg.id);
          if (cancelEntry) {
            cancelEntry.status = "cancelled";
            cancelEntry.updatedAt = new Date().toISOString();
            broadcast({ type: "coordinator_response", id: msg.id, status: "cancelled" });
            mqttPublish(["-r", "-n", "-t", `coordinator/${SV_INSTANCE}/requests/${msg.id}`]);
            archiveRequest(msg.id);
          }
          break;
        }
      }
    } catch (err) {
      log("warn", `WS message error: ${err.message}`);
    }
  });

  ws.on("close", () => {
    wsClients.delete(ws);
    // Clean up terminal subscriptions
    for (const [id, term] of terminals) {
      term.clients.delete(ws);
      if (term.controller === ws) {
        term.controller = term.clients.values().next().value || null;
        if (term.controller) {
          term.controller.send(JSON.stringify({ type: "terminal_controller", terminalId: id, isController: true }));
        }
      }
    }
    log("info", `Client disconnected (${wsClients.size} total)`);
  });
});

// ─── Coordinator Functions ───────────────────────────────────────────────────

function archiveRequest(requestId) {
  const entry = coordinatorRequests.get(requestId);
  if (!entry) return;
  if (entry.timeoutTimer) {
    clearTimeout(entry.timeoutTimer);
    entry.timeoutTimer = null;
  }
  coordinatorHistory.push({ id: requestId, ...entry });
  if (coordinatorHistory.length > MAX_COORDINATOR_HISTORY) coordinatorHistory.shift();
  coordinatorRequests.delete(requestId);
}

async function dispatchToAgent(requestId, request) {
  const entry = coordinatorRequests.get(requestId);
  if (!entry) {
    log("warn", `[coordinator] dispatchToAgent: request ${requestId} not found in coordinatorRequests`);
    return;
  }

  // Find the project directory - check terminals for a matching project
  const targetProject = request.target_project;
  let projectDir = null;

  // First check terminals for the project directory
  for (const [, s] of terminals) {
    if (s.project === targetProject && s.projectDir) {
      projectDir = s.projectDir;
      break;
    }
  }

  // Fallback: try common project roots
  if (!projectDir) {
    const projectRoot = process.env.SUPERVISOR_PROJECT_ROOT || join(os.homedir(), "projects");
    const candidatePath = join(projectRoot, targetProject);
    try {
      await stat(candidatePath);
      projectDir = candidatePath;
    } catch {
      log("warn", `[coordinator] No project directory found for '${targetProject}', request #${requestId} stays pending`);
      return;
    }
  }

  // Mark as dispatched
  entry.status = "dispatched";
  entry.dispatchedAt = new Date().toISOString();
  entry.updatedAt = new Date().toISOString();
  broadcast({ type: "coordinator_dispatched", id: requestId, status: "dispatched" });

  log("info", `[coordinator] Dispatching #${requestId} to ephemeral agent in ${projectDir}`);

  // Build the prompt
  const type = request.type || "research";

  // Plan/feasibility types get the Moltke adversarial review pattern:
  // 1. Run planner agent first, 2. Feed result to Moltke agent, 3. Return combined report
  if (type === "plan" || type === "feasibility") {
    return dispatchMoltkeRequest(requestId, request, projectDir);
  }

  // Debate type gets structured 3-agent debate: moderator + PRO + CON
  if (type === "debate") {
    return dispatchDebate(requestId, request, projectDir);
  }

  const systemContext = `You are a coordinator helper agent. A remote agent has requested your help with a ${type} task in this project. Be concise and focused. Report your findings clearly.`;

  const chatRoom = `coordinator-${requestId.substring(0, 8)}`;

  const prompt = `COORDINATOR REQUEST #${requestId}
From: ${request.from?.project || "unknown"} (${request.from?.instance || "unknown"})
Type: ${type}
${request.context ? `Context: ${request.context}\n` : ""}Request: ${request.description}

Complete this ${type} task and report your findings.
Do NOT call "sv respond" or publish results yourself — your text output IS the response. The coordinator captures your output automatically.

Chat room: ${chatRoom}
Post your key findings to this chat room as you work. Use: sv chat post ${chatRoom} "your findings"`;

  // Configure tools based on request type
  // Review/research: everything except file-writing tools — can search, browse, spawn subagents, use sv chat
  // Action: full tools (including Edit, Write)
  const toolsArg = (type === "action")
    ? [] // full tools
    : ["--tools", "Read,Glob,Grep,Bash,WebSearch,WebFetch,Agent,Task,LSP,ToolSearch"];

  const maxTurns = (type === "action") ? 25 : 15;
  const defaultTimeout = (type === "action") ? 300 : 120;
  const timeoutMs = (request.timeout || defaultTimeout) * 1000;
  const model = (type === "action")
    ? (process.env.SUPERVISOR_COORDINATOR_MODEL || process.env.SUPERVISOR_MODEL || "claude-sonnet-4-6")
    : (process.env.SUPERVISOR_COORDINATOR_FAST_MODEL || "claude-haiku-4-5-20251001");

  // All coordinator agents use the supervisor's hook-based permission gating.
  // "plan" mode was too restrictive (no Bash/sv chat). "bypassPermissions" relies on hooks to block unsafe ops.
  const permissionMode = "bypassPermissions";

  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--model", model,
    "--max-turns", String(maxTurns),
    "--max-budget-usd", "10.00",
    "--no-session-persistence",
    "--append-system-prompt", systemContext,
    "--permission-mode", permissionMode,
    ...toolsArg,
  ];

  // Strip MCP configs to avoid slow startup
  const env = { ...process.env };
  delete env.MCP_SERVERS;
  delete env.CLAUDE_MCP_SERVERS;
  delete env.CLAUDECODE;
  env.CLAUDE_PROJECT_DIR = projectDir;
  env.SV_PROJECT = basename(projectDir);
  env.CLAUDE_CODE_TASK_LIST_ID = `task-${basename(projectDir)}`;
  // Merge any env vars from the request payload (overrides defaults above)
  if (request.env && typeof request.env === "object") {
    Object.assign(env, request.env);
  }

  try {
    const child = spawn("claude", args, {
      cwd: projectDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const maxOutput = 1_048_576; // 1MB cap
    let responded = false;

    child.stdout.on("data", (d) => { if (stdout.length < maxOutput) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < maxOutput) stderr += d; });

    const timer = setTimeout(() => {
      if (responded) return;
      responded = true;
      try { child.kill("SIGTERM"); } catch {}
      const timeoutResult = { status: "timeout", result: `Agent timed out after ${timeoutMs / 1000}s` };
      publishCoordinatorResponse(requestId, request, timeoutResult);
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      if (responded) return;
      responded = true;
      log("error", `[coordinator] Agent spawn error for #${requestId}: ${err.message}`);
      const errorResult = { status: "error", result: `Agent spawn error: ${err.message}` };
      publishCoordinatorResponse(requestId, request, errorResult);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (responded) return;
      responded = true;
      let resultText;
      try {
        const cliOutput = JSON.parse(stdout);
        // Try multiple paths to extract readable text from CLI JSON output
        resultText = cliOutput.result
          || (Array.isArray(cliOutput.content)
              ? cliOutput.content.filter(c => c.type === "text").map(c => c.text || "").join("")
              : null)
          || cliOutput.message
          || (cliOutput.subtype === "error_max_turns" ? `(Agent hit max turns after ${cliOutput.num_turns} turns. Partial work may be in chat room.)` : null)
          || String(cliOutput.content || stdout);
      } catch {
        resultText = stdout || `Agent exited with code ${code}`;
      }

      log("info", `[coordinator] Agent completed #${requestId} (code ${code}), result: ${resultText.slice(0, 200)}...`);
      const result = { status: code === 0 ? "completed" : "error", result: resultText };
      publishCoordinatorResponse(requestId, request, result);

      // Post final result summary to chat room
      const truncatedResult = resultText.slice(0, 500) + (resultText.length > 500 ? "..." : "");
      execFile("sv", ["chat", "post", chatRoom, `[coordinator] Final result for request ${requestId}: ${truncatedResult}`], {
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      }, () => {});
    });

  } catch (err) {
    log("error", `[coordinator] Failed to spawn agent for #${requestId}: ${err.message}`);
    entry.status = "pending"; // reset to pending for retry
    entry.updatedAt = new Date().toISOString();
  }
}

// ─── Moltke Pattern: Planner + Adversarial Review ────────────────────────────

function dispatchMoltkeRequest(requestId, request, projectDir) {
  const type = request.type || "plan";
  const entry = coordinatorRequests.get(requestId);

  log("info", `[moltke] Starting plan+review for #${requestId} (${type})`);
  broadcast({ type: "coordinator_dispatched", id: requestId, status: "dispatched", moltke: true });

  const env = { ...process.env };
  delete env.MCP_SERVERS;
  delete env.CLAUDE_MCP_SERVERS;
  delete env.CLAUDECODE;
  env.CLAUDE_PROJECT_DIR = projectDir;
  env.SV_PROJECT = basename(projectDir);
  env.CLAUDE_CODE_TASK_LIST_ID = `task-${basename(projectDir)}`;

  const moltkeRoom = `feasibility-${requestId.substring(0, 8)}`;

  const plannerPrompt = `COORDINATOR REQUEST #${requestId} — PLANNING PHASE
From: ${request.from?.project || "unknown"} (${request.from?.instance || "unknown"})
Type: ${type}
${request.context ? `Context: ${request.context}\n` : ""}
Request: ${request.description}

You are the PLANNER. Research this thoroughly and produce a detailed plan or feasibility assessment.
Include: specific components, versions, compatibility requirements, architecture decisions, and implementation steps.
Be specific about hardware specs, software versions, platform requirements — these details will be war-gamed.
Do NOT call "sv respond" or publish results yourself — your text output IS the response.

Chat room: ${moltkeRoom}
Post your plan to this chat room when done: sv chat post ${moltkeRoom} "PLAN: <your plan summary>"`;

  const plannerArgs = [
    "-p", plannerPrompt,
    "--output-format", "json",
    "--model", process.env.SUPERVISOR_COORDINATOR_MODEL || process.env.SUPERVISOR_MODEL || "claude-sonnet-4-6",
    "--max-turns", "10",
    "--max-budget-usd", "10.00",
    "--no-session-persistence",
    "--append-system-prompt", "You are a planning agent. Be thorough and specific. Your output will be reviewed by an adversarial agent looking for flaws. Do your research directly — do NOT spawn subagents.",
    "--permission-mode", "bypassPermissions",
    "--tools", "Read,Glob,Grep,Bash,WebSearch,WebFetch,Agent,Task,LSP,ToolSearch",
  ];

  const defaultTimeout = 300;
  const timeoutMs = (request.timeout || defaultTimeout) * 1000;

  const plannerChild = spawn("claude", plannerArgs, { cwd: projectDir, env, stdio: ["ignore", "pipe", "pipe"] });

  let plannerStdout = "";
  let plannerStderr = "";
  const maxOutput = 1_048_576;
  plannerChild.stdout.on("data", (d) => { if (plannerStdout.length < maxOutput) plannerStdout += d; });
  plannerChild.stderr.on("data", (d) => { if (plannerStderr.length < maxOutput) plannerStderr += d; });

  let plannerResponded = false;

  const plannerTimer = setTimeout(() => {
    if (plannerResponded) return;
    plannerResponded = true;
    try { plannerChild.kill("SIGTERM"); } catch {}
    publishCoordinatorResponse(requestId, request, { status: "timeout", result: "Planner timed out" });
  }, timeoutMs);

  plannerChild.on("error", (err) => {
    clearTimeout(plannerTimer);
    if (plannerResponded) return;
    plannerResponded = true;
    log("error", `[moltke] Planner error for #${requestId}: ${err.message}`);
    publishCoordinatorResponse(requestId, request, { status: "error", result: `Planner error: ${err.message}` });
  });

  plannerChild.on("close", (plannerCode) => {
    clearTimeout(plannerTimer);
    if (plannerResponded) return;

    let planResult;
    try {
      const cliOutput = JSON.parse(plannerStdout);
      planResult = cliOutput.result ||
        (Array.isArray(cliOutput.content) ? cliOutput.content.map((c) => c.text || "").join("") : String(cliOutput.content || plannerStdout));
    } catch {
      planResult = plannerStdout || `Planner exited with code ${plannerCode}`;
    }

    if (plannerCode !== 0) {
      plannerResponded = true;
      log("warn", `[moltke] Planner failed for #${requestId} (code ${plannerCode})`);
      publishCoordinatorResponse(requestId, request, { status: "error", result: `Planner failed (code ${plannerCode}): ${planResult.slice(0, 500)}` });
      return;
    }
    plannerResponded = true; // Planner succeeded — hand off to Moltke phase

    log("info", `[moltke] Planner done for #${requestId}, launching Moltke review`);
    if (entry) {
      entry.planResult = planResult;
      entry.updatedAt = new Date().toISOString();
    }
    broadcast({ type: "coordinator_dispatched", id: requestId, status: "reviewing", moltke: true, phase: "moltke" });

    // Phase 2: Moltke adversarial review
    const moltkePrompt = `COORDINATOR REQUEST #${requestId} — MOLTKE ADVERSARIAL REVIEW
Original request: ${request.description}
${request.context ? `Context: ${request.context}\n` : ""}
=== PROPOSED PLAN ===
${planResult}
=== END PLAN ===

You are MOLTKE — the adversarial reviewer. Your job is to find reasons this plan will FAIL.

Do NOT confirm the plan works. Assume it has fatal flaws and find them.
Do NOT call "sv respond" or publish results yourself — your text output IS the response.

For EVERY claim in the plan:
1. Search for incompatibilities, known issues, forum complaints, GitHub issues
2. Verify version requirements, platform support, hardware specs
3. Cross-reference the full stack — components that work alone may fail together
4. Check real-world reports from users who tried similar setups

Provide your FULL detailed analysis as your final text output, structured as:
### BLOCKERS (deal-breakers — with evidence and sources)
### RISKS (might fail — with likelihood and mitigation)
### UNVERIFIED ASSUMPTIONS (claims you could not confirm either way)
### VALIDATED (things you tried to disprove but found solid evidence for)
### VERDICT: GO / NO-GO / CONDITIONAL (with clear reasoning)

Chat room: ${moltkeRoom}
First read the chat room to see the plan: sv chat history ${moltkeRoom}
Post your review when done: sv chat post ${moltkeRoom} "REVIEW: <your verdict and key findings>"`;

    const moltkeArgs = [
      "-p", moltkePrompt,
      "--output-format", "json",
      "--model", process.env.SUPERVISOR_COORDINATOR_MODEL || process.env.SUPERVISOR_MODEL || "claude-sonnet-4-6",
      "--max-turns", "15",
      "--max-budget-usd", "10.00",
      "--no-session-persistence",
      "--append-system-prompt", "You are an adversarial reviewer. Cite sources. Do not guess. If you cannot verify a claim, mark it UNVERIFIED. Do not soften bad news.",
      "--permission-mode", "bypassPermissions",
      "--tools", "Read,Glob,Grep,Bash,WebSearch,WebFetch,Agent,Task,LSP,ToolSearch",
    ];

    const moltkeChild = spawn("claude", moltkeArgs, { cwd: projectDir, env, stdio: ["ignore", "pipe", "pipe"] });

    let moltkeStdout = "";
    let moltkeStderr = "";
    let moltkeResponded = false;
    moltkeChild.stdout.on("data", (d) => { if (moltkeStdout.length < maxOutput) moltkeStdout += d; });
    moltkeChild.stderr.on("data", (d) => { if (moltkeStderr.length < maxOutput) moltkeStderr += d; });

    const moltkeTimer = setTimeout(() => {
      if (moltkeResponded) return;
      moltkeResponded = true;
      try { moltkeChild.kill("SIGTERM"); } catch {}
      // Still return plan + timeout note
      const combined = `## PLAN\n${planResult}\n\n## MOLTKE REVIEW\n(Timed out — review incomplete. Proceed with caution.)`;
      publishCoordinatorResponse(requestId, request, { status: "completed", result: combined });
    }, timeoutMs);

    moltkeChild.on("error", (err) => {
      clearTimeout(moltkeTimer);
      if (moltkeResponded) return;
      moltkeResponded = true;
      log("error", `[moltke] Review error for #${requestId}: ${err.message}`);
      const combined = `## PLAN\n${planResult}\n\n## MOLTKE REVIEW\n(Error: ${err.message}. Plan was NOT reviewed.)`;
      publishCoordinatorResponse(requestId, request, { status: "completed", result: combined });
    });

    moltkeChild.on("close", (moltkeCode) => {
      clearTimeout(moltkeTimer);
      if (moltkeResponded) return;
      moltkeResponded = true;

      let moltkeResult;
      try {
        const cliOutput = JSON.parse(moltkeStdout);
        moltkeResult = cliOutput.result ||
          (Array.isArray(cliOutput.content) ? cliOutput.content.map((c) => c.text || "").join("") : String(cliOutput.content || moltkeStdout));
      } catch {
        moltkeResult = moltkeStdout || `Moltke exited with code ${moltkeCode}`;
      }

      log("info", `[moltke] Review done for #${requestId} (code ${moltkeCode})`);

      const combined = `## PLAN\n${planResult}\n\n## MOLTKE REVIEW\n${moltkeResult}`;
      publishCoordinatorResponse(requestId, request, { status: "completed", result: combined });

      // Post combined report summary to chat room
      const truncatedCombined = combined.slice(0, 500) + (combined.length > 500 ? "..." : "");
      execFile("sv", ["chat", "post", moltkeRoom, `[coordinator] Combined report for #${requestId}: ${truncatedCombined}`], {
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      }, () => {});

      // Save report to project docs if docs/ exists
      const docsDir = join(projectDir, "docs");
      try {
        if (existsSync(docsDir)) {
          const filename = `feasibility-${requestId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.md`;
          const reportPath = join(docsDir, filename);
          const report = `# Feasibility Report: ${request.description}\n\nDate: ${new Date().toISOString()}\nRequest ID: ${requestId}\nType: ${type}\n\n${combined}`;
          writeFileSync(reportPath, report);
          log("info", `[moltke] Report saved to ${reportPath}`);
        }
      } catch (err) {
        log("warn", `[moltke] Failed to save report: ${err.message}`);
      }
    });
  });
}

// ─── Debate Pattern: Server-orchestrated multi-round debate ──────────────────

function dispatchDebate(requestId, request, projectDir) {
  const entry = coordinatorRequests.get(requestId);

  log("info", `[debate] Starting multi-round server-orchestrated debate for #${requestId}`);
  broadcast({ type: "coordinator_dispatched", id: requestId, status: "dispatched", debate: true });

  const env = { ...process.env };
  delete env.MCP_SERVERS;
  delete env.CLAUDE_MCP_SERVERS;
  delete env.CLAUDECODE;
  env.CLAUDE_PROJECT_DIR = projectDir;
  env.SV_PROJECT = basename(projectDir);
  env.CLAUDE_CODE_TASK_LIST_ID = `task-${basename(projectDir)}`;

  const debateRoom = `debate-${requestId.substring(0, 8)}`;
  const defaultTimeout = 900;
  const timeoutMs = (request.timeout || defaultTimeout) * 1000;
  const maxOutput = 1_048_576;
  const model = process.env.SUPERVISOR_COORDINATOR_MODEL || process.env.SUPERVISOR_MODEL || "claude-sonnet-4-6";
  const toolsArg = ["--tools", "Read,Glob,Grep,Bash,WebSearch,WebFetch"];

  // Initialize the debate room with an opening message
  execFile("sv", ["chat", "init", debateRoom], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  }, () => {
    execFile("sv", ["chat", "post", debateRoom, `[coordinator] DEBATE OPENED: "${request.description}". 4-round server-orchestrated debate beginning.`], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    }, () => {});
  });

  // ── Agent stdout parsing helper ───────────────────────────────────────────
  function parseAgentResult(stdout, fallbackCode, label) {
    let resultText;
    try {
      const cliOutput = JSON.parse(stdout);
      resultText = cliOutput.result
        || (Array.isArray(cliOutput.content)
            ? cliOutput.content.filter(c => c.type === "text").map(c => c.text || "").join("")
            : null)
        || cliOutput.message
        || (cliOutput.subtype === "error_max_turns" ? `(${label} hit max turns.)` : null)
        || String(cliOutput.content || stdout);
    } catch {
      resultText = stdout || `${label} exited with code ${fallbackCode}`;
    }
    return resultText;
  }

  // ── Helper: run a single claude agent and collect output ─────────────────
  function runAgent(label, prompt, maxTurns, budgetUsd, callback) {
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--model", model,
      "--max-turns", String(maxTurns),
      "--max-budget-usd", String(budgetUsd),
      "--no-session-persistence",
      "--permission-mode", "bypassPermissions",
      ...toolsArg,
    ];
    log("info", `[debate] Spawning ${label} for #${requestId}`);
    // Must use spawn with stdin=ignore — execFile leaves stdin open which causes claude to hang
    const child = spawn("claude", args, {
      cwd: projectDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => { if (stdout.length < maxOutput) stdout += d; });
    child.stderr.on("data", (d) => {});
    child.on("error", (err) => {
      log("warn", `[debate] ${label} error for #${requestId}: ${err.message}`);
      callback(null, `(${label} error: ${err.message})`);
    });
    child.on("close", (code) => {
      const text = parseAgentResult(stdout, code, label);
      log("info", `[debate] ${label} done for #${requestId} (${(text || "").length} chars)`);
      callback(null, text);
    });
    return child;
  }

  // ── Helper: post a message to the chat room (fire and forget) ────────────
  function postToRoom(message) {
    execFile("sv", ["chat", "post", debateRoom, message], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    }, () => {});
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let overallResponded = false;

  function publishResult(status, roundResults) {
    if (overallResponded) return;
    overallResponded = true;
    clearTimeout(overallTimer);

    const r = roundResults;
    const combined = [
      `## DEBATE: ${request.description}`,
      "",
      "### Round 1 — Opening Arguments",
      `**PRO:** ${r.pro1 || "(did not complete)"}`,
      "",
      `**CON:** ${r.con1 || "(did not complete)"}`,
      "",
      "### Round 2 — Rebuttals",
      `**PRO:** ${r.pro2 || "(did not complete)"}`,
      "",
      `**CON:** ${r.con2 || "(did not complete)"}`,
      "",
      "### Round 3 — Moderator Challenge & Defense",
      `**MODERATOR:** ${r.challenge || "(did not complete)"}`,
      "",
      `**PRO:** ${r.pro3 || "(did not complete)"}`,
      "",
      `**CON:** ${r.con3 || "(did not complete)"}`,
      "",
      "### Round 4 — Final Statements",
      `**PRO:** ${r.pro4 || "(did not complete)"}`,
      "",
      `**CON:** ${r.con4 || "(did not complete)"}`,
      "",
      "### VERDICT",
      r.verdict || "(did not complete)",
    ].join("\n");

    log("info", `[debate] Publishing ${status} result for #${requestId}`);
    publishCoordinatorResponse(requestId, request, { status, result: combined });
  }

  // ── Overall timeout ───────────────────────────────────────────────────────
  const roundResults = {};
  const overallTimer = setTimeout(() => {
    if (overallResponded) return;
    log("warn", `[debate] Debate #${requestId} timed out after ${timeoutMs / 1000}s`);
    publishResult("timeout", roundResults);
  }, timeoutMs);

  if (entry) {
    entry.updatedAt = new Date().toISOString();
  }

  // ── Round 1: Opening arguments (parallel) ────────────────────────────────
  const contextLine = request.context ? `Context: ${request.context}\n` : "";

  const pro1Prompt = `You are arguing STRONGLY IN FAVOR of the following proposition. Research the codebase for evidence.

Proposition: "${request.description}"
${contextLine}
Present 3-4 concrete arguments with specific evidence (file paths, line numbers, metrics). Be direct and forceful. Do not hedge.`;

  const con1Prompt = `You are arguing STRONGLY AGAINST the following proposition. Research the codebase for evidence.

Proposition: "${request.description}"
${contextLine}
Present 3-4 concrete arguments with specific evidence (file paths, line numbers, metrics). Be direct and forceful. Do not hedge.`;

  log("info", `[debate] Round 1 starting (parallel PRO + CON) for #${requestId}`);

  let pro1Done = false;
  let con1Done = false;

  function onRound1Done() {
    if (!pro1Done || !con1Done) return;
    postToRoom(`[ROUND 1 — PRO OPENING] ${roundResults.pro1}`);
    postToRoom(`[ROUND 1 — CON OPENING] ${roundResults.con1}`);
    startRound2();
  }

  runAgent("PRO-R1", pro1Prompt, 15, 3.00, (_, text) => {
    roundResults.pro1 = text;
    pro1Done = true;
    onRound1Done();
  });

  runAgent("CON-R1", con1Prompt, 15, 3.00, (_, text) => {
    roundResults.con1 = text;
    con1Done = true;
    onRound1Done();
  });

  // ── Round 2: Rebuttals (parallel) ────────────────────────────────────────
  function startRound2() {
    if (overallResponded) return;
    log("info", `[debate] Round 2 starting (parallel rebuttals) for #${requestId}`);

    const pro2Prompt = `You are arguing STRONGLY IN FAVOR of: "${request.description}"
${contextLine}
Your opponent argued the following AGAINST your position:

${roundResults.con1}

Rebut their specific points. You MUST address each of their arguments by name — do not ignore any. Where they are wrong, explain why with evidence. Where they have a point, acknowledge it briefly then reframe it in your favor.`;

    const con2Prompt = `You are arguing STRONGLY AGAINST: "${request.description}"
${contextLine}
Your opponent argued the following IN FAVOR of the proposition:

${roundResults.pro1}

Rebut their specific points. You MUST address each of their arguments by name — do not ignore any. Where they are wrong, explain why with evidence. Where they have a point, acknowledge it briefly then reframe it in your favor.`;

    let pro2Done = false;
    let con2Done = false;

    function onRound2Done() {
      if (!pro2Done || !con2Done) return;
      postToRoom(`[ROUND 2 — PRO REBUTTAL] ${roundResults.pro2}`);
      postToRoom(`[ROUND 2 — CON REBUTTAL] ${roundResults.con2}`);
      startRound3();
    }

    runAgent("PRO-R2", pro2Prompt, 15, 3.00, (_, text) => {
      roundResults.pro2 = text;
      pro2Done = true;
      onRound2Done();
    });

    runAgent("CON-R2", con2Prompt, 15, 3.00, (_, text) => {
      roundResults.con2 = text;
      con2Done = true;
      onRound2Done();
    });
  }

  // ── Round 3: Moderator challenge + defense (sequential then parallel) ─────
  function startRound3() {
    if (overallResponded) return;
    log("info", `[debate] Round 3 starting (moderator challenge) for #${requestId}`);

    const transcriptSoFar = [
      `DEBATE PROPOSITION: "${request.description}"`,
      "",
      "=== ROUND 1 — PRO OPENING ===",
      roundResults.pro1,
      "",
      "=== ROUND 1 — CON OPENING ===",
      roundResults.con1,
      "",
      "=== ROUND 2 — PRO REBUTTAL ===",
      roundResults.pro2,
      "",
      "=== ROUND 2 — CON REBUTTAL ===",
      roundResults.con2,
    ].join("\n");

    const moderatorChallengePrompt = `You are a neutral moderator reviewing a structured debate. Read the transcript below and produce a moderator challenge.

${transcriptSoFar}

Identify and state clearly:
1. The weakest argument from PRO (by name) and why it is weak.
2. The weakest argument from CON (by name) and why it is weak.
3. Points or perspectives that neither side has addressed.
4. Any false binaries or missed middle-ground options.

Your challenge will be given to both sides, who must respond. Be specific and rigorous.`;

    runAgent("MODERATOR-CHALLENGE", moderatorChallengePrompt, 15, 3.00, (_, challengeText) => {
      if (overallResponded) return;
      roundResults.challenge = challengeText;
      postToRoom(`[ROUND 3 — MODERATOR CHALLENGE] ${challengeText}`);

      log("info", `[debate] Round 3 defenses starting (parallel) for #${requestId}`);

      const fullTranscript = transcriptSoFar + `\n\n=== MODERATOR CHALLENGE ===\n${challengeText}`;

      const pro3Prompt = `You are arguing STRONGLY IN FAVOR of: "${request.description}"
${contextLine}
Here is the full debate transcript so far, including a moderator challenge you must respond to:

${fullTranscript}

Address the moderator's specific challenges to your position. Acknowledge any points you genuinely cannot defend. Strengthen your remaining arguments with additional research if needed.`;

      const con3Prompt = `You are arguing STRONGLY AGAINST: "${request.description}"
${contextLine}
Here is the full debate transcript so far, including a moderator challenge you must respond to:

${fullTranscript}

Address the moderator's specific challenges to your position. Acknowledge any points you genuinely cannot defend. Strengthen your remaining arguments with additional research if needed.`;

      let pro3Done = false;
      let con3Done = false;

      function onRound3Done() {
        if (!pro3Done || !con3Done) return;
        postToRoom(`[ROUND 3 — PRO DEFENSE] ${roundResults.pro3}`);
        postToRoom(`[ROUND 3 — CON DEFENSE] ${roundResults.con3}`);
        startRound4();
      }

      runAgent("PRO-R3", pro3Prompt, 15, 3.00, (_, text) => {
        roundResults.pro3 = text;
        pro3Done = true;
        onRound3Done();
      });

      runAgent("CON-R3", con3Prompt, 15, 3.00, (_, text) => {
        roundResults.con3 = text;
        con3Done = true;
        onRound3Done();
      });
    });
  }

  // ── Round 4: Final summaries (parallel) ──────────────────────────────────
  function startRound4() {
    if (overallResponded) return;
    log("info", `[debate] Round 4 starting (final statements) for #${requestId}`);

    const fullTranscript = [
      `DEBATE PROPOSITION: "${request.description}"`,
      "",
      "=== ROUND 1 — PRO OPENING ===",
      roundResults.pro1,
      "",
      "=== ROUND 1 — CON OPENING ===",
      roundResults.con1,
      "",
      "=== ROUND 2 — PRO REBUTTAL ===",
      roundResults.pro2,
      "",
      "=== ROUND 2 — CON REBUTTAL ===",
      roundResults.con2,
      "",
      "=== ROUND 3 — MODERATOR CHALLENGE ===",
      roundResults.challenge,
      "",
      "=== ROUND 3 — PRO DEFENSE ===",
      roundResults.pro3,
      "",
      "=== ROUND 3 — CON DEFENSE ===",
      roundResults.con3,
    ].join("\n");

    const pro4Prompt = `You are arguing STRONGLY IN FAVOR of: "${request.description}"
${contextLine}
Here is the full debate transcript:

${fullTranscript}

This is your FINAL STATEMENT. Summarize your 2-3 strongest surviving arguments. Acknowledge what the opponent got right. State your final position clearly and concisely.`;

    const con4Prompt = `You are arguing STRONGLY AGAINST: "${request.description}"
${contextLine}
Here is the full debate transcript:

${fullTranscript}

This is your FINAL STATEMENT. Summarize your 2-3 strongest surviving arguments. Acknowledge what the opponent got right. State your final position clearly and concisely.`;

    let pro4Done = false;
    let con4Done = false;

    function onRound4Done() {
      if (!pro4Done || !con4Done) return;
      postToRoom(`[ROUND 4 — PRO FINAL] ${roundResults.pro4}`);
      postToRoom(`[ROUND 4 — CON FINAL] ${roundResults.con4}`);
      startVerdict();
    }

    runAgent("PRO-R4", pro4Prompt, 15, 3.00, (_, text) => {
      roundResults.pro4 = text;
      pro4Done = true;
      onRound4Done();
    });

    runAgent("CON-R4", con4Prompt, 15, 3.00, (_, text) => {
      roundResults.con4 = text;
      con4Done = true;
      onRound4Done();
    });
  }

  // ── Verdict: Moderator final verdict (sequential) ────────────────────────
  function startVerdict() {
    if (overallResponded) return;
    log("info", `[debate] Verdict round starting for #${requestId}`);

    const fullTranscript = [
      `DEBATE PROPOSITION: "${request.description}"`,
      "",
      "=== ROUND 1 — PRO OPENING ===",
      roundResults.pro1,
      "",
      "=== ROUND 1 — CON OPENING ===",
      roundResults.con1,
      "",
      "=== ROUND 2 — PRO REBUTTAL ===",
      roundResults.pro2,
      "",
      "=== ROUND 2 — CON REBUTTAL ===",
      roundResults.con2,
      "",
      "=== ROUND 3 — MODERATOR CHALLENGE ===",
      roundResults.challenge,
      "",
      "=== ROUND 3 — PRO DEFENSE ===",
      roundResults.pro3,
      "",
      "=== ROUND 3 — CON DEFENSE ===",
      roundResults.con3,
      "",
      "=== ROUND 4 — PRO FINAL STATEMENT ===",
      roundResults.pro4,
      "",
      "=== ROUND 4 — CON FINAL STATEMENT ===",
      roundResults.con4,
    ].join("\n");

    const verdictPrompt = `You are a neutral moderator. You have the full transcript of a 4-round structured debate.

${fullTranscript}

Determine the winner. Your verdict MUST:
1. Cite specific arguments that were decisive and explain why they won.
2. Cite specific arguments that failed and explain why they failed.
3. Identify anything important that both sides missed entirely.
4. State a clear winner (PRO, CON, or synthesis if genuinely tied) with a one-sentence rationale.
5. Give an actionable recommendation based on the debate's outcome.

Be rigorous, specific, and impartial.`;

    runAgent("MODERATOR-VERDICT", verdictPrompt, 15, 3.00, (_, verdictText) => {
      if (overallResponded) return;
      roundResults.verdict = verdictText;
      postToRoom(`[VERDICT] ${verdictText}`);
      publishResult("completed", roundResults);
    });
  }
}

function publishCoordinatorResponse(requestId, request, result) {
  const entry = coordinatorRequests.get(requestId);
  if (!entry) return; // Already archived, don't publish duplicate
  if (entry) {
    entry.status = result.status;
    entry.result = result.result;
    entry.completedAt = new Date().toISOString();
    entry.updatedAt = new Date().toISOString();
    if (entry.timeoutTimer) {
      clearTimeout(entry.timeoutTimer);
      entry.timeoutTimer = null;
    }
  }

  // Publish response to originator's instance namespace
  const originInstance = request?.from?.instance || SV_INSTANCE;
  const topic = `coordinator/${originInstance}/responses/${requestId}`;
  const payload = JSON.stringify({
    request_id: requestId,
    ...result,
    from: { instance: SV_INSTANCE, project: request?.target_project },
    timestamp: new Date().toISOString(),
  });

  mqttPublish(["-r", "-t", topic, "-m", payload], (err) => {
    if (err) log("warn", `[coordinator] Failed to publish response to ${topic}: ${err.message}`);
  });

  // Broadcast to web UI
  broadcast({ type: "coordinator_response", id: requestId, ...result });

  // Archive after a delay
  setTimeout(() => {
    mqttPublish(["-r", "-n", "-t", topic]);
    archiveRequest(requestId);
  }, 600_000); // 10 min
}

function handleCoordinatorRequest(topic, payloadStr, instance, requestId) {
  if (!COORDINATOR_ENABLED) return;

  let request;
  try {
    request = JSON.parse(payloadStr);
  } catch (e) {
    console.error(`[coordinator] Invalid request JSON on ${topic}:`, e.message);
    return;
  }

  // Skip if we already know this request (retained messages on reconnect)
  if (coordinatorRequests.has(requestId)) return;

  // Skip requests from other instances that don't target our projects
  if (instance !== SV_INSTANCE && instance !== "broadcast") {
    // Accept cross-instance requests if the target project exists on this server
    // (either as a running terminal or as a directory on disk)
    const targetProject = request?.target_project;
    if (!targetProject) {
      log("warn", `[coordinator] Dropping cross-instance request ${requestId} from '${instance}': no target_project specified`);
      return;
    }
    // Check running terminals first (fast path)
    let hasProject = false;
    for (const [, s] of terminals) {
      if (s.project === targetProject) {
        hasProject = true;
        break;
      }
    }
    // Fallback: check project root on disk (synchronous, cheap stat)
    if (!hasProject) {
      const projectRoot = process.env.SUPERVISOR_PROJECT_ROOT || join(os.homedir(), "projects");
      const candidatePath = join(projectRoot, targetProject);
      hasProject = existsSync(candidatePath);
    }
    if (!hasProject) {
      log("warn", `[coordinator] Dropping cross-instance request ${requestId} from '${instance}': project '${targetProject}' not found on this server`);
      return;
    }
    log("info", `Coordinator: accepting cross-instance request from ${instance} for local project ${targetProject}`);
  } else {
    // Same-instance request: verify the target project exists locally before claiming it.
    // If it doesn't exist here, another instance (e.g. Elena's server) may have the project
    // and will pick up the request via the cross-instance path above.
    const targetProject = request?.target_project;
    if (targetProject) {
      let hasProject = false;
      for (const [, s] of terminals) {
        if (s.project === targetProject) {
          hasProject = true;
          break;
        }
      }
      if (!hasProject) {
        const projectRoot = process.env.SUPERVISOR_PROJECT_ROOT || join(os.homedir(), "projects");
        hasProject = existsSync(join(projectRoot, targetProject));
      }
      if (!hasProject) {
        log("info", `Coordinator: project '${targetProject}' not found locally, deferring to other instances`);
        return;
      }
    }
  }

  const entry = {
    request,
    status: "pending",
    dispatchedTo: null,
    response: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  coordinatorRequests.set(requestId, entry);

  // Broadcast to web UI
  broadcast({
    type: "coordinator_request",
    id: requestId,
    ...entry,
  });

  console.log(`[coordinator] New request ${requestId}: ${request.description || "no description"}`);

  // All coordinator requests stay pending until manually dispatched from the UI
  if (request.target_project) {
    log("info", `[coordinator] Request ${requestId} targeting '${request.target_project}' — awaiting manual dispatch`);
  } else {
    log("warn", `[coordinator] Request ${requestId} has no target_project — awaiting manual dispatch`);
  }

  // Set timeout — plan/feasibility get double budget since planner + Moltke run sequentially
  // debate gets 600s default since 3 agents run in parallel with multi-turn back-and-forth
  const baseTimeout = request.timeout || (request.type === "debate" ? 600 : 300);
  const effectiveTimeout = (request.type === "plan" || request.type === "feasibility") ? baseTimeout * 2 : baseTimeout;
  const timeout = effectiveTimeout * 1000;
  entry.timeoutTimer = setTimeout(() => {
    const current = coordinatorRequests.get(requestId);
    if (current && (current.status === "pending" || current.status === "dispatched")) {
      current.status = "timeout";
      current.updatedAt = new Date().toISOString();

      // Publish timeout response
      const responsePayload = JSON.stringify({
        id: randomUUID(),
        request_id: requestId,
        status: "timeout",
        result: `Request timed out after ${request.timeout || 300}s`,
        timestamp: new Date().toISOString(),
      });

      mqttPublish([
        "-r",
        "-t", `coordinator/${instance}/responses/${requestId}`,
        "-m", responsePayload,
      ], (err) => {
        if (err) console.error("[coordinator] Failed to publish timeout:", err.message);
      });

      broadcast({
        type: "coordinator_response",
        id: requestId,
        status: "timeout",
      });

      // Clear retained MQTT messages for timed-out request
      const clearRetained = (t) => mqttPublish(["-r", "-n", "-t", t]);
      clearRetained(`coordinator/${instance}/requests/${requestId}`);
      clearRetained(`coordinator/${instance}/responses/${requestId}`);

      archiveRequest(requestId);
    }
  }, timeout);
}

function handleCoordinatorResponse(topic, payloadStr, instance, requestId) {
  let response;
  try {
    response = JSON.parse(payloadStr);
  } catch (e) {
    console.error(`[coordinator] Invalid response JSON on ${topic}:`, e.message);
    return;
  }

  const reqId = response.request_id || requestId;
  const entry = coordinatorRequests.get(reqId);

  if (entry) {
    entry.status = response.status || "completed";
    entry.response = response;
    entry.updatedAt = new Date().toISOString();

    // Cross-instance relay: if the response arrived on a different instance than
    // the originator's, re-publish to the originator's instance so the waiting
    // agent (which subscribed to coordinator/{originator_instance}/responses/{id})
    // receives it.
    const originatorInstance = entry.request?.from?.instance;
    if (originatorInstance && originatorInstance !== instance) {
      const relayTopic = `coordinator/${originatorInstance}/responses/${reqId}`;
      log("info", `[coordinator] Relaying response for ${reqId.substring(0, 8)} from instance '${instance}' to originator '${originatorInstance}'`);
      mqttPublish(["-r", "-t", relayTopic, "-m", JSON.stringify(response)], (err) => {
        if (err) log("warn", `[coordinator] Failed to relay response to ${relayTopic}: ${err.message}`);
      });
    }

    broadcast({
      type: "coordinator_response",
      id: reqId,
      response,
    });

    console.log(`[coordinator] Response for ${reqId.substring(0, 8)}: ${response.status}`);
    archiveRequest(reqId);

    // Clear retained MQTT messages for completed request
    const clearRetained = (t) => mqttPublish(["-r", "-n", "-t", t]);
    clearRetained(`coordinator/${instance}/requests/${reqId}`);
    clearRetained(`coordinator/${instance}/responses/${reqId}`);
    if (originatorInstance && originatorInstance !== instance) {
      clearRetained(`coordinator/${originatorInstance}/responses/${reqId}`);
    }
  }
}

// ─── MQTT Subscriber ─────────────────────────────────────────────────────────

let mqttSub = null;
let mqttBackupSub = null;
let mqttRetryDelay = 5000;
const MQTT_MAX_RETRY = 60000;

// Deduplication set for messages received from both primary and backup brokers
// Key: topic+"|"+rawPayload (capped at 500 entries)
const mqttSeenMessages = new Set();
const MQTT_SEEN_MAX = 500;

function mqttLineHandler(line) {
  // Each line is: topic payload
  const spaceIdx = line.indexOf(" ");
  if (spaceIdx === -1) return;
  const topic = line.slice(0, spaceIdx);
  const rawPayload = line.slice(spaceIdx + 1);

  // Deduplicate messages received from both primary and backup brokers
  const dedupKey = topic + "|" + rawPayload;
  if (mqttSeenMessages.has(dedupKey)) return;
  mqttSeenMessages.add(dedupKey);
  if (mqttSeenMessages.size > MQTT_SEEN_MAX) {
    // Evict oldest entry
    mqttSeenMessages.delete(mqttSeenMessages.values().next().value);
  }

  let parsedJson;
  try {
    parsedJson = JSON.parse(rawPayload);
  } catch {
    return; // Ignore non-JSON payloads
  }

  // Handle supervisor/ topics: supervisor/{project}/{taskId}/{type}
  if (topic.startsWith("supervisor/")) {
    const parts = topic.split("/");

    // Handle 3-part topics (e.g. supervisor/{project}/compaction)
    if (parts.length === 3 && parts[2] === "compaction") {
      const project = parts[1];
      if (!isOwnProject(project)) return;
      const safePayload = JSON.parse(redactSecrets(JSON.stringify(parsedJson)));
      const msg = { type: "agent_message", source: "mqtt", project, taskId: "system", msgType: "compaction", payload: safePayload, timestamp: new Date().toISOString() };
      agentMessages.push(msg);
      if (agentMessages.length > MAX_AGENT_MESSAGES) agentMessages.shift();
      broadcast(msg);
      return;
    }

    if (parts.length < 4) return;

    // Handle chat messages: supervisor/{project}/chat/{room} or supervisor/{project}/chat/{room}/messages/{seq}
    if (parts[2] === "chat") {
      const chatProject = parts[1];
      if (!isOwnProject(chatProject)) return;
      const room = parts[3];
      if (parts.length === 5 && parts[4] === "seq") return;

      const safePayload = JSON.parse(redactSecrets(JSON.stringify(parsedJson)));
      const seqNumber = safePayload.seq != null ? safePayload.seq : null;

      const messageObj = {
        id: randomUUID(),
        topic,
        payload: rawPayload,
        type: "chat",
        room,
        seq: seqNumber,
        project: chatProject,
        timestamp: new Date().toISOString(),
      };

      agentMessages.push(messageObj);
      if (agentMessages.length > MAX_AGENT_MESSAGES) agentMessages.shift();
      broadcast({ type: "agent_message", ...messageObj });
      return;
    }

    const [, project, taskId, msgType] = parts;
    if (!isOwnProject(project)) return;
    if (!["progress", "discovery", "coordination", "status"].includes(msgType)) return;

    let safePayload;
    try {
      safePayload = JSON.parse(redactSecrets(JSON.stringify(parsedJson)));
    } catch {
      safePayload = parsedJson;
    }

    const messageObj = {
      id: randomUUID(),
      topic,
      project,
      taskId,
      msgType,
      payload: safePayload,
      timestamp: new Date().toISOString(),
    };

    agentMessages.push(messageObj);
    if (agentMessages.length > MAX_AGENT_MESSAGES) agentMessages.shift();
    broadcast({ type: "agent_message", ...messageObj });

    // Auto-register Task spawns as coordinator entries.
    // Only hook messages (hook: true) create/complete entries — deterministic ID matching.
    // Agent sv pub messages (no hook flag) are routed to entries via exact coordId or alias lookup.
    const coordId = `task-${project}-${taskId}`;
    const isHookMessage = safePayload.hook === true;

    if (msgType === "status") {
      const statusValue = safePayload.status || safePayload.value || (typeof safePayload === "string" ? safePayload : "");
      const description = safePayload.description || safePayload.message || safePayload.text || "";

      if (statusValue === "started") {
        if (isHookMessage && !coordinatorRequests.has(coordId)) {
          // Hook-created entry — deterministic, one per Task tool call
          const entry = {
            autoCreated: true,
            _hookTaskId: taskId,
            request: {
              type: "task",
              description: description || `Task: ${taskId}`,
              source: project,
              target_project: project,
              taskId,
            },
            status: "running",
            dispatchedTo: taskId,
            response: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          coordinatorRequests.set(coordId, entry);
          broadcast({ type: "coordinator_request", id: coordId, ...entry });
          log("info", `[coordinator] Auto-registered task entry ${coordId}: ${description || taskId}`);
        }
        // Agent sv pub started (no hook flag) — ignored for entry creation
      } else if (statusValue === "completed" || statusValue === "failed") {
        // Only hooks complete entries (exact match guaranteed)
        if (isHookMessage) {
          const entry = coordinatorRequests.get(coordId);
          if (entry && entry.autoCreated) {
            entry.status = statusValue;
            entry.result = description || statusValue;
            entry.progress = 100;
            entry.progressText = null;
            entry.completedAt = new Date().toISOString();
            entry.updatedAt = new Date().toISOString();
            broadcast({ type: "coordinator_response", id: coordId, status: statusValue, result: entry.result });
            setTimeout(() => archiveRequest(coordId), 5 * 60 * 1000);
          }
        }
      }
    } else if (msgType === "progress") {
      // Progress: exact coordId match only — no fallback matching.
      // Time-based progress bar handles display for entries with mismatched taskIds.
      const entry = coordinatorRequests.get(coordId);
      const resolvedId = coordId;
      if (entry && entry.autoCreated && entry.status === "running") {
        const rawProgress = safePayload.percent != null ? safePayload.percent : safePayload.progress;
        const progressValue = (rawProgress != null && rawProgress >= 0) ? rawProgress : null;
        const progressText = safePayload.message || safePayload.text || safePayload.description || "";
        if (progressValue != null) entry.progress = progressValue;
        if (progressText) entry.progressText = progressText;
        entry.updatedAt = new Date().toISOString();
        broadcast({ type: "coordinator_request", id: resolvedId, ...entry });
      }
    }
  }

  // Handle teamchat/ topics: teamchat/{project}/{messageId} or legacy teamchat/{messageId}
  if (topic.startsWith("teamchat/")) {
    const parts = topic.split("/");
    const room = parts.length >= 3 ? parts[1] : "general";
    const entry = {
      id: parsedJson.id || parts[parts.length - 1],
      user: parsedJson.user || "unknown",
      message: parsedJson.message || "",
      project: parsedJson.project || room,
      instance: parsedJson.instance || "unknown",
      timestamp: parsedJson.timestamp || new Date().toISOString(),
    };
    const roomKey = entry.project || "general";
    if (!teamChatMessages.has(roomKey)) teamChatMessages.set(roomKey, []);
    const roomMsgs = teamChatMessages.get(roomKey);
    if (!roomMsgs.some(m => m.id === entry.id)) {
      roomMsgs.push(entry);
      if (roomMsgs.length > 200) roomMsgs.shift();
      broadcast({ type: "team_chat", ...entry });
    }
  }

  // Handle coordinator/ topics
  if (topic.startsWith("coordinator/")) {
    const parts = topic.split("/");
    if (parts.length >= 4) {
      const instance = parts[1];
      const msgType = parts[2];
      const requestId = parts[3];
      if (msgType === "requests" && rawPayload) {
        handleCoordinatorRequest(topic, rawPayload, instance, requestId);
      } else if (msgType === "responses" && rawPayload) {
        handleCoordinatorResponse(topic, rawPayload, instance, requestId);
      }
    }
  }
}

function startMqttSubscriber() {
  let mqttConnected = false;
  const child = spawn("mosquitto_sub", ["-h", MQTT_HOST, "-t", "supervisor/#", "-t", "coordinator/#", "-t", "teamchat/#", "-v"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  mqttSub = child;

  const rl = createInterface({ input: child.stdout });
  rl.on("line", mqttLineHandler);

  child.stderr.on("data", (data) => {
    const msg = data.toString().trim();
    if (msg) log("warn", `MQTT subscriber stderr: ${msg}`);
  });

  child.on("exit", (code) => {
    mqttSub = null;
    rl.close();
    if (!mqttConnected) {
      mqttRetryDelay = Math.min(mqttRetryDelay * 2, MQTT_MAX_RETRY);
    }
    log("warn", `MQTT subscriber exited (code=${code}), respawning in ${mqttRetryDelay / 1000}s`);
    setTimeout(startMqttSubscriber, mqttRetryDelay);
  });

  child.on("error", (err) => {
    mqttSub = null;
    rl.close();
    log("warn", `MQTT subscriber error: ${err.message}, respawning in ${mqttRetryDelay / 1000}s`);
    setTimeout(startMqttSubscriber, mqttRetryDelay);
    mqttRetryDelay = Math.min(mqttRetryDelay * 2, MQTT_MAX_RETRY);
  });

  log("info", `MQTT subscriber started (host=${MQTT_HOST}${MQTT_BACKUP_HOST ? `, backup=${MQTT_BACKUP_HOST}` : ""}, topics=supervisor/#,coordinator/#,teamchat/#)`);
}

function startMqttBackupSubscriber() {
  if (!MQTT_BACKUP_HOST) return;
  const backupArgs = ["-h", MQTT_BACKUP_HOST];
  if (MQTT_BACKUP_USER) backupArgs.push("-u", MQTT_BACKUP_USER);
  if (MQTT_BACKUP_PASS) backupArgs.push("-P", MQTT_BACKUP_PASS);
  backupArgs.push("-t", "supervisor/#", "-t", "coordinator/#", "-t", "teamchat/#", "-v");

  const child = spawn("mosquitto_sub", backupArgs, { stdio: ["ignore", "pipe", "pipe"] });
  mqttBackupSub = child;

  const rl = createInterface({ input: child.stdout });
  rl.on("line", mqttLineHandler);

  child.stderr.on("data", (data) => {
    const msg = data.toString().trim();
    if (msg) log("warn", `MQTT backup subscriber stderr: ${msg}`);
  });

  child.on("exit", (code) => {
    mqttBackupSub = null;
    rl.close();
    log("warn", `MQTT backup subscriber exited (code=${code}), respawning in 30s`);
    setTimeout(startMqttBackupSubscriber, 30000);
  });

  child.on("error", (err) => {
    mqttBackupSub = null;
    rl.close();
    log("warn", `MQTT backup subscriber error: ${err.message}, respawning in 30s`);
    setTimeout(startMqttBackupSubscriber, 30000);
  });

  log("info", `MQTT backup subscriber started (host=${MQTT_BACKUP_HOST})`);
}

// ─── graceful shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`[shutdown] Received ${signal}, closing servers...`);

  // Close HTTP server (stops accepting new connections, waits for existing ones)
  server.close(() => console.log('[shutdown] HTTP server closed'));

  // Close WebSocket server (stops accepting new connections)
  wss.close(() => console.log('[shutdown] WebSocket server closed'));

  // Kill PTY attach processes (these are node-pty processes attaching to dtach sockets;
  // dtach sessions themselves are detached and survive the restart intentionally)
  for (const [, term] of terminals) {
    try { term.pty.kill(); } catch {}
  }

  // Kill MQTT subscriber child processes
  if (mqttSub) {
    try { mqttSub.kill(); } catch {}
    mqttSub = null;
  }
  if (mqttBackupSub) {
    try { mqttBackupSub.kill(); } catch {}
    mqttBackupSub = null;
  }

  // Give connections up to 3s to drain, then force exit
  setTimeout(() => {
    console.log('[shutdown] Force exit after timeout');
    process.exit(0);
  }, 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Start ───────────────────────────────────────────────────────────────────

await loadPolicy();
checkClaudeCli();
syncProjectHooks();
recoverDtachSessions();
startMqttSubscriber();
startMqttBackupSubscriber();

// Poll Claude API status
pollClaudeStatus();
setInterval(async () => {
  const prev = JSON.stringify(claudeApiStatus);
  await pollClaudeStatus();
  const curr = JSON.stringify(claudeApiStatus);
  if (prev !== curr) {
    broadcast({ type: "claude_status", ...claudeApiStatus });
  }
}, STATUS_POLL_INTERVAL);

// Poll Claude Code version
pollClaudeVersion();
setInterval(async () => {
  const prev = JSON.stringify(claudeVersion);
  await pollClaudeVersion();
  if (JSON.stringify(claudeVersion) !== prev) {
    broadcast({ type: "claude_version", ...claudeVersion });
  }
}, VERSION_POLL_INTERVAL);

// Clean up exited terminals with no clients every 5 minutes
setInterval(() => {
  const staleThreshold = Date.now() - 30 * 60 * 1000; // 30 min
  for (const [id, term] of terminals) {
    // Detect running sessions whose dtach socket has disappeared
    if (term.status === "running" && !existsSync(term.socketPath)) {
      term.status = "exited";
      log("warn", `Terminal #${id} dtach socket gone, marking as exited`, { project: term.project });
      const exitMsg = JSON.stringify({ type: "terminal_exit", terminalId: id, exitCode: null });
      for (const ws of term.clients) {
        if (ws.readyState === 1) ws.send(exitMsg);
      }
      broadcast({ type: "terminal_status", terminalId: id, status: "exited" });
    }

    if (term.status === "exited" && term.clients.size === 0) {
      const created = new Date(term.createdAt).getTime();
      if (created < staleThreshold) {
        killDtachSession(term.socketPath);
        terminals.delete(id);
        log("info", `Terminal #${id} cleaned up (stale)`, { project: term.project });
      }
    }
  }

  // Prune old approvals
  const approvalCutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, approval] of pendingApprovals) {
    if (approval.status !== "pending" && new Date(approval.receivedAt || approval.timestamp || approval.createdAt).getTime() < approvalCutoff) {
      pendingApprovals.delete(id);
    }
  }

  // Prune stale sessions (not updated in 24 hours)
  const sessionCutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, session] of sessions) {
    if (new Date(session.lastSeen).getTime() < sessionCutoff) {
      sessions.delete(id);
    }
  }

  // Clean up old questions (keep last 50, only delete completed/failed ones)
  if (pendingQuestions.size > 50) {
    const sorted = [...pendingQuestions.entries()].sort((a, b) => a[0] - b[0]);
    const toDelete = sorted.filter(([, q]) => q.status === "completed" || q.status === "failed");
    for (const [key] of toDelete) {
      if (pendingQuestions.size <= 50) break;
      pendingQuestions.delete(key);
    }
  }
}, 5 * 60 * 1000);

// Clean up stale delegation trackers every 10 minutes
// Trackers are kept for logging/hints only; enforcement is context-% based
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
  for (const [sid, tracker] of delegationTrackers) {
    if (new Date(tracker.createdAt).getTime() < cutoff && !sessions.has(sid)) {
      delegationTrackers.delete(sid);
    }
  }
}, 10 * 60 * 1000);

// Clean up stale coordinator requests every 2 minutes
// Entries stuck at "running" past their timeout are marked "stale"
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of coordinatorRequests) {
    if (entry.status !== "running") continue;
    const age = now - new Date(entry.createdAt).getTime();
    const timeout = (entry.request?.timeout || 300) * 1000; // default 5min
    const grace = 2 * 60 * 1000; // 2min grace period beyond timeout
    if (age > timeout + grace) {
      entry.status = "stale";
      entry.updatedAt = new Date().toISOString();
      log("info", `[coordinator] Marked stale: ${id} (running ${Math.round(age/1000)}s, timeout was ${timeout/1000}s)`);
      broadcast({ type: "coordinator_response", id, response: { status: "stale", result: "Task exceeded timeout" } });
    }
  }
}, 2 * 60 * 1000);

// Run eval housekeeping every 12 hours (also runs on startup after 60s delay)
const HOUSEKEEPING_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours
function runHousekeeping() {
  fetchAnthropicRateLimits();
  const script = join(__dirname, 'scripts', 'eval-housekeeping.js');
  if (!existsSync(script)) return;
  log('info', 'Running eval housekeeping...');
  const child = spawn(process.execPath, [script], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', err => {
    log('warn', `Housekeeping spawn error: ${err.message}`);
  });
  let output = '';
  child.stdout.on('data', d => output += d);
  child.stderr.on('data', d => output += d);
  child.on('close', code => {
    if (code === 0) {
      log('info', 'Housekeeping completed successfully');
    } else {
      log('warn', `Housekeeping exited with code ${code}: ${output.substring(0, 200)}`);
    }
  });
}
setTimeout(runHousekeeping, 60_000);  // First run 60s after startup
setInterval(runHousekeeping, HOUSEKEEPING_INTERVAL);

// ─── Anthropic Rate Limits ───────────────────────────────────────────────────

let globalRateLimits = null;

function getAnthropicAuth() {
  // Try API key first
  if (process.env.ANTHROPIC_API_KEY) return { "x-api-key": process.env.ANTHROPIC_API_KEY };
  // Fall back to Claude Code OAuth credentials
  try {
    const credsPath = join(process.env.HOME || "/root", ".claude", ".credentials.json");
    const creds = JSON.parse(readFileSync(credsPath, "utf-8"));
    const oauth = creds.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    // Skip if token expired (with 60s buffer)
    if (oauth.expiresAt && Date.now() > oauth.expiresAt - 60_000) {
      log("info", "Claude OAuth token expired, skipping rate limit fetch");
      return null;
    }
    return { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20" };
  } catch { return null; }
}

async function fetchAnthropicRateLimits() {
  const auth = getAnthropicAuth();
  if (!auth) return;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        ...auth,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const h = (name) => resp.headers.get(name);
    const toFloat = (v) => (v !== null ? parseFloat(v) : null);

    const limits = {
      fiveHourUtilization: toFloat(h("anthropic-ratelimit-unified-5h-utilization")),
      fiveHourStatus:      h("anthropic-ratelimit-unified-5h-status"),
      fiveHourReset:       h("anthropic-ratelimit-unified-5h-reset"),
      sevenDayUtilization: toFloat(h("anthropic-ratelimit-unified-7d-utilization")),
      sevenDayStatus:      h("anthropic-ratelimit-unified-7d-status"),
      sevenDayReset:       h("anthropic-ratelimit-unified-7d-reset"),
      representativeClaim: h("anthropic-ratelimit-unified-representative-claim"),
      fallback:            h("anthropic-ratelimit-unified-fallback"),
      overageStatus:       h("anthropic-ratelimit-unified-overage-status"),
      fetchedAt:           new Date().toISOString(),
    };

    // Only update if we got meaningful data
    if (limits.fiveHourUtilization !== null || limits.sevenDayUtilization !== null) {
      globalRateLimits = limits;
      const pct5h = limits.fiveHourUtilization !== null ? Math.round(limits.fiveHourUtilization * 100) : "?";
      const pct7d = limits.sevenDayUtilization !== null ? Math.round(limits.sevenDayUtilization * 100) : "?";
      log("info", `Anthropic rate limits: 5h ${pct5h}%, 7d ${pct7d}%`);
      broadcast({ type: "global_rate_limits", limits: globalRateLimits });
    } else {
      log("info", "Anthropic rate limit headers not present in response");
    }
  } catch (err) {
    log("warn", `fetchAnthropicRateLimits failed: ${err.message}`);
  }
}

// Fetch rate limits on startup (after 5s) and every 10 minutes
setTimeout(fetchAnthropicRateLimits, 5_000);
setInterval(fetchAnthropicRateLimits, 10 * 60 * 1000);

// ─── Web UI ──────────────────────────────────────────────────────────────────

let WEB_UI;
try {
  WEB_UI = (await readFile(resolve(__dirname, "web-ui.html"), "utf-8"));
} catch (e) {
  WEB_UI = "<html><body><h1>Error: web-ui.html not found</h1><p>" + e.message + "</p></body></html>";
}

let USAGE_GUIDE;
try {
  USAGE_GUIDE = (await readFile(resolve(__dirname, "docs/usage-guide.html"), "utf-8"));
} catch (e) {
  USAGE_GUIDE = "<html><body><h1>Error: docs/usage-guide.html not found</h1><p>" + e.message + "</p></body></html>";
}
// Old inline UI removed — now served from web-ui.html
// To revert: replace the readFile above with the old const WEB_UI = `...` template

server.listen(PORT, "0.0.0.0", () => {
  log("info", `Supervisor ${SUPERVISOR_VERSION} running on http://0.0.0.0:${PORT} (mode=${SUPERVISOR_MODE})`);
  log("info", `AI eval backend: ${EVAL_BACKEND}${EVAL_BACKEND === 'ollama' ? ` (${OLLAMA_MODEL} default, ${OLLAMA_TRUSTED_MODELS.length} trusted models, at ${OLLAMA_URL})` : ''}`);
  if (AUTH_ENABLED) {
    log("info", "Auth enabled — dashboard requires password login");
  } else {
    log("warn", "Auth disabled (SUPERVISOR_PASSWORD not set) — dashboard is open to anyone on the network");
  }
});
