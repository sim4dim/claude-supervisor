/**
 * mcp-pii-server.js — MCP server wrapping file/shell tools with bidirectional PII scrubbing.
 *
 * Outbound (data → Claude): execute real operation, SCRUB output before returning to Claude.
 * Inbound (Claude → execution): RESTORE tokens in Claude's input back to real values before executing.
 *
 * Claude never sees real PII. Files on disk always have real values.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import { getOrCreateSanitizer } from './pii-sanitizer.js';

const execAsync = promisify(exec);

// ─── Config ──────────────────────────────────────────────────────────────────

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const CONFIG_PATH = path.join(__dirname, 'data', 'pii-config.json');

function loadPiiConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { enabled: true, mode: 'structured', types: { IPv4: true, IPv6: true, MAC: true, EMAIL: true, HOST: true, PHONE: true }, projects: {} };
  }
}

const config = loadPiiConfig();
const projectName = path.basename(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const projectOverride = config.projects?.[projectName] ?? {};
const effectiveMode = projectOverride.mode ?? config.mode ?? 'structured';
const effectiveTypes = { ...config.types, ...projectOverride.types };

// ─── Session ID ───────────────────────────────────────────────────────────────

const SESSION_ID = process.env.PII_SESSION_ID
  ?? `mcp-${Math.random().toString(36).slice(2, 10)}`;

process.stderr.write(`[pii-mcp] Starting session=${SESSION_ID} mode=${effectiveMode} project=${projectName}\n`);
process.stderr.write(`[pii-mcp] Types: ${Object.entries(effectiveTypes).filter(([,v]) => v).map(([k]) => k).join(', ')}\n`);

const sanitizer = getOrCreateSanitizer(SESSION_ID, { mode: effectiveMode, types: effectiveTypes });

// ─── Working directory ────────────────────────────────────────────────────────

const WORK_DIR = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

function resolvePath(p) {
  if (!p) return WORK_DIR;
  return path.isAbsolute(p) ? p : path.resolve(WORK_DIR, p);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scrubAndSave(text) {
  const result = sanitizer.scrub(text);
  sanitizer.save();
  return result;
}

function logTool(name, summary) {
  process.stderr.write(`[pii-mcp] ${name}: ${summary}\n`);
}

function textContent(text) {
  return { content: [{ type: 'text', text }] };
}

function errorContent(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: 'pii-tools', version: '1.0.0' },
  { capabilities: {} }
);

// ─── pii_read ─────────────────────────────────────────────────────────────────

server.registerTool('pii_read', {
  description: 'Read a file with PII scrubbing. Output has real PII replaced with tokens.',
  inputSchema: {
    file_path: z.string().describe('Absolute or relative path to the file'),
    offset: z.number().int().min(0).optional().describe('Line to start reading from (0-indexed)'),
    limit: z.number().int().min(1).optional().describe('Number of lines to read'),
  },
}, async ({ file_path, offset, limit }) => {
  try {
    // Restore any tokens Claude might have used in the path
    const realPath = resolvePath(sanitizer.restore(file_path));

    let content;
    try {
      content = fs.readFileSync(realPath, 'utf8');
    } catch (err) {
      return errorContent(`Cannot read file: ${scrubAndSave(err.message)}`);
    }

    const lines = content.split('\n');
    const start = offset ?? 0;
    const end = limit != null ? start + limit : lines.length;
    const slice = lines.slice(start, end);

    // Format with line numbers like cat -n (1-indexed from start+1)
    const numbered = slice.map((line, i) => {
      const lineNum = String(start + i + 1).padStart(4, ' ');
      return `${lineNum}\t${line}`;
    }).join('\n');

    const scrubbed = scrubAndSave(numbered);
    logTool('pii_read', `${realPath} → ${sanitizer.summary()}`);
    return textContent(scrubbed);
  } catch (err) {
    return errorContent(scrubAndSave(String(err)));
  }
});

// ─── pii_bash ─────────────────────────────────────────────────────────────────

server.registerTool('pii_bash', {
  description: 'Run a shell command with PII scrubbing. Tokens in the command are restored before execution; output is scrubbed before returning.',
  inputSchema: {
    command: z.string().describe('Shell command to execute'),
    timeout: z.number().int().min(1).max(120000).optional().describe('Timeout in ms (default 60000, max 120000)'),
  },
}, async ({ command, timeout }) => {
  try {
    const realCommand = sanitizer.restore(command);
    const ms = Math.min(timeout ?? 60000, 120000);

    let combined;
    try {
      const { stdout, stderr } = await execAsync(realCommand, {
        cwd: WORK_DIR,
        timeout: ms,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
      });
      combined = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
    } catch (err) {
      // Command failed — scrub error output too
      const errOut = [err.stdout, err.stderr, err.message]
        .filter(Boolean).join('\n');
      const scrubbed = scrubAndSave(errOut);
      logTool('pii_bash', `FAILED: ${sanitizer.summary()}`);
      return { content: [{ type: 'text', text: scrubbed }], isError: true };
    }

    const scrubbed = scrubAndSave(combined);
    logTool('pii_bash', `ok → ${sanitizer.summary()}`);
    return textContent(scrubbed);
  } catch (err) {
    return errorContent(scrubAndSave(String(err)));
  }
});

// ─── pii_grep ─────────────────────────────────────────────────────────────────

server.registerTool('pii_grep', {
  description: 'Search file contents with ripgrep, with PII scrubbing on output.',
  inputSchema: {
    pattern: z.string().describe('Regex pattern to search for'),
    path: z.string().optional().describe('File or directory to search'),
    glob: z.string().optional().describe('Glob pattern to filter files (rg --glob)'),
    include: z.string().optional().describe('Alias for glob'),
    context: z.number().int().min(0).optional().describe('Lines of context around each match'),
    max_results: z.number().int().min(1).optional().describe('Maximum result lines (default 50)'),
  },
}, async ({ pattern, path: searchPath, glob, include, context, max_results }) => {
  try {
    const realPattern = sanitizer.restore(pattern);
    const realPath = searchPath ? resolvePath(sanitizer.restore(searchPath)) : WORK_DIR;

    const args = ['rg', '--no-heading', '-n'];
    if (context) args.push(`-C${context}`);

    const globPattern = glob ?? include;
    if (globPattern) args.push('--glob', globPattern);

    args.push('--', realPattern, realPath);

    const maxLines = max_results ?? 50;

    let output;
    try {
      const { stdout } = await execAsync(args.join(' '), {
        cwd: WORK_DIR,
        timeout: 30000,
      });
      output = stdout.split('\n').slice(0, maxLines).join('\n');
    } catch (err) {
      if (err.code === 1) {
        // rg exits 1 for no matches — not an error
        output = '(no matches)';
      } else {
        return errorContent(scrubAndSave(err.message ?? String(err)));
      }
    }

    const scrubbed = scrubAndSave(output);
    logTool('pii_grep', `pattern=${realPattern} → ${sanitizer.summary()}`);
    return textContent(scrubbed);
  } catch (err) {
    return errorContent(scrubAndSave(String(err)));
  }
});

// ─── pii_glob ─────────────────────────────────────────────────────────────────

server.registerTool('pii_glob', {
  description: 'Find files by glob pattern with PII scrubbing on returned paths.',
  inputSchema: {
    pattern: z.string().describe('Glob pattern (e.g. "**/*.js")'),
    path: z.string().optional().describe('Directory to search in'),
  },
}, async ({ pattern, path: searchPath }) => {
  try {
    const realPattern = sanitizer.restore(pattern);
    const realPath = searchPath ? resolvePath(sanitizer.restore(searchPath)) : WORK_DIR;

    // Use find for portability
    let output;
    try {
      const { stdout } = await execAsync(
        `find ${JSON.stringify(realPath)} -type f -name ${JSON.stringify(realPattern.split('/').pop() ?? '*')} 2>/dev/null | sort`,
        { cwd: WORK_DIR, timeout: 30000 }
      );
      output = stdout.trim();
    } catch (err) {
      return errorContent(scrubAndSave(err.message ?? String(err)));
    }

    if (!output) output = '(no files found)';

    const scrubbed = scrubAndSave(output);
    logTool('pii_glob', `pattern=${realPattern} → ${sanitizer.summary()}`);
    return textContent(scrubbed);
  } catch (err) {
    return errorContent(scrubAndSave(String(err)));
  }
});

// ─── pii_write ────────────────────────────────────────────────────────────────

server.registerTool('pii_write', {
  description: 'Write a file. Tokens in file_path and content are restored to real values before writing. Files on disk always contain real values.',
  inputSchema: {
    file_path: z.string().describe('Absolute or relative path to write'),
    content: z.string().describe('Content to write (may contain PII tokens that will be restored)'),
  },
}, async ({ file_path, content }) => {
  try {
    const realPath = resolvePath(sanitizer.restore(file_path));
    const realContent = sanitizer.restore(content);

    // Ensure parent directory exists
    const dir = path.dirname(realPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(realPath, realContent, 'utf8');

    const scrubPath = scrubAndSave(realPath);
    logTool('pii_write', `wrote ${realPath} (${realContent.length} bytes)`);
    return textContent(`Written: ${scrubPath}`);
  } catch (err) {
    return errorContent(scrubAndSave(String(err)));
  }
});

// ─── pii_edit ─────────────────────────────────────────────────────────────────

server.registerTool('pii_edit', {
  description: 'Edit a file by exact string replacement. Tokens are restored before applying the edit. Errors if old_string not found or not unique.',
  inputSchema: {
    file_path: z.string().describe('Absolute or relative path to the file'),
    old_string: z.string().describe('Exact string to find (may contain PII tokens)'),
    new_string: z.string().describe('Replacement string (may contain PII tokens)'),
  },
}, async ({ file_path, old_string, new_string }) => {
  try {
    const realPath = resolvePath(sanitizer.restore(file_path));
    const realOld = sanitizer.restore(old_string);
    const realNew = sanitizer.restore(new_string);

    let fileContent;
    try {
      fileContent = fs.readFileSync(realPath, 'utf8');
    } catch (err) {
      return errorContent(`Cannot read file: ${scrubAndSave(err.message)}`);
    }

    // Count occurrences
    let idx = fileContent.indexOf(realOld);
    if (idx === -1) {
      return errorContent(`old_string not found in ${scrubAndSave(realPath)}`);
    }
    const secondIdx = fileContent.indexOf(realOld, idx + 1);
    if (secondIdx !== -1) {
      return errorContent(`old_string is not unique — found at multiple positions in ${scrubAndSave(realPath)}`);
    }

    const updated = fileContent.slice(0, idx) + realNew + fileContent.slice(idx + realOld.length);
    fs.writeFileSync(realPath, updated, 'utf8');

    // Show a few lines of context around the edit (scrubbed)
    const lines = updated.split('\n');
    const editLine = updated.slice(0, idx).split('\n').length - 1;
    const ctxStart = Math.max(0, editLine - 2);
    const ctxEnd = Math.min(lines.length, editLine + realNew.split('\n').length + 2);
    const context = lines.slice(ctxStart, ctxEnd)
      .map((l, i) => `${String(ctxStart + i + 1).padStart(4, ' ')}\t${l}`)
      .join('\n');

    const scrubPath = scrubAndSave(realPath);
    const scrubContext = scrubAndSave(context);
    logTool('pii_edit', `edited ${realPath} → ${sanitizer.summary()}`);
    return textContent(`Edited: ${scrubPath}\n\n${scrubContext}`);
  } catch (err) {
    return errorContent(scrubAndSave(String(err)));
  }
});

// ─── pii_lookup ───────────────────────────────────────────────────────────────

server.registerTool('pii_lookup', {
  description: 'Inspect the PII lookup table. If token is provided, returns the real value for debugging. Otherwise returns a type/count summary (safe to return to Claude).',
  inputSchema: {
    token: z.string().optional().describe('Specific token to look up (e.g. "[IPv4-001]")'),
  },
}, async ({ token }) => {
  try {
    if (token) {
      const real = sanitizer.tokenToReal.get(token);
      if (!real) {
        return textContent(`Token ${token} not found in lookup table`);
      }
      // Return real value — this tool is for user/debug use, not Claude's normal workflow
      return textContent(`${token} → ${real}`);
    }

    // Return summary only — types and counts, not real values
    const { totalMasked, byType } = sanitizer.stats();
    if (totalMasked === 0) {
      return textContent('Lookup table is empty — no PII has been masked yet');
    }
    const lines = [
      `Session: ${SESSION_ID}`,
      `Total unique items masked: ${totalMasked}`,
      '',
      'By type:',
      ...Object.entries(byType).map(([type, count]) => `  ${type}: ${count}`),
    ];
    return textContent(lines.join('\n'));
  } catch (err) {
    return errorContent(String(err));
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[pii-mcp] Ready (session=${SESSION_ID}, workdir=${WORK_DIR})\n`);
}

main().catch(err => {
  process.stderr.write(`[pii-mcp] Fatal: ${err}\n`);
  process.exit(1);
});
