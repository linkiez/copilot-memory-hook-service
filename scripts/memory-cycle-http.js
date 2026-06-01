const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function createRemoteClient(scriptDir, env) {
  return {
    endpoint: env.MCP_MEMORY_HTTP_ENDPOINT || '',
    apiKey: env.MCP_MEMORY_API_KEY || '',
    cliPath: path.join(scriptDir, 'mcp-memory-http-cli.js'),
    sessionCacheMaxAgeMs: normalizeSessionCacheMaxAge(env.MEMORY_HOOK_SESSION_CACHE_MAX_AGE_MS),
    sessionCacheDir: path.resolve(scriptDir, '..', '..', 'session-state', 'memory-hook'),
    nodePath: process.execPath,
    env
  };
}

function listKnownMemories(client) {
  const response = runCli(client, 'list', { pageSize: 10 });
  return (response.memories || []).filter(isRecallEligibleMemory);
}

function loadActiveSession(client, sessionId) {
  const localSession = loadLocalActiveSession(client, sessionId);
  if (localSession) {
    return attachSessionLoadMeta(localSession, 'local-cache', ['local-cache']);
  }

  const response = runCli(client, 'list', { tag: 'hook-state', pageSize: 20 });
  const activeMemory = (response.memories || [])
    .filter((memory) => memory.tags.includes('active-session'))
    .filter((memory) => matchesSession(memory, sessionId))
    .map((memory) => ({
      memory,
      snapshot: parseSessionSnapshot(memory)
    }))
    .filter((entry) => entry.snapshot)
    .sort(compareSessionSnapshots)[0]?.memory;

  if (!activeMemory) {
    return null;
  }

  const snapshotResult = parseSessionSnapshot(activeMemory);
  const session = snapshotResult?.snapshot ? {
    ...snapshotResult.snapshot,
    remoteHash: activeMemory.content_hash
  } : null;
  if (session) {
    saveLocalActiveSession(client, session);
    return attachSessionLoadMeta(
      session,
      resolveRemoteStateSource(snapshotResult.fallbacks),
      snapshotResult.fallbacks || ['remote-metadata']
    );
  }

  return null;
}

function clearActiveSessionSnapshots(client, sessionId) {
  clearLocalActiveSession(client, sessionId);
  const response = runCli(client, 'list', { tag: 'hook-state', pageSize: 20 });
  for (const memory of response.memories || []) {
    if (memory.tags.includes('active-session') && matchesSession(memory, sessionId)) {
      deleteActiveSessionSnapshot(client, memory.content_hash);
    }
  }
}

function saveActiveSession(client, session) {
  const previousHash = session.remoteHash;
  const snapshot = { ...session };
  delete snapshot.remoteHash;

  if (previousHash) {
    deleteActiveSessionSnapshot(client, previousHash);
  }

  const response = runCli(client, 'store', {
    content: buildActiveSessionContent(snapshot),
    tags: ['hook-state', 'active-session', 'memory-cycle', `hook-session:${session.id}`].join(','),
    metadata: {
      kind: 'active-session',
      source: 'memory-hook',
      session_id: session.id,
      category: 'workflow',
      categories: normalizeCategories(session.categories),
      session_snapshot: snapshot
    },
    type: 'observation'
  });

  const nextHash = response?.content_hash || previousHash;
  const nextSession = { ...session, remoteHash: nextHash };
  saveLocalActiveSession(client, nextSession);

  return nextSession;
}

function deleteActiveSessionSnapshot(client, hash) {
  if (!hash) {
    return;
  }

  runCli(client, 'delete', { hash });
}

function remoteSearch(client, query) {
  const response = runCli(client, 'search', { query, limit: 4 });
  return (response.results || []).map((item) => item.memory).filter(isRecallEligibleMemory);
}

function storeStructuredMemory(client, memory) {
  return runCli(client, 'store', {
    content: memory.content,
    tags: (memory.tags || []).join(','),
    metadata: memory.metadata || {},
    type: memory.memoryType || 'observation',
    conversationId: memory.conversationId
  });
}

function storeSessionSummary(client, session) {
  return runCli(client, 'session-store', {
    turns: session.turns,
    sessionId: session.sessionId,
    tags: (session.tags || []).join(','),
    metadata: session.metadata || {}
  });
}

function runCli(client, command, args) {
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

  const text = String(result.stdout || '').trim();
  return text ? JSON.parse(text) : {};
}

function serializeArgs(args) {
  const output = [];
  for (const [key, value] of Object.entries(args || {})) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    const normalizedKey = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
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

function normalizeCategories(categories) {
  const list = Array.isArray(categories) ? categories : [];
  return [...new Set(list.filter(Boolean))];
}

function isRecallEligibleMemory(memory) {
  if (!memory || !Array.isArray(memory.tags)) {
    return false;
  }

  if (memory.tags.includes('hook-state')) {
    return false;
  }

  return memory?.metadata?.source !== 'precompact-hook';
}

function loadLocalActiveSession(client, sessionId) {
  const filePath = getSessionCacheFilePath(client, sessionId);
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  try {
    const session = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (isExpiredSessionCache(client, session)) {
      clearLocalActiveSession(client, sessionId);
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

function saveLocalActiveSession(client, session) {
  const filePath = getSessionCacheFilePath(client, session?.id);
  if (!filePath) {
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(session), 'utf8');
}

function clearLocalActiveSession(client, sessionId) {
  const filePath = getSessionCacheFilePath(client, sessionId);
  if (!filePath || !fs.existsSync(filePath)) {
    return;
  }

  fs.rmSync(filePath, { force: true });
}

function getSessionCacheFilePath(client, sessionId) {
  if (!sessionId) {
    return '';
  }

  const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(client.sessionCacheDir, `${safeSessionId}.json`);
}

function matchesSession(memory, sessionId) {
  if (!sessionId) {
    return true;
  }

  const normalizedSessionId = String(sessionId).trim();
  return memory?.metadata?.session_id === normalizedSessionId || memory?.tags?.includes(`hook-session:${normalizedSessionId}`);
}

function compareSessionSnapshots(left, right) {
  const leftSnapshot = left.snapshot;
  const rightSnapshot = right.snapshot;
  const richnessDelta = getSessionSnapshotRichness(rightSnapshot) - getSessionSnapshotRichness(leftSnapshot);
  if (richnessDelta !== 0) {
    return richnessDelta;
  }

  const updatedDelta = getSessionSnapshotTimestamp(rightSnapshot, right.memory) - getSessionSnapshotTimestamp(leftSnapshot, left.memory);
  if (updatedDelta !== 0) {
    return updatedDelta;
  }

  return new Date(right.memory?.created_at_iso || 0).getTime() - new Date(left.memory?.created_at_iso || 0).getTime();
}

function getSessionSnapshotRichness(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return -1;
  }

  return Number(snapshot.promptCount || 0) * 1000
    + getArrayLength(snapshot.prompts) * 100
    + getArrayLength(snapshot.tools) * 50
    + getArrayLength(snapshot.subagents) * 25
    + getArrayLength(snapshot.keywords) * 10
    + getArrayLength(snapshot.categories) * 5;
}

function getSessionSnapshotTimestamp(snapshot, memory) {
  const snapshotUpdatedAt = new Date(snapshot?.updatedAt || 0).getTime();
  if (snapshotUpdatedAt > 0) {
    return snapshotUpdatedAt;
  }

  return new Date(memory?.updated_at_iso || 0).getTime();
}

function getArrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function parseSessionSnapshot(memory) {
  const metadataSnapshot = memory?.metadata?.session_snapshot;
  if (metadataSnapshot && typeof metadataSnapshot === 'object' && !Array.isArray(metadataSnapshot)) {
    return { snapshot: metadataSnapshot, fallbacks: ['metadata-session-snapshot'] };
  }

  if (typeof metadataSnapshot === 'string') {
    try {
      return { snapshot: JSON.parse(metadataSnapshot), fallbacks: ['metadata-session-snapshot-string'] };
    } catch {
      return parseSessionSnapshotFromContent(memory?.content, ['metadata-parse-failed']);
    }
  }

  return parseSessionSnapshotFromContent(memory?.content, []);
}

function buildActiveSessionContent(session) {
  const categories = normalizeCategories(session.categories).join(', ') || 'workflow';
  const topics = Array.isArray(session.keywords) && session.keywords.length > 0 ? session.keywords.slice(0, 8).join(', ') : 'none';
  const latestPrompt = Array.isArray(session.prompts) && session.prompts.length > 0 ? session.prompts[session.prompts.length - 1] : 'none';
  const recallStatus = session.recall?.status || 'pending';
  const encodedSnapshot = Buffer.from(JSON.stringify(session)).toString('base64url');

  return [
    'MEMORY_RECORD',
    'CATEGORY=workflow',
    'CATEGORIES=workflow, hook-state',
    `SESSION_ID=${session.id}`,
    `PROMPT_COUNT=${session.promptCount || 0}`,
    `RECALL_STATUS=${recallStatus}`,
    `TOPICS=${topics}`,
    `LATEST_PROMPT=${latestPrompt}`,
    `SESSION_CATEGORIES=${categories}`,
    `SESSION_SNAPSHOT=${encodedSnapshot}`,
    'SUMMARY=Active memory-cycle session snapshot stored in metadata.session_snapshot.'
  ].join('\n');
}

function parseSessionSnapshotFromContent(content, previousFallbacks = []) {
  const text = String(content || '');
  const snapshotMatch = /^SESSION_SNAPSHOT=(.+)$/m.exec(text);
  const encodedSnapshot = snapshotMatch?.[1]?.trim();
  if (encodedSnapshot) {
    try {
      return {
        snapshot: JSON.parse(Buffer.from(encodedSnapshot, 'base64url').toString('utf8')),
        fallbacks: [...previousFallbacks, 'content-session-snapshot']
      };
    } catch {
      return null;
    }
  }

  try {
    return {
      snapshot: JSON.parse(text),
      fallbacks: [...previousFallbacks, 'legacy-json-content']
    };
  } catch {
    return null;
  }
}

function attachSessionLoadMeta(session, stateSource, stateFallbacks) {
  return {
    ...session,
    stateSource,
    stateFallbacks: Array.isArray(stateFallbacks) ? [...new Set(stateFallbacks.filter(Boolean))] : []
  };
}

function resolveRemoteStateSource(fallbacks) {
  const labels = Array.isArray(fallbacks) ? fallbacks : [];
  if (labels.includes('content-session-snapshot') || labels.includes('legacy-json-content')) {
    return 'content-fallback';
  }

  return 'remote-metadata';
}

function normalizeSessionCacheMaxAge(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15 * 60 * 1000;
}

function isExpiredSessionCache(client, session) {
  const updatedAt = new Date(session?.updatedAt || 0).getTime();
  if (updatedAt <= 0) {
    return true;
  }

  return Date.now() - updatedAt > client.sessionCacheMaxAgeMs;
}

module.exports = {
  clearActiveSessionSnapshots,
  clearLocalActiveSession,
  createRemoteClient,
  deleteActiveSessionSnapshot,
  listKnownMemories,
  loadActiveSession,
  remoteSearch,
  saveActiveSession,
  storeSessionSummary,
  storeStructuredMemory
};