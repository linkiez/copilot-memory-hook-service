# Copilot Memory Hook Service

Standalone extraction of the memory hook workflow and HTTP CLI used to persist, recall, and summarize GitHub Copilot session context.

## What is included

- `scripts/memory-cycle.js`: hook entrypoint
- `scripts/memory-cycle-core.js`: hook event dispatcher and session lifecycle
- `scripts/memory-cycle-domain.js`: summary, categorization, and tool extraction logic
- `scripts/memory-cycle-http.js`: active-session persistence, remote retrieval, and cache handling
- `scripts/mcp-memory-http-cli.js`: CLI for the remote memory service
- `scripts/mcp-memory-http-client.js`: HTTP client wrapper
- `scripts/mcp-memory-http-commands.js`: command registry and argument normalization
- `scripts/mcp-memory-copilot-processor.js`: optional Copilot preprocessing for memory payloads
- `tests/*.test.js`: regression coverage for the CLI and hook flow
- `examples/memory-session-context.example.json`: example hook wiring

## Requirements

- Node.js 20+
- A reachable memory service endpoint exposed through `MCP_MEMORY_HTTP_ENDPOINT`
- Optional `MCP_MEMORY_API_KEY`
- Optional fallback env file at `~/.env` or a custom path via `MCP_MEMORY_HTTP_ENV_FILE`

## Quick start

```bash
npm test
```

```bash
node scripts/mcp-memory-http-cli.js health
```

```bash
node scripts/memory-cycle.js
```

## Hook configuration

Use the sample file in `examples/` and update the command path to point at this repository checkout.

## Notes

- The hook stores active-session snapshots locally under `session-state/memory-hook`.
- Local session cache expiration is controlled by `MEMORY_HOOK_SESSION_CACHE_MAX_AGE_MS`.
- Final session summaries persist `state_source` and `state_fallbacks` so you can inspect whether recovery came from local cache, remote metadata, or content fallback.