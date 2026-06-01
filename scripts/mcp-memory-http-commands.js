const { DEFAULT_COPILOT_INSTRUCTION, DEFAULT_COPILOT_MODEL, DEFAULT_SEARCH_COPILOT_INSTRUCTION, preprocessMemoryText, preprocessSearchQuery } = require('./mcp-memory-copilot-processor');

const COMMANDS = {
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

const DIRECT_TOOL_COMMANDS = {
  check_database_health: 'health',
  store_memory: 'store',
  retrieve_memory: 'search',
  search_by_tag: 'search-by-tag',
  delete_memory: 'delete'
};

async function runCommand(client, commandName, rawArgs) {
  const preparedArgs = await maybePreprocessArgs(commandName, rawArgs || {});
  const command = COMMANDS[commandName];
  if (!command) {
    throw new Error(`Unknown command: ${commandName}`);
  }

  return command(client, preparedArgs);
}

function listCommands() {
  return Object.keys(COMMANDS).sort((left, right) => left.localeCompare(right));
}

async function runDirectTool(client, args) {
  const toolName = requireString(args.tool, '--tool');
  if (!DIRECT_TOOL_COMMANDS[toolName]) {
    throw new Error(`Unsupported tool: ${toolName}`);
  }

  const toolArguments = parseOptionalJson(args.arguments, '--arguments') || {};
  if (toolName === 'check_database_health') {
    return normalizeHealthResponse(await client.requestJson({ method: 'GET', scope: 'api', path: 'health' }));
  }

  if (toolName === 'store_memory') {
    return client.requestJson({ method: 'POST', scope: 'api', path: 'memories', jsonBody: buildStoreBody(normalizeToolArguments(toolName, toolArguments)) });
  }

  if (toolName === 'retrieve_memory') {
    const response = await client.requestJson({ method: 'POST', scope: 'api', path: 'search', jsonBody: buildSemanticSearchBody(normalizeToolArguments(toolName, toolArguments)) });
    return { memories: mapSearchResults(response.results) };
  }

  if (toolName === 'search_by_tag') {
    const response = await client.requestJson({ method: 'POST', scope: 'api', path: 'search/by-tag', jsonBody: buildTagSearchBody(normalizeToolArguments(toolName, toolArguments)) });
    return { memories: mapSearchResults(response.results) };
  }

  return client.requestJson({ method: 'DELETE', scope: 'api', path: `memories/${encodeURIComponent(requireString(normalizeToolArguments(toolName, toolArguments).hash, '--hash'))}` });
}

function normalizeToolArguments(toolName, args) {
  if (toolName === 'store_memory') {
    return { content: args.content, tags: args.metadata?.tags || args.tags, type: args.metadata?.type || args.memory_type, metadata: JSON.stringify(args.metadata || {}), copilotPreprocess: args.copilot_preprocess, copilotInstruction: args.copilot_instruction };
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

function jsonCommand(method, scope, path) {
  return (client) => client.requestJson({ method, scope, path });
}

async function maybePreprocessArgs(commandName, rawArgs) {
  if (!parseOptionalBoolean(rawArgs.copilotPreprocess)) {
    return rawArgs;
  }

  if (commandName === 'store') {
    return preprocessStoreArgs(rawArgs);
  }

  if (commandName === 'session-store') {
    return preprocessSessionArgs(rawArgs);
  }

  if (commandName === 'search' || commandName === 'retrieve') {
    return preprocessSemanticSearchArgs(commandName, rawArgs);
  }

  if (commandName === 'search-by-time') {
    return preprocessTimeSearchArgs(rawArgs);
  }

  return rawArgs;
}

async function preprocessStoreArgs(rawArgs) {
  const metadata = parseOptionalJson(rawArgs.metadata, '--metadata') || {};
  const processed = await preprocessMemoryText({
    content: requireString(rawArgs.content, '--content'),
    instruction: rawArgs.copilotInstruction || DEFAULT_COPILOT_INSTRUCTION,
    commandName: 'store',
    model: rawArgs.copilotModel
  });

  return {
    ...rawArgs,
    content: processed.content,
    metadata: JSON.stringify(mergeCopilotMetadata(metadata, processed, null))
  };
}

async function preprocessSessionArgs(rawArgs) {
  const turns = parseRequiredJson(rawArgs.turns, '--turns');
  const metadata = parseOptionalJson(rawArgs.metadata, '--metadata') || {};
  const normalizedTurns = Array.isArray(turns) ? turns : [];
  const processedTurns = [];

  for (const turn of normalizedTurns) {
    if (!isTurnWithContent(turn)) {
      processedTurns.push(turn);
      continue;
    }

    const processed = await preprocessMemoryText({
      content: turn.content,
      instruction: rawArgs.copilotInstruction || DEFAULT_COPILOT_INSTRUCTION,
      commandName: 'session-store',
      role: turn.role,
      model: rawArgs.copilotModel
    });
    processedTurns.push({ ...turn, content: processed.content });
  }

  return {
    ...rawArgs,
    turns: processedTurns,
    metadata: JSON.stringify(mergeCopilotMetadata(metadata, {
      instruction: rawArgs.copilotInstruction || DEFAULT_COPILOT_INSTRUCTION,
      processor: process.env.MCP_MEMORY_COPILOT_CLI_COMMAND || 'gh copilot',
      model: rawArgs.copilotModel || process.env.MCP_MEMORY_COPILOT_MODEL || DEFAULT_COPILOT_MODEL,
      metadata: {}
    }, { treatedTurns: processedTurns.length }))
  };
}

async function preprocessSemanticSearchArgs(commandName, rawArgs) {
  const rewritten = await preprocessSearchQuery({
    query: requireString(rawArgs.query, '--query'),
    instruction: rawArgs.copilotInstruction || DEFAULT_SEARCH_COPILOT_INSTRUCTION,
    commandName,
    model: rawArgs.copilotModel
  });

  return omitUndefined({
    ...rawArgs,
    query: rewritten.query,
    qualityBoost: firstOf(rawArgs.qualityBoost, rewritten.qualityBoost),
    qualityWeight: firstOf(rawArgs.qualityWeight, rewritten.qualityWeight)
  });
}

async function preprocessTimeSearchArgs(rawArgs) {
  const rewritten = await preprocessSearchQuery({
    query: requireString(rawArgs.query, '--query'),
    instruction: rawArgs.copilotInstruction || DEFAULT_SEARCH_COPILOT_INSTRUCTION,
    commandName: 'search-by-time',
    model: rawArgs.copilotModel
  });

  return omitUndefined({
    ...rawArgs,
    query: rewritten.query,
    semanticQuery: firstOf(rawArgs.semanticQuery, rewritten.semanticQuery)
  });
}

function mergeCopilotMetadata(metadata, processed, extra) {
  return {
    ...metadata,
    copilot: omitUndefined({
      instruction: processed.instruction,
      processor: processed.processor,
      model: processed.model,
      treated_turns: extra?.treatedTurns
    })
  };
}

function normalizeHealthResponse(response) {
  return omitUndefined({
    status: response.status,
    backend: response.backend || response.storage_type,
    statistics: response.statistics
  });
}

function textCommand(method, scope, path) {
  return (client) => client.requestText({ method, scope, path });
}

function buildStoreBody(args) {
  return omitNullish({ content: requireString(args.content, '--content'), tags: parseTags(args.tags), memory_type: args.type || args.memoryType || null, metadata: parseOptionalJson(args.metadata, '--metadata') || {}, client_hostname: firstOf(args.clientHostname, args.client_hostname), conversation_id: firstOf(args.conversationId, args.conversation_id) || null });
}

function buildListQuery(args) {
  return omitUndefined({ page: parseOptionalInt(args.page, '--page'), page_size: parseOptionalInt(args.pageSize, '--page-size'), tag: args.tag, memory_type: args.memoryType, tag_match: args.tagMatch });
}

function buildUpdateBody(args) {
  return omitUndefined({ tags: parseTags(args.tags), memory_type: args.memoryType || null, metadata: parseOptionalJson(args.metadata, '--metadata') });
}

function buildSessionBody(args) {
  const tags = parseTags(args.tags);
  return omitNullish({ turns: parseRequiredJson(args.turns, '--turns'), session_id: args.sessionId || null, tags: tags.length > 0 ? tags : undefined, metadata: parseOptionalJson(args.metadata, '--metadata') || {} });
}

function buildSemanticSearchBody(args) {
  return omitUndefined({ query: requireString(args.query, '--query'), n_results: parseOptionalInt(firstOf(args.limit, args.nResults), '--limit') || 10, similarity_threshold: parseOptionalFloat(firstOf(args.threshold, args.similarityThreshold), '--threshold'), quality_boost: parseOptionalBoolean(args.qualityBoost), quality_weight: parseOptionalFloat(args.qualityWeight, '--quality-weight') });
}

function buildTagSearchBody(args) {
  return { tags: requireTags(args.tags, '--tags'), match_all: parseOptionalBoolean(firstOf(args.matchAll, args.match_all)) || false, time_filter: firstOf(args.timeFilter, args.time_filter) || null };
}

function buildTimeSearchBody(args) {
  return omitUndefined({ query: requireString(args.query, '--query'), n_results: parseOptionalInt(firstOf(args.limit, args.nResults), '--limit') || 10, semantic_query: args.semanticQuery || null });
}

function mapSearchResults(results) {
  if (!Array.isArray(results)) {
    return [];
  }

  return results.map((entry) => ({
    content: entry.memory?.content || '',
    metadata: {
      tags: entry.memory?.tags || [],
      type: entry.memory?.memory_type || '',
      created_at: entry.memory?.created_at_iso || '',
      relevance_score: entry.relevance_score ?? entry.similarity_score ?? null
    }
  }));
}

function buildUploadParts(args, multiple) {
  const fileValues = multiple ? requireFileList(args.files, '--files') : [requireString(args.file, '--file')];
  const fileField = multiple ? 'files' : 'file';
  const parts = fileValues.map((filePath) => ({ kind: 'file', name: fileField, path: filePath }));
  return parts.concat(buildScalarUploadParts(args));
}

function buildScalarUploadParts(args) {
  return [
    { name: 'tags', value: args.tags || '' },
    { name: 'chunk_size', value: parseOptionalInt(args.chunkSize, '--chunk-size') || 1000 },
    { name: 'chunk_overlap', value: parseOptionalInt(args.chunkOverlap, '--chunk-overlap') || 200 },
    { name: 'memory_type', value: args.memoryType || 'document' }
  ];
}

function parseTags(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function requireTags(value, optionName) {
  const tags = parseTags(value);
  if (tags.length === 0) {
    throw new Error(`Missing required option ${optionName}`);
  }

  return tags;
}

function requireFileList(value, optionName) {
  const files = parseTags(value);
  if (files.length === 0) {
    throw new Error(`Missing required option ${optionName}`);
  }

  return files;
}

function parseOptionalJson(value, optionName) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON for ${optionName}: ${error.message}`);
  }
}

function parseRequiredJson(value, optionName) {
  const parsed = parseOptionalJson(value, optionName);
  if (parsed === null) {
    throw new Error(`Missing required option ${optionName}`);
  }

  return parsed;
}

function parseOptionalInt(value, optionName) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    throw new TypeError(`Invalid integer for ${optionName}`);
  }

  return parsed;
}

function requireInt(value, optionName) {
  const parsed = parseOptionalInt(value, optionName);
  if (parsed === undefined) {
    throw new Error(`Missing required option ${optionName}`);
  }

  return parsed;
}

function parseOptionalFloat(value, optionName) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = Number.parseFloat(String(value));
  if (Number.isNaN(parsed)) {
    throw new TypeError(`Invalid number for ${optionName}`);
  }

  return parsed;
}

function parseOptionalBoolean(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  return Boolean(value);
}

function requireBoolean(value, optionName) {
  const parsed = parseOptionalBoolean(value);
  if (parsed === undefined) {
    throw new Error(`Missing required option ${optionName}`);
  }

  return parsed;
}

function requireString(value, optionName) {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  throw new Error(`Missing required option ${optionName}`);
}

function isTurnWithContent(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.content === 'string';
}

function parseJsonRpcId(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return String(value);
}

function firstOf(...values) {
  return values.find((value) => value !== undefined);
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function omitNullish(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null));
}

module.exports = {
  listCommands,
  runCommand
};