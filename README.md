# mcp-companion

![CI](https://github.com/candourthetruthsayer/mcp-companion/actions/workflows/ci.yml/badge.svg)
![npm version](https://img.shields.io/npm/v/mcp-companion)
![npm downloads](https://img.shields.io/npm/dm/mcp-companion)

**Scan and validate your MCP server configuration before it silently fails.**

`mcp-companion` finds your MCP config files (`.mcp.json`, `mcp.json`, `.cursor/mcp.json`, `managed-mcp.json`), validates every server entry against the real MCP schema rules, and tells you what's broken, insecure, or deprecated — in one command. Zero dependencies, CI-friendly.

```
npx mcp-companion
```

## Why

MCP is exploding — ~97M monthly SDK downloads, 10,000+ public servers, 41% of enterprises running it in some production stage — but the tooling around it barely exists. Configs are committed, shared, and **silently fail** at load: a missing `url`, a reserved server name, an unset env var with no default, or a credential hardcoded into a file that gets pushed to GitHub.

`mcp-companion` catches those before they cost you a debugging session (or a leaked key).

## What it checks

| Severity | What it catches |
|----------|-----------------|
| **error** | Unknown transport type (valid: `stdio`, `http`, `streamable-http`, `sse`, `ws`) |
| **error** | Stdio server missing `command`; http/sse/ws server missing `url` |
| **error** | Entry with no determinable transport; unparseable/invalid config file |
| **warning** | **Deprecated SSE transport** (MCP 2025-06 spec → migrate to HTTP) |
| **warning** | Reserved server name `workspace` (client skips it at startup) |
| **warning** | **Hardcoded credential** in `env`/`headers` — should be `${VAR}` expansion |
| **info** | `$\{VAR\}` reference with no default and no currently-set value |
| **info** | Missing `type` field (inferred as stdio from `command`) |

## Usage

```
mcp-companion                 Check the current directory
mcp-companion ./my-app        Check a specific project
mcp-companion --summary       CI-friendly one-liner
mcp-companion --json          Machine-readable output
```

**Exit codes:**
- `0` — clean (no errors or warnings)
- `1` — issues found (errors and/or warnings)
- `2` — error (no config, invalid arguments, IO failure)

### CI usage

Add it to a GitHub Actions workflow as a one-line check:

```yaml
- run: npx mcp-companion --summary
```

## Example output

```
mcp-companion — /repo
──────────────────────────────────────────────────
.mcp.json
  github [http]
    • info [unset-env-var] "GITHUB_PAT" env var referenced without a default
  filesystem [stdio]
    ✓ valid
  broken [http]
    ✗ error [missing-field] http transport requires a non-empty "url" field
  legacy [sse]
    ⚑ warning [deprecated-transport] SSE is deprecated — migrate to HTTP
  workspace [stdio]
    ⚑ warning [reserved-name] server name "workspace" is reserved
  leaky [stdio]
    ⚑ warning [hardcoded-secret] possible credential in "env.API_KEY"
──────────────────────────────────────────────────
Found: 1 error(s), 3 warning(s), 1 info
```

## Install

Local (recommended as a dev-dependency or just via npx):

```sh
npm i -D mcp-companion
# or, run without installing:
npx mcp-companion
```

Global:

```sh
npm i -g mcp-companion
```

## Design notes

- **Zero dependencies** — Node built-ins only. For a tool that validates other tools' configs, dependency-sphagetti is the opposite of reassuring.
- **Low false positives** — it only flags the classes the MCP docs themselves call out (broken required fields, deprecated transports, hardcoded secrets, reserved names). Healthy servers pass clean.
- **The seam for a future registry check** — the `packageNames` field (in `--json`) collects every npm package a stdio server invokes via `npx`, ready for a staleness/abandoned-server scan later.

## License

MIT © 2026 Faizan. Built with AI-assisted development — honestly disclosed.