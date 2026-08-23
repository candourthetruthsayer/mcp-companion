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
| **error** | **Denied by org policy** (`--policy`): server matches a deny rule (name/url/command) |
| **warning** | **Deprecated SSE transport** (MCP 2025-06 spec → migrate to HTTP) |
| **warning** | Reserved server name `workspace` (client skips it at startup) |
| **warning** | **Hardcoded credential** in `env`/`headers` — should be `${VAR}` expansion |
| **warning** | **Stale npm pin** (`--check-updates`): pinned npx version is behind the published latest |
| **warning** | **Unreachable server URL** (`--check-health`): http(s) server endpoint didn't respond (bad status / timeout) |
| **info** | `$\{VAR\}` reference with no default and no currently-set value |
| **info** | Missing `type` field (inferred as stdio from `command`) |

## Usage

```
mcp-companion                 Check the current directory
mcp-companion ./my-app        Check a specific project
mcp-companion --summary       CI-friendly one-liner
mcp-companion --check-updates Check pinned npx versions against npm (online)
mcp-companion --check-health  Probe http(s) server URLs for reachability (online)
mcp-companion --policy        Enforce deny rules from .mcp-policy.json in the target dir
mcp-companion --policy=file   Enforce deny rules from an explicit policy file
mcp-companion --json          Machine-readable output
```

Both online checks (`--check-updates`, `--check-health`) are **opt-in**: they make network calls, so by default — and in CI — the tool stays fast, deterministic, and offline. Use them when you want to catch stale npx pins or dead remote server endpoints.

### Org-policy deny mode

`--policy` enforces a deny list so an org can block known-bad servers. It's read from `.mcp-policy.json` in the scanned directory by default, or from an explicit file with `--policy=file.json`:

```json
{
  "deny": {
    "names": ["untrusted-*"],
    "urls": ["https://evil.example.com/*"],
    "commands": [["npx", "-y", "suspicious-package"]]
  }
}
```

Any server matching a name glob, URL glob, or command-array prefix is flagged as an **error** (`denied-by-policy`) — blocking CI. Deny-list rules run locally and need no network.

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
- **Collects npm refs for online checks** — the `packageRefs` (name + version spec) and `packageNames` fields (in `--json`) capture every package a stdio server invokes via `npx`; `--check-updates` uses them to flag stale pins against the public registry.

## License

MIT © 2026 Faizan. Built with AI-assisted development — honestly disclosed.