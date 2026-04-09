/**
 * pii-sanitizer.js — Reversible PII masking for the Anthropic API proxy.
 *
 * Scrubs PII (IPs, MACs, emails, hostnames, phones) from API request bodies
 * before they reach Anthropic, with token → real value restoration for display.
 *
 * Modes:
 *   'token'      — replaces with bracket tokens like [IPv4-001] (default)
 *   'structured' — replaces with structurally valid fake values that preserve
 *                  subnet/OUI relationships for cross-log correlation
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Constants ────────────────────────────────────────────────────────────────

const TABLES_DIR = path.join(__dirname, 'data', 'pii-tables');
const TABLE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Emails excluded from masking (known bot/system addresses)
const EXCLUDED_EMAILS = new Set([
  'noreply@anthropic.com',
  'no-reply@anthropic.com',
  'notifications@github.com',
  'noreply@github.com',
  'support@github.com',
  'mailer-daemon@googlemail.com',
]);

// Public domains whose hostnames are NOT PII
const PUBLIC_DOMAINS = new Set([
  'github.com', 'anthropic.com', 'npmjs.com', 'npm.com',
  'google.com', 'googleapis.com', 'stackoverflow.com',
  'amazon.com', 'amazonaws.com', 'cloudflare.com',
  'nodejs.org', 'openai.com', 'microsoft.com', 'azure.com',
  'debian.org', 'ubuntu.com', 'archlinux.org', 'pypi.org',
  'docker.com', 'hub.docker.com', 'gitlab.com',
]);

// ─── Pre-compiled regexes ─────────────────────────────────────────────────────

// MAC: 6 pairs of hex digits separated by : or -
// Non-global copy is used inside replacer to avoid lastIndex issues; global for replace()
const RE_MAC = /\b([0-9a-fA-F]{2}[:\-]){5}[0-9a-fA-F]{2}\b/g;

// IPv4: validate octets 0-255 in the replacer
const RE_IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

// IPv6: full (8 groups) and abbreviated forms (::).
// Content-consuming alternatives come BEFORE the trailing-:: alternatives:
// JS alternation is leftmost-wins, so "(?:hex:){1,7}:" would greedily match
// "2001:db8::" and leave the trailing content unmatched if placed first.
const RE_IPV6 = /(?:\[)?(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}|:(?::[0-9a-fA-F]{1,4}){1,7}|(?:[0-9a-fA-F]{1,4}:){1,7}:|::)(?:\])?/g;

// Email: standard RFC-ish email
const RE_EMAIL = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g;

// Internal hostnames: conservative — requires infra-looking TLD keyword
const RE_HOST = /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+(?:internal|local|corp|lan|home|intranet|priv|prod|staging|dev|infra)\b/gi;

// Phone numbers: US and international variations
const RE_PHONE = /(?:\+\d{1,3}[\s\-]?)?\(?\d{3}\)?[\s\-]\d{3}[\s\-]\d{4}\b|\+\d{1,3}[\s]?\d{2,4}[\s]?\d{3,4}[\s]?\d{3,4}\b/g;

// SSN: XXX-XX-XXXX with optional dashes/spaces
const RE_SSN = /\b(\d{3})[- ]?(\d{2})[- ]?(\d{4})\b/g;

// Names: capitalized words following PII-indicating field labels
const RE_NAME_CONTEXT = /(?:(?:full[_ ]?name|first[_ ]?name|last[_ ]?name|name|customer|patient|employee|user|contact|owner|applicant|recipient|beneficiary|subscriber|member|client|tenant|resident|passenger|caller|account[_ ]?holder)\s*[:=]\s*)([A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|[A-Z]\.?|(?:Jr|Sr|II|III|IV|MD|PhD)\.?))+)/gi;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isValidIPv4Octets(a, b, c, d) {
  return [a, b, c, d].every(n => {
    const v = parseInt(n, 10);
    return v >= 0 && v <= 255;
  });
}

function isExcludedIPv4(addr) {
  return addr === '127.0.0.1' || addr === '0.0.0.0';
}

function isExcludedIPv6(addr) {
  const norm = addr.replace(/^\[|\]$/g, '').trim();
  return norm === '::1' || norm === '0:0:0:0:0:0:0:1';
}

function isValidSSN(area, group, serial) {
  const a = parseInt(area, 10);
  const g = parseInt(group, 10);
  const s = parseInt(serial, 10);
  if (a === 0 || a === 666 || a >= 900) return false;
  if (g === 0) return false;
  if (s === 0) return false;
  return true;
}

function isPublicHostname(host) {
  const lower = host.toLowerCase();
  for (const pub of PUBLIC_DOMAINS) {
    if (lower === pub || lower.endsWith('.' + pub)) return true;
  }
  return false;
}

function tablePath(sessionId) {
  const safe = sessionId.replace(/[^a-zA-Z0-9\-_]/g, '_');
  return path.join(TABLES_DIR, `${safe}.json`);
}

function ensureTablesDir() {
  if (!fs.existsSync(TABLES_DIR)) {
    fs.mkdirSync(TABLES_DIR, { recursive: true });
  }
}

/**
 * Expand an abbreviated IPv6 address to full 8-group form.
 * e.g. "2001:db8::1" → "2001:0db8:0000:0000:0000:0000:0000:0001"
 */
function expandIPv6(addr) {
  // Strip surrounding brackets if present
  addr = addr.replace(/^\[|\]$/g, '');

  if (addr.includes('::')) {
    const [left, right] = addr.split('::');
    const leftGroups = left ? left.split(':') : [];
    const rightGroups = right ? right.split(':') : [];
    const missing = 8 - leftGroups.length - rightGroups.length;
    const middle = Array(missing).fill('0000');
    const all = [...leftGroups, ...middle, ...rightGroups];
    return all.map(g => g.padStart(4, '0')).join(':');
  }

  return addr.split(':').map(g => g.padStart(4, '0')).join(':');
}

// ─── PiiSanitizer ─────────────────────────────────────────────────────────────

export class PiiSanitizer {
  /**
   * @param {string} sessionId
   * @param {object} [opts]
   * @param {'token'|'structured'} [opts.mode='token'] - Substitution mode.
   *   'token': bracket tokens like [IPv4-001] (original behavior)
   *   'structured': structurally valid fake values preserving subnet/OUI relationships
   * @param {object} [opts.types] - Per-type enable/disable: { IPv4: true, MAC: false, ... }
   *   Missing keys default to true (scrub by default).
   */
  constructor(sessionId, { mode = 'token', types = {} } = {}) {
    this.sessionId = sessionId;
    this.mode = mode;
    // Per-type enable flags — default all enabled
    this.enabledTypes = {
      IPv4: true, IPv6: true, MAC: true, EMAIL: true, HOST: true, PHONE: true,
      SSN: true, NAME: true,
      ...types,
    };
    this.created = new Date().toISOString();
    this.realToToken = new Map(); // "localhost0" → "[IPv4-001]" or "1.2.3.4"
    this.tokenToReal = new Map(); // "[IPv4-001]" → "localhost0" or "1.2.3.4" → "localhost0"
    this.counters = { IPv4: 0, IPv6: 0, MAC: 0, EMAIL: 0, HOST: 0, PHONE: 0, SSN: 0, NAME: 0 };
    // Running scrub counts (lifetime, not reset between calls)
    this._scrubCounts = { IPv4: 0, IPv6: 0, MAC: 0, EMAIL: 0, HOST: 0, PHONE: 0, SSN: 0, NAME: 0 };

    // Structured mode maps — only initialized when needed
    if (mode === 'structured') {
      this.octetMap = new Map();       // "192" → "10", "168" → "42", etc.
      this.octetCounter = 1;           // next fake octet value to assign
      this.hexPairMap = new Map();     // "aa" → "02", "bb" → "05", etc.
      this.hexPairCounter = 1;         // next fake hex pair
      this.ipv6GroupMap = new Map();   // "2001" → "0001", etc.
      this.ipv6GroupCounter = 1;
    }
  }

  // Return the token for a real value, creating a new mapping if needed.
  _getToken(type, real) {
    if (this.realToToken.has(real)) {
      this._scrubCounts[type]++;
      return this.realToToken.get(real);
    }
    this.counters[type]++;
    const token = `[${type}-${String(this.counters[type]).padStart(3, '0')}]`;
    this.realToToken.set(real, token);
    this.tokenToReal.set(token, real);
    this._scrubCounts[type]++;
    return token;
  }

  /**
   * Per-octet IPv4 substitution for structured mode.
   * Same real octet → same fake octet. Preserves subnet relationships.
   * 0 → 0, 255 → 255. Other values get unique 1-254 assignments.
   */
  _substituteIPv4(realIP) {
    const octets = realIP.split('.');
    return octets.map(oct => {
      if (!this.octetMap.has(oct)) {
        if (oct === '0') {
          this.octetMap.set('0', '0');
        } else if (oct === '255') {
          this.octetMap.set('255', '255');
        } else {
          // Assign next unused value, skip 0 and 255
          let fake = this.octetCounter++;
          while (fake === 0 || fake === 255) fake = this.octetCounter++;
          if (fake > 254) fake = ((fake - 1) % 253) + 1; // wrap around, skip 0/255
          this.octetMap.set(oct, String(fake));
        }
      }
      return this.octetMap.get(oct);
    }).join('.');
  }

  /**
   * Per-pair MAC substitution for structured mode.
   * Same OUI (first 3 pairs) → same fake OUI.
   * 00:00:00:00:00:00 stays all-zeros. Locally-administered bit set on first octet.
   */
  _substituteMAC(realMAC) {
    // Normalize to lowercase colon-separated
    const pairs = realMAC.toLowerCase().split(/[:\-]/);
    return pairs.map((pair, idx) => {
      if (!this.hexPairMap.has(pair)) {
        if (pair === '00') {
          this.hexPairMap.set('00', '00'); // preserve zero for zero-MAC detection
        } else {
          let fake = this.hexPairCounter++;
          // Skip 00 (reserved for real zeros)
          if (fake === 0) fake = this.hexPairCounter++;
          const fakeHex = (fake % 256).toString(16).padStart(2, '0');
          this.hexPairMap.set(pair, fakeHex);
        }
      }
      let mapped = this.hexPairMap.get(pair);
      // Set locally-administered bit on first octet (bit 1 of first byte)
      // This marks the MAC as "not a real vendor MAC" — standard practice
      if (idx === 0 && pair !== '00') {
        const byte = parseInt(mapped, 16) | 0x02; // set LA bit
        mapped = byte.toString(16).padStart(2, '0');
      }
      return mapped;
    }).join(':');
  }

  /**
   * Per-group IPv6 substitution for structured mode.
   * Expands :: notation, then maps each 4-hex group individually.
   * 0000 stays 0000.
   */
  _substituteIPv6(realIPv6) {
    const expanded = expandIPv6(realIPv6);
    const groups = expanded.split(':');
    return groups.map(group => {
      if (!this.ipv6GroupMap.has(group)) {
        if (group === '0000') {
          this.ipv6GroupMap.set('0000', '0000');
        } else {
          const fake = this.ipv6GroupCounter++;
          this.ipv6GroupMap.set(group, fake.toString(16).padStart(4, '0'));
        }
      }
      return this.ipv6GroupMap.get(group);
    }).join(':');
  }

  /**
   * Scrub all PII from a string, returning the sanitized version.
   * Application order: MAC → IPv4 → IPv6 → EMAIL → HOST → PHONE
   * (MAC before IPv6 to avoid partial hex matches; IPv4 before HOST)
   */
  scrub(text) {
    if (!text || typeof text !== 'string') return text;

    // 1. MAC addresses — must go before IPv6 (hex groups can overlap)
    text = text.replace(RE_MAC, (match) => {
      if (!this.enabledTypes.MAC) return match;
      const normalized = match.toLowerCase();
      if (this.mode === 'structured') {
        if (this.realToToken.has(normalized)) {
          this._scrubCounts.MAC++;
          return this.realToToken.get(normalized);
        }
        const fake = this._substituteMAC(normalized);
        this.realToToken.set(normalized, fake);
        this.tokenToReal.set(fake, normalized);
        this.counters.MAC++;
        this._scrubCounts.MAC++;
        return fake;
      }
      return this._getToken('MAC', normalized);
    });
    RE_MAC.lastIndex = 0;

    // 2. IPv4 — validate octets so version strings like "2.1.90.0" aren't masked
    text = text.replace(RE_IPV4, (match, a, b, c, d) => {
      if (!this.enabledTypes.IPv4) return match;
      if (!isValidIPv4Octets(a, b, c, d)) return match;
      if (isExcludedIPv4(match)) return match;
      if (this.mode === 'structured') {
        if (this.realToToken.has(match)) {
          this._scrubCounts.IPv4++;
          return this.realToToken.get(match);
        }
        const fake = this._substituteIPv4(match);
        this.realToToken.set(match, fake);
        this.tokenToReal.set(fake, match);
        this.counters.IPv4++;
        this._scrubCounts.IPv4++;
        return fake;
      }
      return this._getToken('IPv4', match);
    });
    RE_IPV4.lastIndex = 0;

    // 3. IPv6
    text = text.replace(RE_IPV6, (match) => {
      if (!this.enabledTypes.IPv6) return match;
      if (!match.includes(':')) return match; // guard against empty regex match
      if (isExcludedIPv6(match)) return match;
      const normalized = match.toLowerCase();
      if (this.mode === 'structured') {
        if (this.realToToken.has(normalized)) {
          this._scrubCounts.IPv6++;
          return this.realToToken.get(normalized);
        }
        const fake = this._substituteIPv6(normalized);
        this.realToToken.set(normalized, fake);
        this.tokenToReal.set(fake, normalized);
        this.counters.IPv6++;
        this._scrubCounts.IPv6++;
        return fake;
      }
      return this._getToken('IPv6', normalized);
    });
    RE_IPV6.lastIndex = 0;

    // 4. Email — always use bracket tokens (no meaningful structure to preserve)
    text = text.replace(RE_EMAIL, (match) => {
      if (!this.enabledTypes.EMAIL) return match;
      if (EXCLUDED_EMAILS.has(match.toLowerCase())) return match;
      return this._getToken('EMAIL', match.toLowerCase());
    });
    RE_EMAIL.lastIndex = 0;

    // 5. Internal hostnames (conservative — only infra-keyword TLDs)
    // Always use bracket tokens
    text = text.replace(RE_HOST, (match) => {
      if (!this.enabledTypes.HOST) return match;
      if (isPublicHostname(match)) return match;
      return this._getToken('HOST', match.toLowerCase());
    });
    RE_HOST.lastIndex = 0;

    // 6. Phone numbers — always use bracket tokens
    text = text.replace(RE_PHONE, (match) => {
      if (!this.enabledTypes.PHONE) return match;
      // Require at least 10 digits to avoid matching port numbers or short codes
      const digits = match.replace(/\D/g, '');
      if (digits.length < 10) return match;
      return this._getToken('PHONE', match.trim());
    });
    RE_PHONE.lastIndex = 0;

    // 7. SSN — after phone since 9-digit patterns could overlap with phone tails
    text = text.replace(RE_SSN, (match, area, group, serial) => {
      if (!this.enabledTypes.SSN) return match;
      if (!isValidSSN(area, group, serial)) return match;
      return this._getToken('SSN', match);
    });
    RE_SSN.lastIndex = 0;

    // 8. Names — context-triggered (after field labels only); goes last so earlier
    //    steps have already replaced IPs/emails within the same line
    text = text.replace(RE_NAME_CONTEXT, (fullMatch, nameCapture) => {
      if (!this.enabledTypes.NAME) return fullMatch;
      const token = this._getToken('NAME', nameCapture);
      // Replace only the captured name portion, keep the label prefix intact
      return fullMatch.replace(nameCapture, token);
    });
    RE_NAME_CONTEXT.lastIndex = 0;

    return text;
  }

  /**
   * Restore tokens back to real values (for terminal display).
   */
  restore(text) {
    if (!text || typeof text !== 'string' || this.tokenToReal.size === 0) return text;

    if (this.mode === 'structured') {
      // In structured mode, fake values are plain text (IPs, MACs) — not bracket tokens.
      // We need to check each known fake value against the text and replace it.
      // Sort by length descending to avoid partial replacements.
      const pairs = [...this.tokenToReal.entries()].sort((a, b) => b[0].length - a[0].length);
      for (const [fake, real] of pairs) {
        // Escape special regex characters in the fake value
        const escaped = fake.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(escaped, 'g'), real);
      }
      return text;
    }

    // Token mode: bracket tokens are safe to join into one regex
    const escaped = [...this.tokenToReal.keys()].map(t =>
      t.replace(/[[\]]/g, '\\$&')
    );
    const re = new RegExp(escaped.join('|'), 'g');
    return text.replace(re, (token) => this.tokenToReal.get(token) ?? token);
  }

  /**
   * Scrub an Anthropic API request body in place.
   * Handles messages[].content[], system prompt, and tool_use inputs.
   */
  scrubRequestBody(body) {
    if (!body || typeof body !== 'object') return body;

    // System prompt (string or array of text blocks)
    if (body.system) {
      if (typeof body.system === 'string') {
        body.system = this.scrub(body.system);
      } else if (Array.isArray(body.system)) {
        this._scrubContentBlocks(body.system);
      }
    }

    // Messages
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (!msg.content) continue;
        if (typeof msg.content === 'string') {
          msg.content = this.scrub(msg.content);
        } else if (Array.isArray(msg.content)) {
          this._scrubContentBlocks(msg.content);
        }
      }
    }

    return body;
  }

  /** Recursively scrub an array of Anthropic content blocks. */
  _scrubContentBlocks(blocks) {
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      switch (block.type) {
        case 'text':
          if (block.text) block.text = this.scrub(block.text);
          break;

        case 'tool_result':
          // content can be a string or nested array of text blocks
          if (typeof block.content === 'string') {
            block.content = this.scrub(block.content);
          } else if (Array.isArray(block.content)) {
            this._scrubContentBlocks(block.content);
          }
          break;

        case 'tool_use':
          // Scrub input values — commands often contain IPs or hostnames
          if (block.input && typeof block.input === 'object') {
            this._scrubObject(block.input);
          }
          break;

        default:
          // Catch-all for any block with a text field
          if (typeof block.text === 'string') {
            block.text = this.scrub(block.text);
          }
      }
    }
  }

  /** Recursively scrub string values in a plain object. */
  _scrubObject(obj) {
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (typeof val === 'string') {
        obj[key] = this.scrub(val);
      } else if (Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) {
          if (typeof val[i] === 'string') {
            val[i] = this.scrub(val[i]);
          } else if (val[i] && typeof val[i] === 'object') {
            this._scrubObject(val[i]);
          }
        }
      } else if (val && typeof val === 'object') {
        this._scrubObject(val);
      }
    }
  }

  /** Get stats about unique PII items masked so far. */
  stats() {
    const byType = {};
    let totalMasked = 0;
    for (const [type, count] of Object.entries(this.counters)) {
      if (count > 0) byType[type] = count;
      totalMasked += count;
    }
    return { totalMasked, byType, mode: this.mode };
  }

  /** One-line summary for proxy log (reflects lifetime unique items masked). */
  summary() {
    const parts = [];
    for (const [type, count] of Object.entries(this.counters)) {
      if (count > 0) parts.push(`${count} ${type}`);
    }
    if (parts.length === 0) return 'PII scrub: nothing masked';
    return `PII scrub: ${parts.join(', ')} masked`;
  }

  /** Persist the lookup table to disk. */
  save() {
    ensureTablesDir();
    const data = {
      sessionId: this.sessionId,
      mode: this.mode,
      created: this.created,
      lastUsed: new Date().toISOString(),
      counters: this.counters,
      enabledTypes: this.enabledTypes,
      mappings: [...this.realToToken.entries()],
    };

    // Persist structured maps if applicable
    if (this.mode === 'structured') {
      data.octetMap = [...this.octetMap.entries()];
      data.hexPairMap = [...this.hexPairMap.entries()];
      data.ipv6GroupMap = [...this.ipv6GroupMap.entries()];
      data.octetCounter = this.octetCounter;
      data.hexPairCounter = this.hexPairCounter;
      data.ipv6GroupCounter = this.ipv6GroupCounter;
    }

    fs.writeFileSync(tablePath(this.sessionId), JSON.stringify(data, null, 2), 'utf8');
  }

  /** Load table from disk. Returns null if not found or older than 24h. */
  static load(sessionId) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(tablePath(sessionId), 'utf8'));
    } catch {
      return null;
    }

    const lastUsed = new Date(data.lastUsed || data.created).getTime();
    if (Date.now() - lastUsed > TABLE_TTL_MS) {
      try { fs.unlinkSync(tablePath(sessionId)); } catch {}
      return null;
    }

    const mode = data.mode || 'token';
    const s = new PiiSanitizer(sessionId, { mode, types: data.enabledTypes || {} });
    s.created = data.created;
    s.counters = { ...s.counters, ...data.counters };
    for (const [real, token] of (data.mappings || [])) {
      s.realToToken.set(real, token);
      s.tokenToReal.set(token, real);
    }

    // Restore structured maps if applicable
    if (mode === 'structured') {
      if (data.octetMap) {
        for (const [k, v] of data.octetMap) s.octetMap.set(k, v);
      }
      if (data.hexPairMap) {
        for (const [k, v] of data.hexPairMap) s.hexPairMap.set(k, v);
      }
      if (data.ipv6GroupMap) {
        for (const [k, v] of data.ipv6GroupMap) s.ipv6GroupMap.set(k, v);
      }
      if (data.octetCounter != null) s.octetCounter = data.octetCounter;
      if (data.hexPairCounter != null) s.hexPairCounter = data.hexPairCounter;
      if (data.ipv6GroupCounter != null) s.ipv6GroupCounter = data.ipv6GroupCounter;
    }

    return s;
  }
}

// ─── Module-level cache and exports ──────────────────────────────────────────

const _cache = new Map();

/**
 * Get or create a PiiSanitizer for the given session.
 * Loads from disk if available; creates new if not.
 *
 * @param {string} sessionId
 * @param {object} [opts] - Options passed to PiiSanitizer constructor (e.g. { mode: 'structured' })
 */
export function getOrCreateSanitizer(sessionId, opts = {}) {
  const key = sessionId;
  if (_cache.has(key)) return _cache.get(key);
  const s = PiiSanitizer.load(sessionId) ?? new PiiSanitizer(sessionId, opts);
  _cache.set(key, s);
  return s;
}

/**
 * Delete table files older than 24 hours from disk. Returns count deleted.
 */
export function purgeOldTables() {
  ensureTablesDir();
  let deleted = 0;
  let files;
  try {
    files = fs.readdirSync(TABLES_DIR);
  } catch {
    return 0;
  }

  const cutoff = Date.now() - TABLE_TTL_MS;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(TABLES_DIR, file);
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      const lastUsed = new Date(data.lastUsed || data.created).getTime();
      if (lastUsed < cutoff) {
        fs.unlinkSync(full);
        deleted++;
        _cache.delete(data.sessionId);
      }
    } catch {
      // Corrupt or unreadable file — remove it
      try { fs.unlinkSync(full); deleted++; } catch {}
    }
  }
  return deleted;
}