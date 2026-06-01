const crypto = require('node:crypto');

const {
  buildNarrativeSummary,
  buildRecallReminder,
  buildSummary,
  categorizeText,
  categorizeTool,
  compressText,
  createSessionTurns,
  extractPrompt,
  extractSubagentName,
  extractTool,
  formatMemories,
  getEventName,
  getRecallGap,
  isSensitiveTool,
  logDebug,
  memoryCategories,
  normalizeCategories,
  pickPrimaryCategory,
  promoteSessionMemories,
  tokenize,
  unique
} = require('./memory-cycle-domain');
const {
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
} = require('./memory-cycle-http');

async function main() {
  try {
    const payload = parseJson(await readStdin());
    const eventName = getEventName(payload);
    const client = createRemoteClient(__dirname, process.env);

    logDebug('hook-received', {
      eventName,
      payloadKeys: Object.keys(payload).slice(0, 20)
    });

    switch (eventName) {
      case 'SessionStart':
        await handleSessionStart(client, payload);
        return;
      case 'UserPromptSubmit':
        await handleUserPromptSubmit(client, payload);
        return;
      case 'PreToolUse':
        await handlePreToolUse(client, payload);
        return;
      case 'PostToolUse':
        await handlePostToolUse(client, payload);
        return;
      case 'PreCompact':
        await handleCheckpoint(client, payload, false);
        return;
      case 'SubagentStart':
        await handleSubagentEvent(client, 'start', payload);
        return;
      case 'SubagentStop':
        await handleSubagentEvent(client, 'stop', payload);
        return;
      case 'Stop':
        await handleCheckpoint(client, payload, true);
        return;
      default:
        logDebug('hook-ignored', { eventName });
        respond();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected hook error';
    logDebug('hook-error', {
      messageHash: hashValue(message),
      messageLen: String(message).length
    });
    process.stdout.write(JSON.stringify({ continue: true, systemMessage: `Memory hook warning: ${message}` }));
    process.exit(0);
  }
}

async function handleSessionStart(client, payload) {
  const runtimeSessionId = extractSessionId(payload);
  clearActiveSessionSnapshots(client, runtimeSessionId);

  const session = {
    id: runtimeSessionId || crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    promptCount: 0,
    prompts: [],
    keywords: [],
    categories: [],
    recall: {
      status: 'pending',
      matchedMemoryIds: [],
      lastRecallAt: ''
    },
    tools: [],
    subagents: []
  };

  await saveActiveSession(client, session);
  const memories = (await listKnownMemories(client)).slice(0, 4);
  const lines = [
    'Memory cycle active for this profile.',
    'Order: recall relevant context, apply during execution, store durable outcomes, update stale entries.',
    `Categories: ${memoryCategories.join(', ')}.`
  ];

  if (memories.length > 0) {
    lines.push(`Known memories: ${formatMemories(memories)}`);
  }

  respond(lines.join(' '));
}

async function handleUserPromptSubmit(client, payload) {
  const prompt = extractPrompt(payload);
  const session = await loadActiveSession(client, extractSessionId(payload));

  if (!session || !prompt) {
    respond();
    return;
  }

  session.promptCount += 1;
  session.updatedAt = new Date().toISOString();
  session.keywords = unique([...session.keywords, ...tokenize(prompt)]).slice(0, 20);
  session.categories = unique([...session.categories, ...categorizeText(prompt)]);
  session.prompts = [...session.prompts, compressText(prompt, 220)].slice(-6);

  const matches = await remoteSearch(client, prompt);
  session.recall = {
    status: matches.length > 0 ? 'matched' : 'missing',
    matchedMemoryIds: matches.map((memory) => memory.content_hash),
    lastRecallAt: new Date().toISOString()
  };
  await saveActiveSession(client, session);

  if (matches.length === 0) {
    respond(buildRecallReminder(session));
    return;
  }

  respond(`Relevant memories: ${formatMemories(matches)}. Summary format locked to MEMORY_RECORD fields for searchable persistence.`);
}

async function handlePreToolUse(client, payload) {
  const session = await loadActiveSession(client, extractSessionId(payload));
  const tool = extractTool(payload);
  if (!session || !tool.name) {
    respond();
    return;
  }

  if (!isSensitiveTool(tool)) {
    respond(`Memory cycle check: ${tool.name} is not classified as a sensitive edit.`);
    return;
  }

  const recallReason = getRecallGap(session);
  if (!recallReason) {
    respond(`Memory cycle check passed for sensitive tool ${tool.name}.`);
    return;
  }

  process.stdout.write(JSON.stringify({
    continue: true,
    systemMessage: `Memory cycle gate: ${recallReason} Review prior preference, project, workflow, or technical-decision context before using ${tool.name}.`,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: `Sensitive tool ${tool.name} requires fresh memory recall.`
    }
  }));
}

async function handlePostToolUse(client, payload) {
  const session = await loadActiveSession(client, extractSessionId(payload));
  const tool = extractTool(payload);
  if (!session || !tool.name) {
    respond();
    return;
  }

  session.updatedAt = new Date().toISOString();
  session.tools = [
    ...session.tools,
    {
      name: tool.name,
      target: compressText(tool.target, 80),
      sensitive: isSensitiveTool(tool),
      recordedAt: session.updatedAt
    }
  ].slice(-12);
  session.categories = unique([...session.categories, ...categorizeTool(tool.name, tool.target)]);
  await saveActiveSession(client, session);
  respond(`Tool recorded for memory cycle: ${tool.name}.`);
}

async function handleSubagentEvent(client, kind, payload) {
  const session = await loadActiveSession(client, extractSessionId(payload));
  if (!session) {
    respond();
    return;
  }

  session.updatedAt = new Date().toISOString();
  session.subagents = [
    ...session.subagents,
    {
      kind,
      name: extractSubagentName(payload),
      recordedAt: session.updatedAt
    }
  ].slice(-12);
  await saveActiveSession(client, session);
  respond(`Subagent ${kind} recorded for memory cycle: ${session.subagents[session.subagents.length - 1].name}.`);
}

async function handleCheckpoint(client, payload, finalize) {
  const session = await loadActiveSession(client, extractSessionId(payload));
  if (!session) {
    respond();
    return;
  }

  logDebug('checkpoint-session-loaded', {
    finalize,
    sessionId: session.id,
    promptCount: session.promptCount,
    promptEntries: Array.isArray(session.prompts) ? session.prompts.length : 0,
    toolEntries: Array.isArray(session.tools) ? session.tools.length : 0,
    subagentEntries: Array.isArray(session.subagents) ? session.subagents.length : 0
  });

  const summary = buildSummary(session);
  const categories = session.categories.length > 0 ? session.categories : ['workflow'];

  if (summary) {
    await storeStructuredMemory(client, {
      content: summary,
      tags: unique(['memory', 'hooks', 'session', ...categories, ...session.keywords]).slice(0, 12),
      metadata: {
        source: finalize ? 'stop-hook' : 'precompact-hook',
        category: pickPrimaryCategory(categories),
        categories,
        session_id: session.id,
        kind: 'session-summary'
      }
    });
  }

  if (finalize) {
    const promoted = promoteSessionMemories(session, summary, session.updatedAt);
    for (const durableMemory of promoted) {
      await storeStructuredMemory(client, {
        content: durableMemory.text,
        tags: durableMemory.tags,
        metadata: {
          source: durableMemory.source,
          category: durableMemory.category,
          categories: durableMemory.categories,
          session_id: session.id,
          memory_id: durableMemory.id
        }
      });
    }

    await storeSessionSummary(client, {
      sessionId: session.id,
      tags: unique(['memory-cycle', ...normalizeCategories(categories)]),
      metadata: {
        source: 'memory-hook',
        summary,
        prompt_count: session.promptCount,
        focus: buildNarrativeSummary(session),
        state_source: session.stateSource || 'unknown',
        state_fallbacks: Array.isArray(session.stateFallbacks) ? session.stateFallbacks : []
      },
      turns: createSessionTurns(session)
    });

    deleteActiveSessionSnapshot(client, session.remoteHash);
    clearLocalActiveSession(client, session.id);
    respond('Memory cycle persisted for this session.');
    return;
  }

  session.updatedAt = new Date().toISOString();
  await saveActiveSession(client, session);
  respond('Memory checkpoint updated before compaction.');
}

function parseJson(content) {
  try {
    return JSON.parse(content || '{}');
  } catch {
    return {};
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let content = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      content += chunk;
    });
    process.stdin.on('end', () => resolve(content));
    process.stdin.on('error', () => resolve(''));
  });
}

function respond(systemMessage) {
  const payload = { continue: true };
  if (systemMessage) {
    payload.systemMessage = systemMessage;
  }
  process.stdout.write(JSON.stringify(payload));
}

function hashValue(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}

function extractSessionId(payload) {
  const candidates = [
    payload?.sessionId,
    payload?.session_id,
    payload?.data?.sessionId,
    payload?.data?.session_id
  ];

  const sessionId = candidates.find((value) => typeof value === 'string' && value.trim().length > 0);
  return sessionId ? sessionId.trim() : '';
}

module.exports = {
  main
};