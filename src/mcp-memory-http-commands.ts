import {
  buildListQuery,
  buildSemanticSearchBody,
  buildSessionBody,
  buildStoreBody,
  buildTagSearchBody,
  buildTimeSearchBody,
  buildUpdateBody,
  buildUploadParts,
  firstOf,
  mapSearchResults,
  maybePreprocessArgs,
  normalizeHealthResponse,
  omitUndefined,
  parseJsonRpcId,
  parseTags,
  parseOptionalBoolean,
  parseOptionalFloat,
  parseOptionalInt,
  parseOptionalJson,
  requireBoolean,
  requireInt,
  requireString,
  requireTags
} from './mcp-memory-http-command-utils.js';

import type { MemoryHttpClient } from './mcp-memory-http-client.js';
import type { MemorySearchResponse, RawCliArguments } from './types.js';

type CommandHandler = (client: MemoryHttpClient, args: RawCliArguments) => Promise<unknown>;

type CommandScope = 'api' | 'root';

const COMMANDS: Record<string, CommandHandler> = {
  health: async (client) => normalizeHealthResponse(await client.requestJson({ method: 'GET', scope: 'api', path: 'health' })),
  'health-detailed': jsonCommand('GET', 'api', 'health/detailed'),
  'health-sync-status': jsonCommand('GET', 'api', 'health/sync-status'),
  'memory-stats': jsonCommand('GET', 'api', 'memory-stats'),
  'clear-caches': jsonCommand('POST', 'api', 'clear-caches'),
  store: (client, args) => client.requestJson({ method: 'POST', scope: 'api', path: 'memories', jsonBody: buildStoreBody(args) }),
  list: (client, args) => client.requestJson({ method: 'GET', scope: 'api', path: 'memories', query: buildListQuery(args) }),
  get: (client, args) => client.requestJson({ method: 'GET', scope: 'api', path: `memories/${encodeURIComponent(requireString(firstOf(args.hash, args.contentHash), '--hash'))}` }),
  update: (client, args) => client.requestJson({ method: 'PUT', scope: 'api', path: `memories/${encodeURIComponent(requireString(firstOf(args.hash, args.contentHash), '--hash'))}`, jsonBody: buildUpdateBody(args) }),
  delete: (client, args) => client.requestJson({ method: 'DELETE', scope: 'api', path: `memories/${encodeURIComponent(requireString(firstOf(args.hash, args.contentHash), '--hash'))}` }),
  tags: jsonCommand('GET', 'api', 'tags'),
  'session-store': (client, args) => client.requestJson({ method: 'POST', scope: 'api', path: 'sessions', jsonBody: buildSessionBody(args) }),
  types: jsonCommand('GET', 'api', 'types'),
  retrieve: (client, args) => runCommand(client, 'search', args),
  search: (client, args) => client.requestJson({ method: 'POST', scope: 'api', path: 'search', jsonBody: buildSemanticSearchBody(args) }),
  'search-by-tag': (client, args) => client.requestJson({ method: 'POST', scope: 'api', path: 'search/by-tag', jsonBody: buildTagSearchBody(args) }),
  'search-by-time': (client, args) => client.requestJson({ method: 'POST', scope: 'api', path: 'search/by-time', jsonBody: buildTimeSearchBody(args) }),
  'search-similar': (client, args) => client.requestJson({ method: 'GET', scope: 'api', path: `search/similar/${encodeURIComponent(requireString(firstOf(args.hash, args.contentHash), '--hash'))}`, query: { n_results: parseOptionalInt(firstOf(args.limit, args.nResults), '--limit') } }),
  'manage-bulk-delete': (client, args) => client.requestJson({ method: 'POST', scope: 'api', path: 'manage/bulk-delete', jsonBody: omitUndefined({ tag: args.tag || null, before_date: args.beforeDate || null, memory_type: args.memoryType || null, confirm_count: parseOptionalInt(args.confirmCount, '--confirm-count') }) }),
  'manage-cleanup-duplicates': jsonCommand('POST', 'api', 'manage/cleanup-duplicates'),
  'manage-untagged-count': jsonCommand('GET', 'api', 'manage/untagged/count'),
  'manage-delete-untagged': (client, args) => client.requestJson({ method: 'POST', scope: 'api', path: 'manage/delete-untagged', query: { confirm_count: requireInt(args.confirmCount, '--confirm-count') } }),
  'manage-tag-stats': jsonCommand('GET', 'api', 'manage/tags/stats'),
  'manage-rename-tag': (client, args) => client.requestJson({ method: 'PUT', scope: 'api', path: `manage/tags/${encodeURIComponent(requireString(args.oldTag, '--old-tag'))}`, query: omitUndefined({ new_tag: requireString(args.newTag, '--new-tag'), confirm_count: parseOptionalInt(args.confirmCount, '--confirm-count') }) }),
  'manage-system': (client, args) => client.requestJson({ method: 'POST', scope: 'api', path: `manage/system/${encodeURIComponent(requireString(args.operation, '--operation'))}` }),
  'analytics-overview': jsonCommand('GET', 'api', 'analytics/overview'),
  'analytics-memory-growth': (client, args) => client.requestJson({ method: 'GET', scope: 'api', path: 'analytics/memory-growth', query: { period: args.period } }),
  'analytics-tag-usage': (client, args) => client.requestJson({ method: 'GET', scope: 'api', path: 'analytics/tag-usage', query: omitUndefined({ period: args.period, limit: parseOptionalInt(args.limit, '--limit') }) }),
  'analytics-memory-types': jsonCommand('GET', 'api', 'analytics/memory-types'),
  'analytics-relationship-types': jsonCommand('GET', 'api', 'analytics/relationship-types'),
  'analytics-graph': (client, args) => client.requestJson({ method: 'GET', scope: 'api', path: 'analytics/graph-visualization', query: omitUndefined({ limit: parseOptionalInt(args.limit, '--limit'), min_connections: parseOptionalInt(args.minConnections, '--min-connections') }) }),
  'analytics-search': jsonCommand('GET', 'api', 'analytics/search-analytics'),
  'analytics-performance': jsonCommand('GET', 'api', 'analytics/performance'),
  'analytics-heatmap': (client, args) => client.requestJson({ method: 'GET', scope: 'api', path: 'analytics/activity-heatmap', query: omitUndefined({ days: parseOptionalInt(args.days, '--days') }) }),
  'analytics-top-tags': (client, args) => client.requestJson({ method: 'GET', scope: 'api', path: 'analytics/top-tags', query: omitUndefined({ period: args.period, limit: parseOptionalInt(args.limit, '--limit') }) }),
  'analytics-activity-breakdown': (client, args) => client.requestJson({ method: 'GET', scope: 'api', path: 'analytics/activity-breakdown', query: { granularity: args.granularity } }),
  'analytics-storage-stats': jsonCommand('GET', 'api', 'analytics/storage-stats'),
  events: (client) => client.requestStream({ method: 'GET', scope: 'api', path: 'events' }),
  'events-stats': jsonCommand('GET', 'api', 'events/stats'),
  'sync-status': jsonCommand('GET', 'api', 'sync/status'),
  'sync-force': jsonCommand('POST', 'api', 'sync/force'),
  'sync-pause': jsonCommand('POST', 'api', 'sync/pause'),
  'sync-resume': jsonCommand('POST', 'api', 'sync/resume'),
  'backup-status': jsonCommand('GET', 'api', 'backup/status'),
  'backup-now': jsonCommand('POST', 'api', 'backup/now'),
  'backup-list': jsonCommand('GET', 'api', 'backup/list'),
  'quality-rate': (client, args) => client.requestJson({ method: 'POST', scope: 'api', path: `quality/memories/${encodeURIComponent(requireString(firstOf(args.hash, args.contentHash), '--hash'))}/rate`, jsonBody: { rating: requireInt(args.rating, '--rating'), feedback: args.feedback || '' } }),
  'quality-evaluate': (client, args) => client.requestJson({ method: 'POST', scope: 'api', path: `quality/memories/${encodeURIComponent(requireString(firstOf(args.hash, args.contentHash), '--hash'))}/evaluate`, jsonBody: omitUndefined({ query: args.query || null }) }),
  'quality-get': (client, args) => client.requestJson({ method: 'GET', scope: 'api', path: `quality/memories/${encodeURIComponent(requireString(firstOf(args.hash, args.contentHash), '--hash'))}` }),
  'quality-distribution': (client, args) => client.requestJson({ method: 'GET', scope: 'api', path: 'quality/distribution', query: omitUndefined({ min_quality: parseOptionalFloat(args.minQuality, '--min-quality'), max_quality: parseOptionalFloat(args.maxQuality, '--max-quality') }) }),
  'quality-trends': (client, args) => client.requestJson({ method: 'GET', scope: 'api', path: 'quality/trends', query: omitUndefined({ days: parseOptionalInt(args.days, '--days') }) }),
  'documents-upload': (client, args) => client.requestJson({ method: 'POST', scope: 'api', path: 'documents/upload', multipart: buildUploadParts(args, false) }),
  'documents-batch-upload': (client, args) => client.requestJson({ method: 'POST', scope: 'api', path: 'documents/batch-upload', multipart: buildUploadParts(args, true) }),
  'documents-status': (client, args) => client.requestJson({ method: 'GET', scope: 'api', path: `documents/status/${encodeURIComponent(requireString(args.uploadId, '--upload-id'))}` }),
  'documents-history': jsonCommand('GET', 'api', 'documents/history'),
  'documents-remove': (client, args) => client.requestJson({ method: 'DELETE', scope: 'api', path: `documents/remove/${encodeURIComponent(requireString(args.uploadId, '--upload-id'))}`, query: omitUndefined({ remove_from_memory: parseOptionalBoolean(args.removeFromMemory) }) }),
  'documents-remove-by-tags': (client, args) => client.requestJson({ method: 'DELETE', scope: 'api', path: 'documents/remove-by-tags', jsonBody: requireTags(args.tags, '--tags') }),
  'documents-search-content': (client, args) => client.requestJson({ method: 'GET', scope: 'api', path: `documents/search-content/${encodeURIComponent(requireString(args.uploadId, '--upload-id'))}`, query: omitUndefined({ limit: parseOptionalInt(args.limit, '--limit') }) }),
  'consolidation-trigger': (client, args) => client.requestJson({ method: 'POST', scope: 'api', path: 'consolidation/trigger', jsonBody: { time_horizon: args.timeHorizon || 'weekly' } }),
  'consolidation-status': jsonCommand('GET', 'api', 'consolidation/status'),
  'consolidation-recommendations': (client, args) => client.requestJson({ method: 'GET', scope: 'api', path: `consolidation/recommendations/${encodeURIComponent(requireString(args.timeHorizon, '--time-horizon'))}` }),
  'server-status': jsonCommand('GET', 'api', 'server/status'),
  'server-version-check': jsonCommand('GET', 'api', 'server/version/check'),
  'server-restart': (client, args) => client.requestJson({ method: 'POST', scope: 'api', path: 'server/restart', jsonBody: { confirm: requireBoolean(args.confirm, '--confirm') } }),
  'server-update': (client, args) => client.requestJson({ method: 'POST', scope: 'api', path: 'server/update', jsonBody: { confirm: requireBoolean(args.confirm, '--confirm'), force: parseOptionalBoolean(args.force) || false } }),
  'config-env': jsonCommand('GET', 'api', 'config/env'),
  'config-credentials-get': (client, args) => client.requestJson({ method: 'GET', scope: 'api', path: 'config/credentials', query: omitUndefined({ reveal: parseOptionalBoolean(args.reveal) }) }),
  'config-credentials-save': (client, args) => client.requestJson({ method: 'POST', scope: 'api', path: 'config/credentials', jsonBody: { api_token: requireString(args.apiToken, '--api-token'), account_id: requireString(args.accountId, '--account-id'), d1_database_id: requireString(args.d1DatabaseId, '--d1-database-id'), vectorize_index: requireString(args.vectorizeIndex, '--vectorize-index'), sync_owner: requireString(args.syncOwner, '--sync-owner'), tested_token: requireString(args.testedToken, '--tested-token') } }),
  'config-credentials-test': (client, args) => client.requestJson({ method: 'POST', scope: 'api', path: 'config/credentials/test', jsonBody: { api_token: requireString(args.apiToken, '--api-token'), account_id: requireString(args.accountId, '--account-id') } }),
  'oauth-status': jsonCommand('GET', 'api', 'oauth/status'),
  'conflicts-list': jsonCommand('GET', 'api', 'conflicts'),
  'conflicts-resolve': (client, args) => client.requestJson({ method: 'POST', scope: 'api', path: 'conflicts/resolve', jsonBody: { winner_hash: requireString(args.winnerHash, '--winner-hash'), loser_hash: requireString(args.loserHash, '--loser-hash') } }),
  harvest: (client, args) => client.requestJson({ method: 'POST', scope: 'api', path: 'harvest', jsonBody: omitUndefined({ sessions: parseOptionalInt(args.sessions, '--sessions') || 1, session_ids: parseOptionalJson(args.sessionIds, '--session-ids'), use_llm: parseOptionalBoolean(args.useLlm) || false, dry_run: parseOptionalBoolean(args.dryRun), min_confidence: parseOptionalFloat(args.minConfidence, '--min-confidence'), types: parseTags(args.types), project_path: args.projectPath || null }) }),
  'mcp-call': (client, args) => client.requestJson({ method: 'POST', scope: 'root', path: 'mcp', jsonBody: { jsonrpc: '2.0', id: parseJsonRpcId(args.id), method: requireString(args.method, '--method'), params: parseOptionalJson(args.params, '--params') || {} } }),
  'mcp-tools': jsonCommand('GET', 'root', 'mcp/tools'),
  'mcp-health': jsonCommand('GET', 'root', 'mcp/health'),
  call: (client, args) => runDirectTool(client, args),
  languages: jsonCommand('GET', 'api', 'languages'),
  'api-overview': textCommand('GET', 'root', 'api-overview'),
  dashboard: textCommand('GET', 'root', '')
};

const DIRECT_TOOL_COMMANDS: Record<string, string> = {
  check_database_health: 'health',
  store_memory: 'store',
  retrieve_memory: 'search',
  search_by_tag: 'search-by-tag',
  delete_memory: 'delete'
};

export async function runCommand(client: MemoryHttpClient, commandName: string, rawArgs: RawCliArguments): Promise<unknown> {
  const preparedArgs = await maybePreprocessArgs(commandName, rawArgs ?? {});
  const command = COMMANDS[commandName];
  if (!command) {
    throw new Error(`Unknown command: ${commandName}`);
  }

  return command(client, preparedArgs);
}

export function listCommands() {
  return Object.keys(COMMANDS).sort((left, right) => left.localeCompare(right));
}

async function runDirectTool(client: MemoryHttpClient, args: RawCliArguments): Promise<unknown> {
  const toolName = requireString(args.tool, '--tool');
  if (!DIRECT_TOOL_COMMANDS[toolName]) {
    throw new Error(`Unsupported tool: ${toolName}`);
  }

  const toolArguments = asArgumentRecord(parseOptionalJson(args.arguments, '--arguments'));
  if (toolName === 'check_database_health') {
    return normalizeHealthResponse(await client.requestJson({ method: 'GET', scope: 'api', path: 'health' }));
  }

  if (toolName === 'store_memory') {
    return client.requestJson({ method: 'POST', scope: 'api', path: 'memories', jsonBody: buildStoreBody(normalizeToolArguments(toolName, toolArguments)) });
  }

  if (toolName === 'retrieve_memory') {
    const response = await client.requestJson<MemorySearchResponse>({ method: 'POST', scope: 'api', path: 'search', jsonBody: buildSemanticSearchBody(normalizeToolArguments(toolName, toolArguments)) });
    return { memories: mapSearchResults(response.results) };
  }

  if (toolName === 'search_by_tag') {
    const response = await client.requestJson<MemorySearchResponse>({ method: 'POST', scope: 'api', path: 'search/by-tag', jsonBody: buildTagSearchBody(normalizeToolArguments(toolName, toolArguments)) });
    return { memories: mapSearchResults(response.results) };
  }

  return client.requestJson({ method: 'DELETE', scope: 'api', path: `memories/${encodeURIComponent(requireString(normalizeToolArguments(toolName, toolArguments).hash, '--hash'))}` });
}

function normalizeToolArguments(toolName: string, args: RawCliArguments): RawCliArguments {
  const metadata = asArgumentRecord(args.metadata);
  if (toolName === 'store_memory') {
    return {
      content: args.content,
      copilotInstruction: args.copilot_instruction,
      copilotPreprocess: args.copilot_preprocess,
      metadata: JSON.stringify(metadata),
      tags: firstOf(metadata.tags, args.tags),
      type: firstOf(metadata.type, args.memory_type)
    };
  }

  if (toolName === 'retrieve_memory') {
    return { query: args.query, nResults: args.n_results, similarityThreshold: args.similarity_threshold };
  }

  if (toolName === 'search_by_tag') {
    return { tags: args.tags, matchAll: args.match_all, timeFilter: args.time_filter };
  }

  if (toolName === 'delete_memory') {
    return { hash: args.content_hash };
  }

  return args;
}

function jsonCommand(method: string, scope: CommandScope, path: string): CommandHandler {
  return async (client) => client.requestJson({ method, scope, path });
}

function textCommand(method: string, scope: CommandScope, path: string): CommandHandler {
  return async (client) => client.requestText({ method, scope, path });
}

function asArgumentRecord(value: unknown): RawCliArguments {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RawCliArguments
    : {};
}
