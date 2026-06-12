import {
  DEFAULT_COPILOT_INSTRUCTION,
  DEFAULT_COPILOT_MODEL,
  DEFAULT_SEARCH_COPILOT_INSTRUCTION,
  preprocessMemoryText,
  preprocessSearchQuery
} from './mcp-memory-copilot-processor.js';
import { attachCuratorRetrievalHints, scoreMemoryDurability } from './proactive-retrieval.js';
import { checkForDuplicatesAutomatically, attachDuplicateCheckResult } from './automatic-duplicate-check.js';

import type { HookMessage, JsonObject, MultipartPart, RawCliArguments, SearchResult } from './types.js';

type CopilotMemoryResult = Awaited<ReturnType<typeof preprocessMemoryText>>;

interface CopilotMetadataExtra {
  treatedTurns?: number;
}

interface SearchResultSummary {
  content: string;
  metadata: {
    created_at: string;
    relevance_score: number | null;
    tags: string[];
    type: string;
  };
}

export async function maybePreprocessArgs(commandName: string, rawArgs: RawCliArguments): Promise<RawCliArguments> {
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

async function preprocessStoreArgs(rawArgs: RawCliArguments): Promise<RawCliArguments> {
  const content = requireString(rawArgs.content, '--content');
  const metadata = asObject(parseOptionalJson(rawArgs.metadata, '--metadata'));
  const model = readOptionalString(rawArgs.copilotModel);
  const processed = await preprocessMemoryText({
    commandName: 'store',
    content,
    instruction: readOptionalString(rawArgs.copilotInstruction) ?? DEFAULT_COPILOT_INSTRUCTION,
    ...(model === undefined ? {} : { model })
  });

  // Attach proactive retrieval hints for curator decision-making
  const enrichedMetadata = attachCuratorRetrievalHints(metadata, content);

  // Run automatic duplicate check for transient memories
  const durability = scoreMemoryDurability(content);
  const curatorMetadata = enrichedMetadata.curator as Record<string, unknown> | undefined;
  const proactiveQuery = (curatorMetadata?.proactiveRetrievalQuery as string) ?? '';
  const duplicateCheckResult = await checkForDuplicatesAutomatically(proactiveQuery, durability);
  const metadataWithDuplicateCheck = attachDuplicateCheckResult(enrichedMetadata, duplicateCheckResult);

  return {
    ...rawArgs,
    content: processed.content,
    metadata: JSON.stringify(mergeCopilotMetadata(metadataWithDuplicateCheck, processed, null))
  };
}

async function preprocessSessionArgs(rawArgs: RawCliArguments): Promise<RawCliArguments> {
  const turns = parseRequiredJson(rawArgs.turns, '--turns');
  const metadata = asObject(parseOptionalJson(rawArgs.metadata, '--metadata'));
  const normalizedTurns = Array.isArray(turns) ? turns : [];
  const processedTurns: unknown[] = [];
  const model = readOptionalString(rawArgs.copilotModel);

  for (const turn of normalizedTurns) {
    if (!isTurnWithContent(turn)) {
      processedTurns.push(turn);
      continue;
    }

    const processed = await preprocessMemoryText({
      commandName: 'session-store',
      content: turn.content,
      instruction: readOptionalString(rawArgs.copilotInstruction) ?? DEFAULT_COPILOT_INSTRUCTION,
      ...(model === undefined ? {} : { model }),
      role: turn.role ?? null
    });
    processedTurns.push({ ...turn, content: processed.content });
  }

  return {
    ...rawArgs,
    metadata: JSON.stringify(mergeCopilotMetadata(metadata, {
      content: '',
      instruction: readOptionalString(rawArgs.copilotInstruction) ?? DEFAULT_COPILOT_INSTRUCTION,
      metadata: {},
      model: readOptionalString(rawArgs.copilotModel) ?? process.env.MCP_MEMORY_COPILOT_MODEL ?? DEFAULT_COPILOT_MODEL,
      processor: process.env.MCP_MEMORY_COPILOT_CLI_COMMAND ?? 'gh copilot'
    }, { treatedTurns: processedTurns.length })),
    turns: processedTurns
  };
}

async function preprocessSemanticSearchArgs(commandName: string, rawArgs: RawCliArguments): Promise<RawCliArguments> {
  const model = readOptionalString(rawArgs.copilotModel);
  const rewritten = await preprocessSearchQuery({
    commandName,
    instruction: readOptionalString(rawArgs.copilotInstruction) ?? DEFAULT_SEARCH_COPILOT_INSTRUCTION,
    ...(model === undefined ? {} : { model }),
    query: requireString(rawArgs.query, '--query')
  });

  return omitUndefined({
    ...rawArgs,
    qualityBoost: firstOf(rawArgs.qualityBoost, rewritten.qualityBoost),
    qualityWeight: firstOf(rawArgs.qualityWeight, rewritten.qualityWeight),
    query: rewritten.query
  });
}

async function preprocessTimeSearchArgs(rawArgs: RawCliArguments): Promise<RawCliArguments> {
  const model = readOptionalString(rawArgs.copilotModel);
  const rewritten = await preprocessSearchQuery({
    commandName: 'search-by-time',
    instruction: readOptionalString(rawArgs.copilotInstruction) ?? DEFAULT_SEARCH_COPILOT_INSTRUCTION,
    ...(model === undefined ? {} : { model }),
    query: requireString(rawArgs.query, '--query')
  });

  return omitUndefined({
    ...rawArgs,
    query: rewritten.query,
    semanticQuery: firstOf(rawArgs.semanticQuery, rewritten.semanticQuery)
  });
}

function mergeCopilotMetadata(metadata: JsonObject, processed: CopilotMemoryResult, extra: CopilotMetadataExtra | null): JsonObject {
  return {
    ...metadata,
    copilot: omitUndefined({
      instruction: processed.instruction,
      model: processed.model,
      processor: processed.processor,
      treated_turns: extra?.treatedTurns
    }) as JsonObject
  };
}

export function normalizeHealthResponse(response: Record<string, unknown>): Record<string, unknown> {
  return omitUndefined({
    backend: firstOf(response.backend, response.storage_type),
    statistics: response.statistics,
    status: response.status
  });
}

export function buildStoreBody(args: RawCliArguments): Record<string, unknown> {
  return omitNullish({
    client_hostname: firstOf(args.clientHostname, args.client_hostname),
    content: requireString(args.content, '--content'),
    conversation_id: firstOf(args.conversationId, args.conversation_id) ?? null,
    memory_type: firstOf(args.type, args.memoryType) ?? null,
    metadata: asObject(parseOptionalJson(args.metadata, '--metadata')),
    tags: parseTags(args.tags)
  });
}

export function buildListQuery(args: RawCliArguments): Record<string, unknown> {
  return omitUndefined({
    page: parseOptionalInt(args.page, '--page'),
    page_size: parseOptionalInt(args.pageSize, '--page-size'),
    tag: args.tag,
    memory_type: args.memoryType,
    tag_match: args.tagMatch
  });
}

export function buildUpdateBody(args: RawCliArguments): Record<string, unknown> {
  return omitUndefined({
    memory_type: args.memoryType ?? null,
    metadata: parseOptionalJson(args.metadata, '--metadata') ?? undefined,
    tags: parseTags(args.tags)
  });
}

export function buildSessionBody(args: RawCliArguments): Record<string, unknown> {
  const tags = parseTags(args.tags);
  return omitNullish({
    metadata: asObject(parseOptionalJson(args.metadata, '--metadata')),
    session_id: args.sessionId ?? null,
    tags: tags.length > 0 ? tags : undefined,
    turns: parseRequiredJson(args.turns, '--turns')
  });
}

export function buildSemanticSearchBody(args: RawCliArguments): Record<string, unknown> {
  return omitUndefined({
    n_results: parseOptionalInt(firstOf(args.limit, args.nResults), '--limit') ?? 10,
    quality_boost: parseOptionalBoolean(args.qualityBoost),
    quality_weight: parseOptionalFloat(args.qualityWeight, '--quality-weight'),
    query: requireString(args.query, '--query'),
    similarity_threshold: parseOptionalFloat(firstOf(args.threshold, args.similarityThreshold), '--threshold')
  });
}

export function buildTagSearchBody(args: RawCliArguments): Record<string, unknown> {
  return {
    match_all: parseOptionalBoolean(firstOf(args.matchAll, args.match_all)) ?? false,
    tags: requireTags(args.tags, '--tags'),
    time_filter: firstOf(args.timeFilter, args.time_filter) ?? null
  };
}

export function buildTimeSearchBody(args: RawCliArguments): Record<string, unknown> {
  return omitUndefined({
    n_results: parseOptionalInt(firstOf(args.limit, args.nResults), '--limit') ?? 10,
    query: requireString(args.query, '--query'),
    semantic_query: firstOf(args.semanticQuery, args.semantic_query) ?? null
  });
}

export function mapSearchResults(results: unknown): SearchResultSummary[] {
  if (!Array.isArray(results)) {
    return [];
  }

  return results.map((entry) => {
    const searchResult = entry as SearchResult;
    return {
      content: searchResult.memory?.content ?? '',
      metadata: {
        created_at: searchResult.memory?.created_at_iso ?? '',
        relevance_score: searchResult.relevance_score ?? searchResult.similarity_score ?? null,
        tags: searchResult.memory?.tags ?? [],
        type: searchResult.memory?.memory_type ?? ''
      }
    };
  });
}

export function buildUploadParts(args: RawCliArguments, multiple: boolean): MultipartPart[] {
  const fileValues = multiple ? requireFileList(args.files, '--files') : [requireString(args.file, '--file')];
  const fileField = multiple ? 'files' : 'file';
  const parts: MultipartPart[] = fileValues.map((filePath) => ({ kind: 'file', name: fileField, path: filePath }));
  return [...parts, ...buildScalarUploadParts(args)];
}

function buildScalarUploadParts(args: RawCliArguments): MultipartPart[] {
  return [
    { kind: 'field', name: 'tags', value: readOptionalString(args.tags) ?? '' },
    { kind: 'field', name: 'chunk_size', value: parseOptionalInt(args.chunkSize, '--chunk-size') ?? 1000 },
    { kind: 'field', name: 'chunk_overlap', value: parseOptionalInt(args.chunkOverlap, '--chunk-overlap') ?? 200 },
    { kind: 'field', name: 'memory_type', value: readOptionalString(args.memoryType) ?? 'document' }
  ];
}

export function parseTags(value: unknown): string[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

   if (typeof value !== 'string') {
    throw new TypeError('Expected tags to be a string or an array of strings.');
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function requireTags(value: unknown, optionName: string): string[] {
  const tags = parseTags(value);
  if (tags.length === 0) {
    throw new Error(`Missing required option ${optionName}`);
  }

  return tags;
}

function requireFileList(value: unknown, optionName: string): string[] {
  const files = parseTags(value);
  if (files.length === 0) {
    throw new Error(`Missing required option ${optionName}`);
  }

  return files;
}

export function parseOptionalJson(value: unknown, optionName: string): unknown {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown JSON parsing error';
    throw new Error(`Invalid JSON for ${optionName}: ${message}`);
  }
}

function parseRequiredJson(value: unknown, optionName: string): unknown {
  const parsed = parseOptionalJson(value, optionName);
  if (parsed === null) {
    throw new Error(`Missing required option ${optionName}`);
  }

  return parsed;
}

export function parseOptionalInt(value: unknown, optionName: string): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new TypeError(`Invalid integer for ${optionName}`);
  }

  const parsed = Number.parseInt(`${value}`, 10);
  if (Number.isNaN(parsed)) {
    throw new TypeError(`Invalid integer for ${optionName}`);
  }

  return parsed;
}

export function requireInt(value: unknown, optionName: string): number {
  const parsed = parseOptionalInt(value, optionName);
  if (parsed === undefined) {
    throw new Error(`Missing required option ${optionName}`);
  }

  return parsed;
}

export function parseOptionalFloat(value: unknown, optionName: string): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new TypeError(`Invalid number for ${optionName}`);
  }

  const parsed = Number.parseFloat(`${value}`);
  if (Number.isNaN(parsed)) {
    throw new TypeError(`Invalid number for ${optionName}`);
  }

  return parsed;
}

export function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError('Invalid boolean value.');
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

export function requireBoolean(value: unknown, optionName: string): boolean {
  const parsed = parseOptionalBoolean(value);
  if (parsed === undefined) {
    throw new Error(`Missing required option ${optionName}`);
  }

  return parsed;
}

export function requireString(value: unknown, optionName: string): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  throw new Error(`Missing required option ${optionName}`);
}

function isTurnWithContent(value: unknown): value is HookMessage & { content: string; role?: string } {
  const record = asRecord(value);
  return typeof record.content === 'string';
}

export function parseJsonRpcId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError('Invalid JSON-RPC id.');
  }

  return String(value);
}

export function firstOf<T>(...values: T[]): T | undefined {
  return values.find((value) => value !== undefined);
}

export function omitUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

export function omitNullish<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null));
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asObject(value: unknown): JsonObject {
  return isRecord(value) ? value as JsonObject : {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
