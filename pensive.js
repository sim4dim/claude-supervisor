import { randomUUID, createHash } from "crypto";
import { mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db = null;
let enabled = false;
let _DatabaseSync = null;

// Attempt to load node:sqlite (Node 22.5+) synchronously
try {
  const m = await import("node:sqlite");
  _DatabaseSync = m.DatabaseSync;
} catch {}

const SCHEMA_STMTS = [
  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    compact_form TEXT,
    type TEXT NOT NULL DEFAULT 'discovery',
    scope TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('world', 'project')),
    project TEXT,
    tier TEXT NOT NULL DEFAULT 'L2' CHECK(tier IN ('L0', 'L1', 'L2', 'L3')),
    content_type TEXT NOT NULL DEFAULT 'architectural',
    source TEXT,
    session_id TEXT,
    agent_id TEXT,
    vitality REAL NOT NULL DEFAULT 1.0,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived', 'superseded')),
    content_hash TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content, compact_form, tags,
    content=memories, content_rowid=rowid
  )`,
  `CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, compact_form, tags)
    VALUES (new.rowid, new.content, new.compact_form, new.tags);
  END`,
  `CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, compact_form, tags)
    VALUES ('delete', old.rowid, old.content, old.compact_form, old.tags);
  END`,
  `CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories
    WHEN old.content != new.content OR old.compact_form != new.compact_form OR old.tags != new.tags
  BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, compact_form, tags)
    VALUES ('delete', old.rowid, old.content, old.compact_form, old.tags);
    INSERT INTO memories_fts(rowid, content, compact_form, tags)
    VALUES (new.rowid, new.content, new.compact_form, new.tags);
  END`,
  `CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash)`,
];

function openDB() {
  if (!_DatabaseSync) return null;
  try {
    const dbPath = process.env.PENSIVE_DB_PATH || join(__dirname, "data", "pensive.db");
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
    const d = new _DatabaseSync(dbPath);
    d.exec("PRAGMA journal_mode=WAL");
    d.exec("PRAGMA busy_timeout=3000");
    for (const stmt of SCHEMA_STMTS) d.exec(stmt);
    // Recreate the UPDATE trigger if it exists without the WHEN clause
    d.exec("DROP TRIGGER IF EXISTS memories_au");
    d.exec(SCHEMA_STMTS[4]);
    enabled = true;
    return d;
  } catch (_) {
    return null;
  }
}

function getDB() {
  if (!db) db = openDB();
  return db;
}

function initPensive() {
  if (db) return { enabled: true };
  if (!_DatabaseSync) return { enabled: false, reason: "node:sqlite not available — requires Node.js 22.5+" };
  db = openDB();
  if (db) return { enabled: true };
  return { enabled: false, reason: "Failed to open database" };
}

// --- Decay ---

const VOLATILE_TYPES = new Set(["discovery", "error", "decision"]);

function lambdaFor(type) {
  return VOLATILE_TYPES.has(type) ? 0.02 : 0.005;
}

function applyDecay(row) {
  const days = (Date.now() - new Date(row.updated_at + "Z").getTime()) / 86400000;
  return row.vitality * Math.exp(-lambdaFor(row.type) * days);
}

function archiveIfDecayed(d, row, decayed) {
  if (decayed < 0.1) {
    d.prepare("UPDATE memories SET status='archived' WHERE id=?").run(row.id);
  }
}

// --- Compression ---

function compress(text, type = "") {
  const prefixes = {
    infrastructure: "INFRA:", discovery: "DISC:", error: "ERR:",
    convention: "CONV:", preference: "PREF:", decision: "DEC:", fact: "FACT:",
  };
  const prefix = prefixes[type] || "MEM:";
  // Strip articles and filler words only — require whitespace boundaries to avoid corrupting paths/identifiers
  let c = text
    .replace(/(?<=\s|^)(the|a|an)(?=\s|$)/gi, "")
    .replace(/(?<=\s|^)(basically|actually|essentially|just|really|very|quite)(?=\s|$)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return prefix + " " + c;
}

function contentHash(content) {
  return createHash("sha256").update(content).digest("hex");
}

function isNegativeFinding(content) {
  if (!content || content.length < 10) return true;
  return /^no (unexpected|unusual|notable)/i.test(content) ||
    /nothing (unusual|unexpected|notable)/i.test(content) ||
    /\b(matches docs|no issues|everything looks good|nothing unusual|no problems found|all checks pass|as expected|working correctly|no changes needed|confirmed working)\b/i.test(content);
}

// --- Public API ---

function remember({
  content, type = "discovery", scope = "project", project,
  tier = "L2", content_type = "architectural", source,
  session_id, agent_id, tags = [],
}) {
  if (!content || typeof content !== 'string') return { action: "error", reason: "content must be a non-empty string" };
  const d = getDB();
  if (!d) return { action: "noop", reason: "pensive disabled" };
  try {
    const normalized = content.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim();
    const hash = contentHash(normalized);
    const existing = d.prepare(
      "SELECT id FROM memories WHERE content_hash=? AND status='active' LIMIT 1"
    ).get(hash);
    if (existing) {
      d.prepare("UPDATE memories SET vitality=1.0, updated_at=datetime('now') WHERE id=?").run(existing.id);
      return { action: "refreshed", id: existing.id };
    }
    const effectiveTier = isNegativeFinding(content) ? "L3" : tier;
    const id = randomUUID();
    const compact_form = compress(content, type);
    const tagsJson = JSON.stringify(Array.isArray(tags) ? tags : []);
    d.prepare(`INSERT INTO memories
      (id, content, compact_form, type, scope, project, tier, content_type,
       source, session_id, agent_id, vitality, status, content_hash, tags)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1.0,'active',?,?)`
    ).run(id, content, compact_form, type, scope, project ?? null, effectiveTier,
      content_type, source ?? null, session_id ?? null, agent_id ?? null, hash, tagsJson);
    return { action: "created", id };
  } catch (err) {
    return { action: "error", reason: err.message };
  }
}

function recall({ query, project, scope, type, limit = 10, startup = false } = {}) {
  const d = getDB();
  if (!d) return [];
  try {
    let rows;
    if (startup) {
      const params = [];
      let sql = "SELECT * FROM memories WHERE status='active' AND tier IN ('L0','L1','L2')";
      if (project) { sql += " AND (project=? OR scope='world')"; params.push(project); }
      if (type) { sql += " AND type=?"; params.push(type); }
      sql += " ORDER BY tier ASC, vitality DESC";
      sql += " LIMIT ?"; params.push(limit);
      const all = d.prepare(sql).all(...params);
      // Token budget ~750 tokens (~3000 chars), but never exceed limit
      let budget = 3000;
      let rowCount = 0;
      rows = all.filter(row => {
        if (rowCount >= limit || budget <= 0) return false;
        budget -= (row.compact_form || row.content || "").length;
        if (budget >= 0) { rowCount++; return true; }
        return false;
      });
    } else if (query) {
      const safeQuery = query.split(/\s+/).filter(Boolean).map(t => '"' + t.replace(/"/g, '""') + '"').join(' ');
      const ftsRows = d.prepare(
        "SELECT rowid FROM memories_fts WHERE memories_fts MATCH ? LIMIT ?"
      ).all(safeQuery, limit * 2);
      if (!ftsRows.length) return [];
      const rowids = ftsRows.map(r => r.rowid);
      const placeholders = rowids.map(() => "?").join(",");
      let sql = `SELECT * FROM memories WHERE rowid IN (${placeholders}) AND status='active'`;
      const params = [...rowids];
      if (project) { sql += " AND (project=? OR scope='world')"; params.push(project); }
      if (scope) { sql += " AND scope=?"; params.push(scope); }
      if (type) { sql += " AND type=?"; params.push(type); }
      sql += " LIMIT ?"; params.push(limit);
      rows = d.prepare(sql).all(...params);
    } else {
      const params = [];
      let sql = "SELECT * FROM memories WHERE status='active'";
      if (project) { sql += " AND (project=? OR scope='world')"; params.push(project); }
      if (scope) { sql += " AND scope=?"; params.push(scope); }
      if (type) { sql += " AND type=?"; params.push(type); }
      sql += " ORDER BY vitality DESC LIMIT ?"; params.push(limit);
      rows = d.prepare(sql).all(...params);
    }
    return rows
      .map(row => {
        const decayed = applyDecay(row);
        archiveIfDecayed(d, row, decayed);
        return { ...row, vitality: decayed };
      })
      .filter(r => r.vitality >= 0.1);
  } catch (_) {
    return [];
  }
}

function supersede(oldId, newContent) {
  const d = getDB();
  if (!d) return { action: "noop", reason: "pensive disabled" };
  try {
    const old = d.prepare("SELECT * FROM memories WHERE id=?").get(oldId);
    if (!old) return { action: "error", reason: "original not found" };
    d.prepare("UPDATE memories SET status='superseded', updated_at=datetime('now') WHERE id=?").run(oldId);
    if (!newContent) return { action: "archived", id: oldId };
    return remember({
      content: newContent, type: old.type, scope: old.scope,
      project: old.project, tier: old.tier, content_type: old.content_type,
    });
  } catch (err) {
    return { action: "error", reason: err.message };
  }
}

function runDecay() {
  const d = getDB();
  if (!d) return { archived: 0, deleted: 0 };
  try {
    const active = d.prepare("SELECT * FROM memories WHERE status='active'").all();
    let archived = 0;
    for (const row of active) {
      const decayed = applyDecay(row);
      if (decayed < 0.1) {
        // Archive and store decayed vitality — do NOT update updated_at (decay timer uses it)
        d.prepare("UPDATE memories SET status='archived', vitality=? WHERE id=?")
          .run(decayed, row.id);
        archived++;
      } else {
        // Persist decayed vitality and reset updated_at so next sweep decays from now, not creation
        d.prepare("UPDATE memories SET vitality=?, updated_at=datetime('now') WHERE id=?").run(decayed, row.id);
      }
    }
    const { count: deleted } = d.prepare(
      "SELECT COUNT(*) as count FROM memories WHERE status='archived' AND updated_at < datetime('now','-90 days')"
    ).get();
    d.prepare(
      "DELETE FROM memories WHERE status='archived' AND updated_at < datetime('now','-90 days')"
    ).run();
    return { archived, deleted };
  } catch (err) {
    return { archived: 0, deleted: 0, error: err.message };
  }
}

function getStats() {
  const d = getDB();
  if (!d) return { enabled: false };
  try {
    return {
      byScope: d.prepare("SELECT scope, COUNT(*) as count FROM memories WHERE status='active' GROUP BY scope").all(),
      byType: d.prepare("SELECT type, COUNT(*) as count FROM memories WHERE status='active' GROUP BY type").all(),
      byStatus: d.prepare("SELECT status, COUNT(*) as count FROM memories GROUP BY status").all(),
      byTier: d.prepare("SELECT tier, COUNT(*) as count FROM memories WHERE status='active' GROUP BY tier").all(),
    };
  } catch (err) {
    return { error: err.message };
  }
}

function updateCompactForm(id, compactForm) {
  const d = getDB();
  if (!d) return;
  try {
    d.prepare("UPDATE memories SET compact_form=? WHERE id=?").run(compactForm, id);
  } catch {}
}

export { initPensive, remember, recall, supersede, runDecay, getStats, compress, updateCompactForm };
