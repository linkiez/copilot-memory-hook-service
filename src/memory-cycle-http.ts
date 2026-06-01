import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type {
  ActiveSession,
  MemoryListResponse,
  MemorySearchResponse,
  RemoteClient,
  SessionSnapshotParseResult,
  SessionStateSource,
  SessionSummaryInput,
  StoredMemory,
  StructuredMemoryInput
} from './types.js';

interface StoreMemoryResponse {
  content_hash?: string;
}

export function createRemoteClient(scriptDir: string, env: NodeJS.ProcessEnv): RemoteClient {
  return {
    apiKey: env.MCP_MEMORY_API_KEY ?? '',
    cliPath: path.join(scriptDir, 'mcp-memory-http-cli.js'),
    endpoint: env.MCP_MEMORY_HTTP_ENDPOINT ?? '',
    env,
    nodePath: process.execPath,
    sessionCacheDir: path.resolve(scriptDir, '..', '..', 'session-state', 'memory-hook'),
    sessionCacheMaxAgeMs: normalizeSessionCacheMaxAge(env.MEMORY_HOOK_SESSION_CACHE_MAX_AGE_MS)
  };
}

export function listKnownMemories(client: RemoteClient): StoredMemory[] {
  const response = runCli<MemoryListResponse>(client, 'list', { pageSize: 10 });
  return (response.memories ?? []).filter(isRecallEligibleMemory);
}

export function loadActiveSession(client: RemoteClient, sessionId: string): ActiveSession | null {
  const localSession = loadLocalActiveSession(client, sessionId);
  if (localSession) {
    return attachSessionLoadMeta(localSession, 'local-cache', ['local-cache']);
  }

  const response = runCli<MemoryListResponse>(client, 'list', { pageSize: 20, tag: 'hook-state' });
  const activeMemory = (response.memories ?? [])
    .filter((memory) => memory.tags.includes('active-session'))
    .filter((memory) => matchesSession(memory, sessionId))
    .map((memory) => ({ memory, snapshot: parseSessionSnapshot(memory) }))
    .filter((entry): entry is { memory: StoredMemory; snapshot: SessionSnapshotParseResult } => entry.snapshot !== null)
    .sort(compareSessionSnapshots)[0]?.memory;

  if (!activeMemory) {
    return null;
  }

  const snapshotResult = parseSessionSnapshot(activeMemory);
  const session = snapshotResult?.snapshot ? { ...snapshotResult.snapshot, remoteHash: activeMemory.content_hash } : null;
  if (!session || !snapshotResult) {
    return null;
  }

  saveLocalActiveSession(client, session);
  return attachSessionLoadMeta(
    session,
    resolveRemoteStateSource(snapshotResult.fallbacks),
    snapshotResult.fallbacks.length > 0 ? snapshotResult.fallbacks : ['remote-metadata']
  );
}

export function clearActiveSessionSnapshots(client: RemoteClient, sessionId: string): void {
  clearLocalActiveSession(client, sessionId);
  const response = runCli<MemoryListResponse>(client, 'list', { pageSize: 20, tag: 'hook-state' });
  for (const memory of response.memories ?? []) {
    if (memory.tags.includes('active-session') && matchesSession(memory, sessionId)) {
      deleteActiveSessionSnapshot(client, memory.content_hash);
    }
  }
}

export function saveActiveSession(client: RemoteClient, session: ActiveSession): ActiveSession {
  const previousHash = session.remoteHash;
  const { remoteHash: _ignoredRemoteHash, ...snapshot } = session;

  if (previousHash) {
    deleteActiveSessionSnapshot(client, previousHash);
  }

  const response = runCli<StoreMemoryResponse>(client, 'store', {
    content: buildActiveSessionContent(snapshot),
    metadata: {
      categories: normalizeCategories(session.categories),
      category: 'workflow',
      kind: 'active-session',
      session_id: session.id,
      session_snapshot: snapshot,
      source: 'memory-hook'
    },
    tags: ['hook-state', 'active-session', 'memory-cycle', `hook-session:${session.id}`].join(','),
    type: 'observation'
  });

  const nextRemoteHash = response.content_hash ?? previousHash;
  const nextSession: ActiveSession = {
    ...session,
    ...(nextRemoteHash ? { remoteHash: nextRemoteHash } : {})
  };
  saveLocalActiveSession(client, nextSession);
  return nextSession;
}

export function deleteActiveSessionSnapshot(client: RemoteClient, hash?: string): void {
  if (!hash) {
    return;
  }

  runCli(client, 'delete', { hash });
}

export function remoteSearch(client: RemoteClient, query: string): StoredMemory[] {
  const response = runCli<MemorySearchResponse>(client, 'search', { limit: 4, query });
  return (response.results ?? []).map((item) => item.memory).filter(isRecallEligibleMemory);
}

export function storeStructuredMemory(client: RemoteClient, memory: StructuredMemoryInput): unknown {
  return runCli(client, 'store', {
    content: memory.content,
    conversationId: memory.conversationId,
    metadata: memory.metadata ?? {},
    tags: (memory.tags ?? []).join(','),
    type: memory.memoryType ?? 'observation'
  });
}

export function storeSessionSummary(client: RemoteClient, session: SessionSummaryInput): unknown {
  return runCli(client, 'session-store', {
    metadata: session.metadata ?? {},
    sessionId: session.sessionId,
    tags: (session.tags ?? []).join(','),
    turns: session.turns
  });
}

function runCli<T>(client: RemoteClient, command: string, args: Record<string, unknown>): T {
  const commandArguments = [client.cliPath];
  if (client.endpoint) {
    commandArguments.push('--endpoint', client.endpoint);
  }

  if (client.apiKey) {
    commandArguments.push('--api-key', client.apiKey);
  }

  commandArguments.push(command, ...serializeArgs(args));
  const result = spawnSync(client.nodePath, commandArguments, {
    encoding: 'utf8',
    env: client.env
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `CLI command failed: ${command}`).trim());
  }

  const text = result.stdout.trim();
  return (text.length > 0 ? JSON.parse(text) : {}) as T;
}

function serializeArgs(args: Record<string, unknown>): string[] {
  const output: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    const normalizedKey = key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
    const optionName = `--${normalizedKey}`;
    if (typeof value === 'boolean') {
      if (value) {
        output.push(optionName);
      }
      continue;
    }

    output.push(optionName, typeof value === 'string' ? value : JSON.stringify(value));
  }

  return output;
}

function normalizeCategories(categories: unknown[]): string[] {
  return [...new Set((Array.isArray(categories) ? categories : []).filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

function isRecallEligibleMemory(memory: StoredMemory): boolean {
  if (memory.tags.includes('hook-state')) {
    return false;
  }

  return memory.metadata?.source !== 'precompact-hook';
}

function loadLocalActiveSession(client: RemoteClient, sessionId: string): ActiveSession | null {
  const filePath = getSessionCacheFilePath(client, sessionId);
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  try {
    const session = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ActiveSession;
    if (isExpiredSessionCache(client, session)) {
      clearLocalActiveSession(client, sessionId);
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

function saveLocalActiveSession(client: RemoteClient, session: ActiveSession): void {
  const filePath = getSessionCacheFilePath(client, session.id);
  if (!filePath) {
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(session), 'utf8');
}

export function clearLocalActiveSession(client: RemoteClient, sessionId: string): void {
  const filePath = getSessionCacheFilePath(client, sessionId);
  if (!filePath || !fs.existsSync(filePath)) {
    return;
  }

  fs.rmSync(filePath, { force: true });
}

function getSessionCacheFilePath(client: RemoteClient, sessionId: string): string {
  if (!sessionId) {
    return '';
  }

  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/gu, '_');
  return path.join(client.sessionCacheDir, `${safeSessionId}.json`);
}

function matchesSession(memory: StoredMemory, sessionId: string): boolean {
  if (!sessionId) {
    return true;
  }

  return memory.metadata?.session_id === sessionId || memory.tags.includes(`hook-session:${sessionId}`);
}

function compareSessionSnapshots(
  left: { memory: StoredMemory; snapshot: SessionSnapshotParseResult },
  right: { memory: StoredMemory; snapshot: SessionSnapshotParseResult }
): number {
  const richnessDelta = getSessionSnapshotRichness(right.snapshot.snapshot) - getSessionSnapshotRichness(left.snapshot.snapshot);
  if (richnessDelta !== 0) {
    return richnessDelta;
  }

  const updatedDelta = getSessionSnapshotTimestamp(right.snapshot.snapshot, right.memory) - getSessionSnapshotTimestamp(left.snapshot.snapshot, left.memory);
  if (updatedDelta !== 0) {
    return updatedDelta;
  }

  return new Date(right.memory.created_at_iso ?? 0).getTime() - new Date(left.memory.created_at_iso ?? 0).getTime();
}

function getSessionSnapshotRichness(snapshot: ActiveSession): number {
  return snapshot.promptCount * 1000
    + snapshot.prompts.length * 100
    + snapshot.tools.length * 50
    + snapshot.subagents.length * 25
    + snapshot.keywords.length * 10
    + snapshot.categories.length * 5;
}

function getSessionSnapshotTimestamp(snapshot: ActiveSession, memory: StoredMemory): number {
  const snapshotUpdatedAt = new Date(snapshot.updatedAt).getTime();
  if (snapshotUpdatedAt > 0) {
    return snapshotUpdatedAt;
  }

  return new Date(memory.updated_at_iso ?? 0).getTime();
}

function parseSessionSnapshot(memory: StoredMemory): SessionSnapshotParseResult | null {
  const metadataSnapshot = memory.metadata?.session_snapshot;
  if (isRecord(metadataSnapshot)) {
    return { fallbacks: ['metadata-session-snapshot'], snapshot: metadataSnapshot as unknown as ActiveSession };
  }

  if (typeof metadataSnapshot === 'string') {
    try {
      return { fallbacks: ['metadata-session-snapshot-string'], snapshot: JSON.parse(metadataSnapshot) as ActiveSession };
    } catch {
      return parseSessionSnapshotFromContent(memory.content, ['metadata-parse-failed']);
    }
  }

  return parseSessionSnapshotFromContent(memory.content, []);
}

function buildActiveSessionContent(session: ActiveSession): string {
  const categories = normalizeCategories(session.categories).join(', ') || 'workflow';
  const topics = session.keywords.length > 0 ? session.keywords.slice(0, 8).join(', ') : 'none';
  const latestPrompt = session.prompts.at(-1) ?? 'none';
  const encodedSnapshot = Buffer.from(JSON.stringify(session)).toString('base64url');

  return [
    'MEMORY_RECORD',
    'CATEGORY=workflow',
    'CATEGORIES=workflow, hook-state',
    `SESSION_ID=${session.id}`,
    `PROMPT_COUNT=${session.promptCount}`,
    `RECALL_STATUS=${session.recall.status}`,
    `TOPICS=${topics}`,
    `LATEST_PROMPT=${latestPrompt}`,
    `SESSION_CATEGORIES=${categories}`,
    `SESSION_SNAPSHOT=${encodedSnapshot}`,
    'SUMMARY=Active memory-cycle session snapshot stored in metadata.session_snapshot.'
  ].join('\n');
}

function parseSessionSnapshotFromContent(content: string, previousFallbacks: string[]): SessionSnapshotParseResult | null {
  const snapshotMatch = /^SESSION_SNAPSHOT=(.+)$/m.exec(content);
  const encodedSnapshot = snapshotMatch?.[1]?.trim();
  if (encodedSnapshot) {
    try {
      return {
        fallbacks: [...previousFallbacks, 'content-session-snapshot'],
        snapshot: JSON.parse(Buffer.from(encodedSnapshot, 'base64url').toString('utf8')) as ActiveSession
      };
    } catch {
      return null;
    }
  }

  try {
    return {
      fallbacks: [...previousFallbacks, 'legacy-json-content'],
      snapshot: JSON.parse(content) as ActiveSession
    };
  } catch {
    return null;
  }
}

function attachSessionLoadMeta(session: ActiveSession, stateSource: SessionStateSource, stateFallbacks: string[]): ActiveSession {
  return {
    ...session,
    stateFallbacks: [...new Set(stateFallbacks.filter(Boolean))],
    stateSource
  };
}

function resolveRemoteStateSource(fallbacks: string[]): SessionStateSource {
  if (fallbacks.includes('content-session-snapshot') || fallbacks.includes('legacy-json-content')) {
    return 'content-fallback';
  }

  return 'remote-metadata';
}

function normalizeSessionCacheMaxAge(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15 * 60 * 1000;
}

function isExpiredSessionCache(client: RemoteClient, session: ActiveSession): boolean {
  const updatedAt = new Date(session.updatedAt).getTime();
  if (updatedAt <= 0) {
    return true;
  }

  return Date.now() - updatedAt > client.sessionCacheMaxAgeMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}