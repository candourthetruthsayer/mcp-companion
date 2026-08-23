'use strict';

const node_test = require('node:test');
const assert = require('node:assert');
const { promises: fs } = require('fs');
const os = require('os');
const path = require('path');
const { scan, checkServer, looksLikeSecret, referencesEnv, compareVersions, isConcretePin, isHttpUrl, checkServerHealth, matchesAny, applyPolicy } = require('../lib/scan');
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

// --- online version / staleness check (--check-updates) ---

// Build a fake http module whose .get(url,opts,cb) immediately returns a
// fake response resolving to an object with the given version.
function fakeHttp(version) {
  return {
    get(url, opts, cb) {
      const res = {
        statusCode: 200,
        on(ev, fn) {
          if (ev === 'data') fn(JSON.stringify({ version }));
          if (ev === 'end') setImmediate(fn);
          return res;
        },
      };
      setImmediate(() => cb(res));
      const req = { on() {}, destroy() {} };
      return req;
    },
  };
}

node_test('compareVersions: numeric semver ordering', () => {
  assert.strictEqual(compareVersions('1.0.0', '1.0.0'), 0);
  assert.strictEqual(compareVersions('1.2.3', '1.2.4'), -1);
  assert.strictEqual(compareVersions('2.0.0', '1.9.9'), 1);
  assert.strictEqual(compareVersions('1.10.0', '1.9.9'), 1);
});

node_test('isConcretePin: accepts numeric pins, rejects ranges/latest', () => {
  assert.strictEqual(isConcretePin('1.2.3'), true);
  assert.strictEqual(isConcretePin('^1.2.0'), false);
  assert.strictEqual(isConcretePin('latest'), false);
  assert.strictEqual(isConcretePin('~1.2.0'), false);
});

node_test('checkServer: captures packageRefs with version specs', () => {
  const r = checkServer('mem', { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory@1.0.0'] }, {});
  assert.ok(Array.isArray(r.packageRefs));
  const ref = r.packageRefs.find((x) => x.name === '@modelcontextprotocol/server-memory');
  assert.ok(ref, 'expected packageRef for the pinned package');
  assert.strictEqual(ref.spec, '1.0.0');
});

node_test('checkServer: bare npx package default spec is "latest"', () => {
  const r = checkServer('git', { type: 'stdio', command: 'npx', args: ['-y', '@some/mcp-github'] }, {});
  const ref = r.packageRefs.find((x) => x.name === '@some/mcp-github');
  assert.strictEqual(ref.spec, 'latest');
});

node_test('scan checkUpdates=false: no network calls, zero updatesChecked', async () => {
  const dir = await tmpdirWith({
    '.mcp.json': JSON.stringify({ mcpServers: { a: { type: 'stdio', command: 'npx', args: ['-y', 'pkg@1.0.0'] } } }),
  });
  const r = await scan(dir); // no checkUpdates, no httpFn
  assert.strictEqual(r.summary.updatesChecked, 0);
  assert.strictEqual(r.summary.updatesStale, 0);
});

node_test('scan checkUpdates=true: stale pin flagged, current pin not', async () => {
  const dir = await tmpdirWith({
    '.mcp.json': JSON.stringify({
      mcpServers: {
        oldserver: { type: 'stdio', command: 'npx', args: ['-y', 'legacy-pkg@1.0.0'] },
        current: { type: 'stdio', command: 'npx', args: ['-y', 'new-pkg@2.0.0'] },
      },
    }),
  });
  // Registry reports legacy-pkg latest=1.2.0 (stale), new-pkg latest=2.0.0 (current).
  const latestByPkg = { 'legacy-pkg': '1.2.0', 'new-pkg': '2.0.0' };
  const httpFn = { get: (url, opts, cb) => {
    const pkg = decodeURIComponent(url.split('/')[3] || '');
    return fakeHttp(latestByPkg[pkg] || '0.0.0').get(url, opts, cb);
  } };
  const r = await scan(dir, { checkUpdates: true, httpFn, timeoutMs: 1000 });
  assert.strictEqual(r.summary.updatesChecked, 2);
  assert.strictEqual(r.summary.updatesStale, 1);
  const servers = r.configs[0].servers;
  const old = servers.find((s) => s.name === 'oldserver');
  assert.ok(old.issues.some((i) => i.code === 'stale-package'), 'legacy-pkg should be stale');
  const cur = servers.find((s) => s.name === 'current');
  assert.ok(!cur.issues.some((i) => i.code === 'stale-package'), 'new-pkg should not be stale');
});

node_test('scan checkUpdates=true: unresolved package is info, not warning', async () => {
  const dir = await tmpdirWith({
    '.mcp.json': JSON.stringify({ mcpServers: { ghost: { type: 'stdio', command: 'npx', args: ['-y', 'ghost-pkg@1.0.0'] } } }),
  });
  // 404 → the mock returns statusCode 404 so version resolves to null.
  const httpFn = { get: (url, opts, cb) => {
    const res = {
      statusCode: 404,
      on(ev, fn) { if (ev === 'end') setImmediate(fn); return res; },
    };
    setImmediate(() => cb(res));
    return { on() {}, destroy() {} };
  } };
  const r = await scan(dir, { checkUpdates: true, httpFn, timeoutMs: 1000 });
  assert.strictEqual(r.summary.updatesUnresolved, 1);
  const ghost = r.configs[0].servers[0];
  assert.ok(ghost.issues.some((i) => i.code === 'version-unknown'));
  assert.ok(!ghost.issues.some((i) => i.code === 'stale-package'));
});

// --- remote URL health check (--check-health) ---

// httpFn whose .get(url,opts,cb) responds with the given status (or an error).
function statusHttpFn(statusByUrl) {
  return {
    get(url, opts, cb) {
      const status = statusByUrl[url] !== undefined ? statusByUrl[url] : 200;
      const res = {
        statusCode: status,
        on() { return res; },
      };
      setImmediate(() => cb(res));
      return { on() {}, destroy() {} };
    },
  };
}

node_test('isHttpUrl: http/https accepted, ws/template rejected', () => {
  assert.strictEqual(isHttpUrl('https://mcp.example.com/mcp'), true);
  assert.strictEqual(isHttpUrl('http://localhost:3000'), true);
  assert.strictEqual(isHttpUrl('wss://mcp.example.com/socket'), false);
  assert.strictEqual(isHttpUrl('${API_BASE_URL}/mcp'), false);
  assert.strictEqual(isHttpUrl(123), false);
});

node_test('checkServerHealth: reachable http URL returns true', async () => {
  const ok = await checkServerHealth('https://ok.example.com', { httpFn: statusHttpFn({ 'https://ok.example.com': 200 }) });
  assert.strictEqual(ok, true);
});

node_test('scan checkHealth=false: no network, zero healthChecked', async () => {
  const dir = await tmpdirWith({
    '.mcp.json': JSON.stringify({ mcpServers: { a: { type: 'http', url: 'https://a.example.com' } } }),
  });
  const r = await scan(dir); // no checkHealth, no httpFn
  assert.strictEqual(r.summary.healthChecked, 0);
  assert.strictEqual(r.summary.healthFailed, 0);
});

node_test('scan checkHealth=true: reachable URL clean, failing URL warned', async () => {
  const dir = await tmpdirWith({
    '.mcp.json': JSON.stringify({
      mcpServers: {
        good: { type: 'http', url: 'https://good.example.com' },
        bad: { type: 'http', url: 'https://down.example.com' },
        ws: { type: 'ws', url: 'wss://live.example.com/socket' },
      },
    }),
  });
  const httpFn = { get: (url, opts, cb) => {
    const status = url.includes('down.example.com') ? 503 : 200;
    const res = { statusCode: status, on() { return res; } };
    setImmediate(() => cb(res));
    return { on() {}, destroy() {} };
  } };
  const r = await scan(dir, { checkHealth: true, httpFn, timeoutMs: 1000 });
  assert.strictEqual(r.summary.healthChecked, 2); // good + bad (ws skipped)
  assert.strictEqual(r.summary.healthSkipped, 1); // ws:// not http(s)
  assert.strictEqual(r.summary.healthFailed, 1);
  const servers = r.configs[0].servers;
  assert.ok(servers.find((s) => s.name === 'good').issues.every((i) => i.code !== 'url-unreachable'));
  assert.ok(servers.find((s) => s.name === 'bad').issues.some((i) => i.code === 'url-unreachable'));
  assert.ok(!servers.find((s) => s.name === 'ws').issues.some((i) => i.code === 'url-unreachable'));
});

// --- org-policy deny mode (--policy) ---

node_test('matchesAny: * glob matches, no match returns false', () => {
  assert.strictEqual(matchesAny('untrusted-prod', ['untrusted-*']), true);
  assert.strictEqual(matchesAny('safe', ['untrusted-*']), false);
  assert.strictEqual(matchesAny('https://evil.example.com/x', ['https://evil.example.com/*']), true);
  assert.strictEqual(matchesAny('x', undefined), false);
});

node_test('applyPolicy: deny by server name (exact + glob)', () => {
  const denied = checkServer('untrusted-01', { type: 'stdio', command: 'npx' }, {});
  assert.strictEqual(applyPolicy(denied, { deny: { names: ['untrusted-*'] } }), true);
  assert.ok(denied.issues.some((i) => i.code === 'denied-by-policy' && i.severity === 'error'));
  const allowed = checkServer('my-server', { type: 'stdio', command: 'npx' }, {});
  assert.strictEqual(applyPolicy(allowed, { deny: { names: ['untrusted-*'] } }), false);
});

node_test('applyPolicy: deny by server URL pattern', () => {
  const s = checkServer('evil', { type: 'http', url: 'https://evil.example.com/mcp' }, {});
  assert.strictEqual(applyPolicy(s, { deny: { urls: ['https://evil.example.com/*'] } }), true);
});

node_test('applyPolicy: deny by command array prefix', () => {
  const s = checkServer('suspicious', { type: 'stdio', command: 'npx', args: ['-y', 'suspicious-package'] }, {});
  assert.strictEqual(applyPolicy(s, { deny: { commands: [['npx', '-y', 'suspicious-package']] } }), true);
  const ok = checkServer('fine', { type: 'stdio', command: 'npx', args: ['-y', 'good-package'] }, {});
  assert.strictEqual(applyPolicy(ok, { deny: { commands: [['npx', '-y', 'suspicious-package']] } }), false);
});

node_test('scan --policy inline object: denied server flagged, clean server not', async () => {
  const dir = await tmpdirWith({
    '.mcp.json': JSON.stringify({
      mcpServers: {
        'untrusted-prod': { type: 'stdio', command: 'npx', args: ['-y', 'pkg'] },
        good: { type: 'http', url: 'https://good.example.com' },
      },
    }),
  });
  const policy = { deny: { names: ['untrusted-*'], urls: ['https://evil.example.com/*'] } };
  const r = await scan(dir, { policy });
  assert.strictEqual(r.summary.policyDenied, 1);
  assert.strictEqual(r.policy, true);
  const servers = r.configs[0].servers;
  assert.ok(servers.find((s) => s.name === 'untrusted-prod').issues.some((i) => i.code === 'denied-by-policy'));
  assert.ok(!servers.find((s) => s.name === 'good').issues.some((i) => i.code === 'denied-by-policy'));
});

node_test('scan --policy default: reads .mcp-policy.json from the target dir', async () => {
  const dir = await tmpdirWith({
    '.mcp.json': JSON.stringify({ mcpServers: { danger: { type: 'http', url: 'https://deny.example.com/mcp' } } }),
    '.mcp-policy.json': JSON.stringify({ deny: { urls: ['https://deny.example.com/*'] } }),
  });
  const r = await scan(dir, { policy: '.mcp-policy.json' });
  assert.strictEqual(r.summary.policyDenied, 1);
});

node_test('scan --policy missing file: throws a clear error', async () => {
  const dir = await tmpdirWith({ '.mcp.json': JSON.stringify({ mcpServers: {} }) });
  await assert.rejects(() => scan(dir, { policy: 'does-not-exist.json' }), /policy file not found/);
});

// regression: .claude/settings.local.json is a permissions file, not an mcpServers
// source — it must NOT be scanned (was causing a false "missing mcpServers" error).
node_test('scan: bare .claude/settings.local.json is ignored (not an MCP source)', async () => {
  const dir = await tmpdirWith({
    '.claude/settings.local.json': JSON.stringify({ permissions: { allow: ['Bash(*)'] } }),
  });
  const r = await scan(dir);
  assert.strictEqual(r.summary.configsFound, 0, 'no real MCP config should be found');
  assert.strictEqual(r.summary.fileErrors, 0, 'no false parse error from a permissions file');
  assert.strictEqual(r.summary.servers, 0);
});

node_test('scan: .mcp.json still found alongside a permissions file', async () => {
  const dir = await tmpdirWith({
    '.claude/settings.local.json': JSON.stringify({ permissions: { allow: ['Bash(*)'] } }),
    '.mcp.json': JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' } } }),
  });
  const r = await scan(dir);
  assert.strictEqual(r.summary.configsFound, 1);
  assert.strictEqual(r.summary.servers, 1);
  assert.strictEqual(r.summary.errors, 0);
});