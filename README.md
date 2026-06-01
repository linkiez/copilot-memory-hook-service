# Copilot Memory Hook Service

Standalone extraction of the memory hook workflow and HTTP CLI used to persist, recall, and summarize GitHub Copilot session context.

The repository source of truth lives in `src/`. Running the build compiles those TypeScript sources into `scripts/` and syncs the generated hook runtime to `/home/linkiez/.copilot/hooks/scripts` by default.

## What is included

- `src/*.ts`: TypeScript source files for the hook runtime and memory HTTP CLI
- `scripts/*.js`: generated JavaScript artifacts produced by the build
- `tests/*.test.js`: regression coverage for the CLI and hook flow
- `examples/memory-session-context.example.json`: example hook wiring

## Requirements

- Node.js 20+
- A reachable memory service endpoint exposed through `MCP_MEMORY_HTTP_ENDPOINT`
- Optional `MCP_MEMORY_API_KEY`
- Optional fallback env file at `~/.env` or a custom path via `MCP_MEMORY_HTTP_ENV_FILE`

## Quick start

```bash
npm run build
```

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

Use the sample file in `examples/` and point the command path at the generated `scripts/memory-cycle.js` inside this repository, or at the synced runtime under `/home/linkiez/.copilot/hooks/scripts/memory-cycle.js`.

## Notes

- The hook stores active-session snapshots locally under `session-state/memory-hook`.
- `npm run build` syncs the generated runtime to `/home/linkiez/.copilot/hooks/scripts` by default. Override the target root with `MEMORY_HOOK_BUILD_ROOT` if you need another mount point.
- Local session cache expiration is controlled by `MEMORY_HOOK_SESSION_CACHE_MAX_AGE_MS`.
- Final session summaries persist `state_source` and `state_fallbacks` so you can inspect whether recovery came from local cache, remote metadata, or content fallback.