'use strict';

const node_test = require('node:test');
const assert = require('node:assert');
const { promises: fs } = require('fs');
const os = require('os');
const path = require('path');
const { scan, checkServer, looksLikeSecret, referencesEnv } = require('../lib/scan');
const { format, formatSummary } = require('../index.js');

async function tmpdirWith(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-companion-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  return dir;
}

// --- checkServer unit tests ---

node_test('checkServer: valid stdio server is clean', () => {
  const r = checkServer('filesystem', {
    type: 'stdio', command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
  }, {});
  assert.strictEqual(r.transport, 'stdio');
  assert.strictEqual(r.issues.filter((i) => i.severity === 'error').length, 0);
  assert.strictEqual(r.issues.filter((i) => i.severity === 'warning').length, 0);
  assert.ok(r.packageNames.includes('@modelcontextprotocol/server-filesystem'));
});

node_test('checkServer: valid http server is clean', () => {
  const r = checkServer('github', { type: 'http', url: 'https://api.githubcopilot.com/mcp/' }, {});
  assert.strictEqual(r.transport, 'http');
  assert.strictEqual(r.issues.filter((i) => i.severity === 'error').length, 0);
});

node_test('checkServer: unknown transport type is an error', () => {
  const r = checkServer('weird', { type: 'ftp', url: 'ftp://x' }, {});
  const err = r.issues.find((i) => i.code === 'invalid-type');
  assert.ok(err, 'expected invalid-type issue');
  assert.strictEqual(err.severity, 'error');
});

node_test('checkServer: deprecated SSE transport flagged', () => {
  const r = checkServer('legacy', { type: 'sse', url: 'https://x/sse' }, {});
  const dep = r.issues.find((i) => i.code === 'deprecated-transport');
  assert.ok(dep, 'expected deprecated-transport issue');
  assert.strictEqual(dep.severity, 'warning');
});

node_test('checkServer: http server missing url is an error', () => {
  const r = checkServer('broken', { type: 'http' }, {});
  const miss = r.issues.find((i) => i.code === 'missing-field');
  assert.ok(miss, 'expected missing-field issue');
  assert.strictEqual(miss.severity, 'error');
  assert.ok(miss.message.includes('url'));
});

node_test('checkServer: stdio server missing command is an error', () => {
  const r = checkServer('broken', { type: 'stdio', args: ['x'] }, {});
  const miss = r.issues.find((i) => i.code === 'missing-field');
  assert.ok(miss);
  assert.ok(miss.message.includes('command'));
});

node_test('checkServer: reserved name "workspace" flagged', () => {
  const r = checkServer('workspace', { type: 'stdio', command: 'npx' }, {});
  const res = r.issues.find((i) => i.code === 'reserved-name');
  assert.ok(res, 'expected reserved-name issue');
});

node_test('checkServer: hardcoded secret in env flagged', () => {
  const r = checkServer('db', {
    type: 'stdio', command: 'npx', args: ['-y', 'pkg'],
    env: { DATABASE_URL: 'postgres://u:p@host', API_KEY: 'sk-live-abc123xyz' },
  }, {});
  const sec = r.issues.filter((i) => i.code === 'hardcoded-secret');
  assert.ok(sec.length >= 1, 'expected hardcoded-secret issues');
});

node_test('checkServer: env-var reference not flagged as secret', () => {
  const r = checkServer('db', {
    type: 'stdio', command: 'npx', args: ['-y', 'pkg'],
    env: { DATABASE_URL: '${DATABASE_URL}', API_KEY: '${STRIPE_API_KEY}' },
  }, {});
  const sec = r.issues.filter((i) => i.code === 'hardcoded-secret');
  assert.strictEqual(sec.length, 0, 'env-var references must not be flagged');
});

node_test('checkServer: no type but command present infers stdio', () => {
  const r = checkServer('desktop-style', { command: 'npx', args: ['-y', 'x'] }, {});
  assert.strictEqual(r.transport, 'stdio');
  const info = r.issues.find((i) => i.code === 'inferred-stdio');
  assert.ok(info);
});

node_test('looksLikeSecret / referencesEnv helpers', () => {
  assert.strictEqual(looksLikeSecret('sk-live-x'), true);
  assert.strictEqual(looksLikeSecret('${VAR}'), false);
  assert.strictEqual(referencesEnv('${FTP}'), true);
  assert.strictEqual(referencesEnv('${CLAUDE_PROJECT_DIR:-/tmp}'), true);
  assert.strictEqual(referencesEnv('/tmp/plain'), false);
});

// --- end-to-end scan tests over real temp dirs ---

node_test('scan: no config file → clean-flag, zero servers', async () => {
  const dir = await tmpdirWith({ 'package.json': '{}' });
  const r = await scan(dir);
  assert.strictEqual(r.summary.configsFound, 0);
  assert.strictEqual(r.summary.servers, 0);
  assert.strictEqual(r.summary.errors, 0);
});

node_test('scan: valid .mcp.json → zero errors', async () => {
  const dir = await tmpdirWith({
    '.mcp.json': JSON.stringify({
      mcpServers: {
        github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' },
        filesystem: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
      },
    }, null, 2),
  });
  const r = await scan(dir);
  assert.strictEqual(r.summary.servers, 2);
  assert.strictEqual(r.summary.errors, 0);
  assert.strictEqual(r.summary.warnings, 0);
});

node_test('scan: broken config surfaces errors per server', async () => {
  const dir = await tmpdirWith({
    '.mcp.json': JSON.stringify({
      mcpServers: {
        badhttp: { type: 'http' },
        legacy: { type: 'sse', url: 'https://x/sse' },
        workspace: { type: 'stdio', command: 'npx' },
      },
    }, null, 2),
  });
  const r = await scan(dir);
  const codes = r.configs[0].servers.flatMap((s) => s.issues.map((i) => i.code));
  assert.ok(codes.includes('missing-field'), 'badhttp missing url');
  assert.ok(codes.includes('deprecated-transport'), 'sse deprecated');
  assert.ok(codes.includes('reserved-name'), 'reserved name');
  assert.ok(r.summary.errors >= 1);
  assert.ok(r.summary.warnings >= 2);
});

node_test('scan: invalid JSON in config is a file error', async () => {
  const dir = await tmpdirWith({ '.mcp.json': '{ not valid json' });
  const r = await scan(dir);
  assert.strictEqual(r.summary.fileErrors, 1);
  assert.ok(r.configs[0].fileError);
});

node_test('scan: npx package names collected for registry check', async () => {
  const dir = await tmpdirWith({
    '.mcp.json': JSON.stringify({
      mcpServers: {
        memory: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
        slot: { type: 'stdio', command: 'npx', args: ['-y', '@bytebase/dbhub'] },
      },
    }),
  });
  const r = await scan(dir);
  const names = r.configs[0].servers.flatMap((s) => s.packageNames);
  assert.ok(names.includes('@modelcontextprotocol/server-memory'));
  assert.ok(names.includes('@bytebase/dbhub'));
});

node_test('index: format and formatSummary produce output', () => {
  const result = {
    projectRoot: '/x',
    configs: [{ file: '/x/.mcp.json', source: 'project', servers: [{ name: 'a', transport: 'http', issues: [] }] }],
    summary: { configsFound: 1, servers: 1, errors: 0, warnings: 0, infos: 0, fileErrors: 0 },
  };
  assert.ok(format(result).includes('mcp-companion'));
  assert.ok(formatSummary(result).includes('1 server(s)'));
});