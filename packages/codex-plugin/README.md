# Agent Native Trade for Codex

This directory is the installable Codex plugin. It contains:

- `.codex-plugin/plugin.json` — plugin manifest;
- `.mcp.json` — local stdio MCP launcher;
- `skills/agent-native-trade/` — compact model workflow;
- `runtime/` — prebuilt, dependency-free runtime with 23 tools;
- `policy.json` and protocol schemas — runtime validation and signing policy.

Users install it through the repository marketplace documented in the root [`README.md`](../../README.md). They do not need this repository's source dependencies or an install-time build.

## Build and test

From the repository root:

```bash
npm ci --ignore-scripts --prefix integrations/codex/plugin
npm test --prefix integrations/codex/plugin
```

The build script bundles the Codex MCP adapter and the shared Agent Native Trade implementation into the Brotli-packed `runtime/mcp-server.mjs.br`. The launcher expands it into a content-addressed temporary cache before starting MCP. Commit runtime changes together with their source changes.

The launcher intentionally does not use `${PLUGIN_ROOT}`. Current Codex releases do not reliably expand plugin-root variables in `.mcp.json`; the zero-install Node launcher locates the installed version under Codex's documented plugin cache and is exercised from an unrelated working directory in CI. Remove this compatibility path only after the upstream behavior is fixed and tested.
