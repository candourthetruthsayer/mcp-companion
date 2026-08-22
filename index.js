#!/usr/bin/env node
'use strict';

const { scan } = require('./lib/scan');

const USAGE = `Usage: mcp-companion [directory] [options]

Scan and validate the MCP server configuration for your project.

Scans for .mcp.json, mcp.json, .cursor/mcp.json, and claude_desktop-style
config entries in the given directory, then checks each server entry for:

  - Missing required fields (command for stdio, url for http/sse/ws)
  - Invalid or unknown transport types
  - Deprecated transports (SSE)
  - Reserved server names
  - Hardcoded credentials that should use \${ENV_VAR} expansion
  - Env-var references with no default that may fail to load

Options:
  --json        Output results as JSON
  --summary     One-line summary (ideal for CI)
  --no-color    Disable colored output
  --help        Show this help
  --version     Show version

Exit codes:
  0  Clean — no errors or warnings
  1  Issues found (errors or warnings)
  2  Error (no config, invalid directory, bad arguments)

Examples:
  mcp-companion                 Check the current directory
  mcp-companion ./my-app
  mcp-companion --summary       CI-friendly one-liner
  mcp-companion --json          Machine-readable
`;

function colorize(str, color) {
  if (process.env.NO_COLOR || process.argv.includes('--no-color')) return str;
  const codes = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' };
  return `${codes[color]}${str}${codes.reset}`;
}

function sev(severity) {
  if (severity === 'error') return colorize('✗ error', 'red');
  if (severity === 'warning') return colorize('⚑ warning', 'yellow');
  return colorize('• info', 'dim');
}

function format(result) {
  const { summary, configs } = result;
  const lines = [];
  lines.push(colorize(`mcp-companion — ${result.projectRoot}`, 'bold'));
  lines.push('─'.repeat(50));

  if (summary.configsFound === 0) {
    lines.push(colorize('⚠ no MCP config file found (.mcp.json, mcp.json, .cursor/mcp.json)', 'yellow'));
    lines.push('  Add one, or pass a project root that contains it.');
  }

  for (const cfg of configs) {
    lines.push(colorize(`${cfg.file}${cfg.source === 'managed' ? ' (managed)' : ''}`, 'bold'));
    if (cfg.fileError) {
      lines.push(`  ${sev('error')} ${cfg.fileError}`);
      continue;
    }
    if (cfg.servers.length === 0) {
      lines.push(`  ${colorize('(no servers defined)', 'dim')}`);
    }
    for (const s of cfg.servers) {
      lines.push(`  ${colorize(s.name, 'bold')} [${s.transport}]`);
      if (s.issues.length === 0) {
        lines.push(`    ${colorize('✓ valid', 'green')}`);
        continue;
      }
      for (const issue of s.issues) {
        lines.push(`    ${sev(issue.severity)} [${issue.code}] ${issue.message}`);
      }
    }
  }

  lines.push('─'.repeat(50));
  const found = `Found: ${summary.errors} error(s), ${summary.warnings} warning(s), ${summary.infos} info`;
  lines.push(found);
  return lines.join('\n');
}

function formatSummary(result) {
  const s = result.summary;
  return `mcp-companion: ${s.configsFound} config(s), ${s.servers} server(s), ${s.errors} error(s), ${s.warnings} warning(s)`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(require('./package.json').version);
    return;
  }

  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--'));
  const dir = positional[0] || '.';
  const json = flags.has('--json');
  const summary = flags.has('--summary');

  try {
    const result = await scan(dir);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (summary) {
      console.log(formatSummary(result));
    } else {
      console.log(format(result));
    }
    process.exitCode = result.summary.errors || result.summary.warnings ? 1 : 0;
  } catch (err) {
    console.error(`mcp-companion: ${err.message}`);
    process.exitCode = 2;
  }
}

module.exports = { format, formatSummary, colorize };

if (require.main === module) {
  main();
}