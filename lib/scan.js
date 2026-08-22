'use strict';

const { promises: fs } = require('fs');
const path = require('path');

// Common MCP server config filenames across clients (project-scoped, checked-in).
const CONFIG_NAMES = ['.mcp.json', 'mcp.json', '.cursor/mcp.json', '.claude/settings.local.json'];

// Valid transport types per the MCP spec + aliases client tools accept.
const VALID_TYPES = new Set(['stdio', 'http', 'streamable-http', 'sse', 'ws']);
// Deprecated / discouraged transports.
const DEPRECATED_TYPES = new Set(['sse']);
// HTTP type aliases (spec calls it streamable-http; clients accept http).
const HTTP_TYPES = new Set(['http', 'streamable-http']);

// Reserved server names that clients skip at startup.
const RESERVED_NAMES = new Set(['workspace']);

// Field(s) required per transport type: { type -> [required props] }
const REQUIRED_BY_TRANSPORT = {
  stdio: ['command'],
  http: ['url'],
  'streamable-http': ['url'],
  sse: ['url'],
  ws: ['url'],
};

// Hardcoded-secret heuristic: a value that looks like a live credential rather
// than an env-var reference. Only flags values that are NOT ${...} expansions.
const SECRET_HINTS = ['sk-', 'sk_live', 'ghp_', 'gho_', 'xoxb-', 'AIza', 'eyJ', 'AKIA', 'Bearer '];

function looksLikeSecret(value) {
  const s = String(value);
  return SECRET_HINTS.some((hint) => s.includes(hint));
}

// Reasonably strict env-var reference check: ${VAR} or ${VAR:-default}.
function referencesEnv(value) {
  return /\$\{[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}/.test(String(value));
}

async function findConfigs(dir) {
  const found = [];
  for (const name of CONFIG_NAMES) {
    const full = path.join(dir, name);
    try {
      const stat = await fs.stat(full);
      if (stat.isFile()) found.push({ name, path: full, source: 'project' });
    } catch {
      // not present — ignore
    }
  }
  // Managed (org) config sits next to the CLI config; include if present.
  const managed = path.join(dir, 'managed-mcp.json');
  try {
    const stat = await fs.stat(managed);
    if (stat.isFile()) found.push({ name: 'managed-mcp.json', path: managed, source: 'managed' });
  } catch {
    /* ignore */
  }
  return found;
}

async function parseFile(file) {
  const raw = await fs.readFile(file.path, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { file, error: `invalid JSON: ${err.message}` };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { file, error: 'top-level value must be an object' };
  }
  if (typeof data.mcpServers !== 'object' || data.mcpServers === null || Array.isArray(data.mcpServers)) {
    return { file, error: 'missing "mcpServers" object' };
  }
  return { file, data };
}

function checkServer(name, cfg, file) {
  const issues = [];
  const findings = { name, issues: [], transport: 'unknown', command: null, url: null, packageNames: [] };

  if (RESERVED_NAMES.has(name)) {
    findings.issues.push({ severity: 'warning', code: 'reserved-name',
      message: 'server name "workspace" is reserved — the client skips this server at startup' });
  }

  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    findings.issues.push({ severity: 'error', code: 'invalid-entry',
      message: 'server entry must be an object' });
    return findings;
  }

  // Transport type.
  const rawType = cfg.type;
  if (rawType === undefined) {
    // Claude Desktop / some clients infer stdio from presence of a command.
    findings.transport = cfg.command ? 'stdio' : 'unknown';
    if (findings.transport === 'unknown') {
      findings.issues.push({ severity: 'error', code: 'missing-type',
        message: 'no "type" field and no "command" to infer stdio transport' });
    } else {
      findings.issues.push({ severity: 'info', code: 'inferred-stdio',
        message: 'no "type" field — assuming stdio because "command" is present' });
    }
  } else {
    findings.transport = String(rawType);
    if (!VALID_TYPES.has(findings.transport)) {
      findings.issues.push({ severity: 'error', code: 'invalid-type',
        message: `unknown transport type "${findings.transport}" (valid: stdio, http, streamable-http, sse, ws)` });
    } else if (DEPRECATED_TYPES.has(findings.transport)) {
      findings.issues.push({ severity: 'warning', code: 'deprecated-transport',
        message: 'the SSE transport is deprecated by the MCP 2025-06 specification — migrate to the HTTP transport' });
    }
  }

  // Required fields per transport.
  if (findings.transport !== 'unknown') {
    const required = REQUIRED_BY_TRANSPORT[findings.transport];
    if (required) {
      for (const field of required) {
        const v = cfg[field];
        if (v === undefined || v === null || v === '') {
          findings.issues.push({ severity: 'error', code: 'missing-field',
            message: `${findings.transport} transport requires a non-empty "${field}" field` });
        } else {
          if (field === 'command') findings.command = String(v);
          if (field === 'url') findings.url = String(v);
        }
      }
    }
  }

  // Untyped entry that has neither command nor url is ambiguous-but-uploadable;
  // only report if type unknown and nothing to hang the transport on.
  if (findings.transport === 'unknown') {
    findings.issues.push({ severity: 'error', code: 'no-command-or-url',
      message: 'could not determine transport — provide "command" (stdio) or "url" (http/sse/ws)' });
  }

  // Collect npm package names from stdio npx/uvx invocations (for future registry check).
  const command = cfg.command;
  if (command && String(command).trim().toLowerCase().includes('npx')) {
    const args = Array.isArray(cfg.args) ? cfg.args : [];
    for (const arg of args) {
      const s = String(arg);
      // -y is a flag, @latest/@version are suffixes; real packages start with @scope/pkg or pkg.
      if (s.startsWith('@') || /^[a-z0-9]/.test(s)) {
        findingPackageName(findings, s);
      }
    }
  }

  // Secret hygiene: hardcoded credentials in env/headers (never store live creds in the file).
  const secretSpots = [];
  if (cfg.env && typeof cfg.env === 'object') {
    for (const [k, v] of Object.entries(cfg.env)) {
      if (typeof v === 'string') {
        if (looksLikeSecret(v) && !referencesEnv(v)) secretSpots.push(`env.${k}`);
        else if (!referencesEnv(v) && /KEY|TOKEN|SECRET|PASS|API/i.test(k)) secretSpots.push(`env.${k} (literal, not ${'${VAR}'})`);
      }
    }
  }
  if (cfg.headers && typeof cfg.headers === 'object') {
    for (const [k, v] of Object.entries(cfg.headers)) {
      if (typeof v === 'string' && /auth|token|key|bearer/i.test(k) && looksLikeSecret(v) && !referencesEnv(v)) {
        secretSpots.push(`headers.${k}`);
      }
    }
  }
  for (const spot of secretSpots) {
    findings.issues.push({ severity: 'warning', code: 'hardcoded-secret',
      message: `possible hardcoded credential in "${spot}" — use ${'${YOUR_ENV_VAR}'} expansion instead` });
  }

  // Unresolved env-var references (no default) → the config will fail to parse at load.
  const refs = collectVarRefs(cfg);
  for (const ref of refs) {
    if (ref.hasDefault) continue;
    // We can't know if it's set at runtime; but flag "no default" as a parse-risk if the
    // variable is absent from the process env.
    if (typeof process.env[ref.name] !== 'string' || process.env[ref.name] === '') {
      findings.issues.push({ severity: 'info', code: 'unset-env-var',
        message: `"${ref.name}" env var is referenced without a default and is not currently set — config may fail to load` });
    }
  }

  return findings;

  function findingPackageName(f, s) {
    // Strip version suffix @latest/@1.2.3 but keep scoped packages (@scope/name).
    const m = s.match(/^(?:(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*)/i);
    if (!m) return;
    // m[0] is the full package token — scoped (@scope/name) or plain (name).
    const name = m[0];
    // Avoid flags and bare --style args.
    if (name.startsWith('-') || name === 'y' || name === 'latest') return;
    if (!f.packageNames.includes(name)) f.packageNames.push(name);
  }
}

// Collect every ${VAR} / ${VAR:-default} reference in the entry (keys excluded).
function collectVarRefs(cfg) {
  const out = [];
  const seen = new Set();
  const walk = (val) => {
    if (typeof val === 'string') {
      const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g;
      let m;
      while ((m = re.exec(val)) !== null) {
        const key = m[1];
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ name: key, hasDefault: Boolean(m[2]) });
        }
      }
    } else if (Array.isArray(val)) {
      val.forEach(walk);
    } else if (val && typeof val === 'object') {
      Object.values(val).forEach(walk);
    }
  };
  walk(cfg);
  return out;
}

async function scan(dir) {
  const root = path.resolve(dir || '.');
  const configs = await findConfigs(root);
  const results = [];
  const preFlightErrors = [];

  for (const file of configs) {
    const parsed = await parseFile(file);
    if (parsed.error) {
      preFlightErrors.push({ file: file.path, error: parsed.error });
      results.push({ file: file.path, source: file.source, servers: [], fileError: parsed.error });
      continue;
    }
    const servers = Object.entries(parsed.data.mcpServers || {}).map(([name, cfg]) => checkServer(name, cfg, file));
    results.push({ file: file.path, source: file.source, servers });
  }

  // Aggregate stats.
  const allIssues = results.flatMap((r) => r.servers.flatMap((s) => s.issues));
  const summary = {
    configsFound: results.length,
    servers: results.reduce((n, r) => n + r.servers.length, 0),
    errors: allIssues.filter((i) => i.severity === 'error').length,
    warnings: allIssues.filter((i) => i.severity === 'warning').length,
    infos: allIssues.filter((i) => i.severity === 'info').length,
    fileErrors: preFlightErrors.length,
  };

  return { projectRoot: root, configs: results, summary };
}

module.exports = { scan, checkServer, findConfigs, VALID_TYPES, DEPRECATED_TYPES, RESERVED_NAMES, looksLikeSecret, referencesEnv };