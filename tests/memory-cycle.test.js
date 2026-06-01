const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const sourceScript = path.resolve(__dirname, '../scripts/memory-cycle.js');
const cliDependencies = [
  'mcp-memory-http-cli.js',
  'mcp-memory-http-client.js',
  'mcp-memory-http-commands.js',
  'mcp-memory-copilot-processor.js',
  'memory-cycle-core.js',
  'memory-cycle-domain.js',
  'memory-cycle-http.js'
];

test('SessionStart uses the memory HTTP service and returns cycle guidance', async () => {
  const fixture = createFixture();
  const remote = createRemoteMemoryState({
    memories: [
      createMemory({
        contentHash: 'known-1',
        content: 'MEMORY_RECORD\nCATEGORY=workflow\nSUMMARY=Known remote workflow memory',
        tags: ['memory', 'workflow']
      })
    ]
  });
  const server = await createMemoryServer(remote);
  const result = await runHook(fixture.scriptPath, { hookEventName: 'SessionStart' }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Memory cycle active for this profile\./);
  assert.match(result.stdout, /Categories: preference, project, workflow, technical-decision\./);

  const activeSessionMemory = remote.memories.find((memory) => memory.tags.includes('hook-state') && memory.tags.includes('active-session'));

  assert.equal(remote.requests.some((request) => request.method === 'GET' && request.url.startsWith('/api/memories')), true);
  assert.ok(activeSessionMemory);
  assert.match(activeSessionMemory.content, /^MEMORY_RECORD$/m);
  assert.equal(typeof activeSessionMemory.metadata?.session_snapshot, 'object');
  assert.equal(fs.existsSync(path.join(fixture.rootPath, 'session-state', 'memory-hook')), true);

  await closeServer(server);
  cleanupFixture(fixture.rootPath);
});

test('SessionStart can use the CLI .env fallback without inherited endpoint variables', async () => {
  const fixture = createFixture();
  const remote = createRemoteMemoryState();
  const server = await createMemoryServer(remote);
  const envFilePath = path.join(fixture.rootPath, '.env');

  fs.writeFileSync(envFilePath, [
    `export MCP_MEMORY_HTTP_ENDPOINT="${server.url}"`,
    'export MCP_MEMORY_API_KEY="local-test-token"'
  ].join('\n'), 'utf8');

  const result = await runHook(fixture.scriptPath, { hookEventName: 'SessionStart' }, {
    MCP_MEMORY_HTTP_ENV_FILE: envFilePath,
    MCP_MEMORY_HTTP_ENDPOINT: '',
    MCP_MEMORY_API_KEY: ''
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Memory cycle active for this profile\./);

  await closeServer(server);
  cleanupFixture(fixture.rootPath);
});

test('PreToolUse asks for confirmation when a sensitive tool runs before recall', async () => {
  const fixture = createFixture();
  const remote = createRemoteMemoryState();
  const server = await createMemoryServer(remote);

  await runHook(fixture.scriptPath, { hookEventName: 'SessionStart' }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  const result = await runHook(fixture.scriptPath, {
    hookEventName: 'PreToolUse',
    toolName: 'apply_patch',
    filePath: path.join(fixture.rootPath, 'example.js')
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(payload.systemMessage, /No recall ran in this session yet\./);

  await closeServer(server);
  cleanupFixture(fixture.rootPath);
});

test('supports snake_case hook payloads from the runtime', async () => {
  const fixture = createFixture();
  const remote = createRemoteMemoryState({
    searchResults: [
      createSearchResult({
        contentHash: 'match-1',
        content: 'MEMORY_RECORD\nCATEGORY=workflow\nSUMMARY=Matching remote memory',
        tags: ['workflow']
      })
    ]
  });
  const server = await createMemoryServer(remote);

  await runHook(fixture.scriptPath, { hook_event_name: 'SessionStart' }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  await runHook(fixture.scriptPath, {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'validacao real de payload snake case para memory hook'
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  const result = await runHook(fixture.scriptPath, {
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    file_path: path.join(fixture.rootPath, 'example.js')
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.continue, true);
  assert.match(payload.systemMessage, /Memory cycle check passed for sensitive tool apply_patch\./);

  await closeServer(server);
  cleanupFixture(fixture.rootPath);
});

test('uses runtime session_id to scope the active snapshot and tool history', async () => {
  const fixture = createFixture();
  const remote = createRemoteMemoryState();
  const server = await createMemoryServer(remote);
  const runtimeSessionId = 'runtime-session-123';

  await runHook(fixture.scriptPath, {
    hookEventName: 'SessionStart',
    session_id: runtimeSessionId
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  await runHook(fixture.scriptPath, {
    hookEventName: 'PostToolUse',
    session_id: runtimeSessionId,
    tool_name: 'memory',
    tool_input: '...'
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });

  const activeSessionMemory = remote.memories.find((memory) => memory.tags.includes('hook-state') && memory.tags.includes('active-session'));

  assert.ok(activeSessionMemory);
  assert.equal(activeSessionMemory.metadata?.session_id, runtimeSessionId);
  assert.equal(activeSessionMemory.metadata?.session_snapshot?.id, runtimeSessionId);
  assert.equal(activeSessionMemory.metadata?.session_snapshot?.tools?.at(-1)?.name, 'memory');

  await closeServer(server);
  cleanupFixture(fixture.rootPath);
});

test('extracts useful tool targets from stringified payloads for memory, apply_patch, and run_in_terminal', async () => {
  const fixture = createFixture();
  const remote = createRemoteMemoryState();
  const server = await createMemoryServer(remote);
  const runtimeSessionId = 'runtime-session-tool-targets';

  await runHook(fixture.scriptPath, {
    hookEventName: 'SessionStart',
    session_id: runtimeSessionId
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  await runHook(fixture.scriptPath, {
    hookEventName: 'PostToolUse',
    session_id: runtimeSessionId,
    tool_name: 'memory',
    tool_input: '{"path":"/memories/repo/copilot-cli-memory-guidance.md"}'
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  await runHook(fixture.scriptPath, {
    hookEventName: 'PostToolUse',
    session_id: runtimeSessionId,
    tool_name: 'apply_patch',
    tool_input: '*** Begin Patch\n*** Update File: /home/linkiez/.copilot/hooks/scripts/memory-cycle-http.js\n@@\n-foo\n+bar\n*** End Patch'
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  await runHook(fixture.scriptPath, {
    hookEventName: 'PostToolUse',
    session_id: runtimeSessionId,
    tool_name: 'run_in_terminal',
    tool_input: '{"command":"node --test hooks/tests/memory-cycle.test.js"}'
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });

  const activeSessionMemory = remote.memories.find((memory) => memory.tags.includes('hook-state') && memory.metadata?.session_id === runtimeSessionId);
  const recordedTools = activeSessionMemory.metadata?.session_snapshot?.tools || [];

  assert.equal(recordedTools[0]?.target, '/memories/repo/copilot-cli-memory-guidance.md');
  assert.equal(recordedTools[1]?.target, '/home/linkiez/.copilot/hooks/scripts/memory-cycle-http.js');
  assert.equal(recordedTools[2]?.target, 'node --test hooks/tests/memory-cycle.test.js');

  await closeServer(server);
  cleanupFixture(fixture.rootPath);
});

test('UserPromptSubmit ignores ephemeral precompact memories during recall', async () => {
  const fixture = createFixture();
  const remote = createRemoteMemoryState({
    searchResults: [
      createSearchResult({
        contentHash: 'precompact-1',
        content: 'MEMORY_RECORD\nSUMMARY=ephemeral precompact memory should not be recalled',
        tags: ['memory', 'hooks', 'session'],
        metadata: { source: 'precompact-hook', category: 'workflow' }
      }),
      createSearchResult({
        contentHash: 'workflow-1',
        content: 'MEMORY_RECORD\nSUMMARY=durable workflow memory should be recalled',
        tags: ['memory', 'workflow'],
        metadata: { source: 'stop-hook', category: 'workflow' }
      })
    ]
  });
  const server = await createMemoryServer(remote);

  await runHook(fixture.scriptPath, { hookEventName: 'SessionStart' }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  const result = await runHook(fixture.scriptPath, {
    hookEventName: 'UserPromptSubmit',
    prompt: 'workflow memory recall test'
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /ephemeral precompact memory should not be recalled/);
  assert.match(result.stdout, /durable workflow memory should be recalled/);

  await closeServer(server);
  cleanupFixture(fixture.rootPath);
});

test('Stop persists summaries and promoted memories through the memory HTTP service', async () => {
  const fixture = createFixture();
  const remote = createRemoteMemoryState();
  const server = await createMemoryServer(remote);

  await runHook(fixture.scriptPath, { hookEventName: 'SessionStart' }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  await runHook(fixture.scriptPath, {
    hookEventName: 'UserPromptSubmit',
    prompt: 'sempre prefira hooks no profile do vscode com memory_record, promocao automatica e heuristica de categorizacao para workflow e technical decision'
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  await runHook(fixture.scriptPath, {
    hookEventName: 'PostToolUse',
    toolName: 'apply_patch',
    filePath: fixture.scriptPath
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  await runHook(fixture.scriptPath, {
    hookEventName: 'SubagentStart',
    agentName: 'probe-subagent'
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  await runHook(fixture.scriptPath, {
    hookEventName: 'SubagentStop',
    agentName: 'probe-subagent'
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  const stopResult = await runHook(fixture.scriptPath, { hookEventName: 'Stop' }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });

  assert.equal(stopResult.status, 0);
  assert.match(stopResult.stdout, /Memory cycle persisted for this session\./);

  const promoted = remote.memories.filter((memory) => memory.metadata?.source === 'session-promotion');
  const promotedCategories = new Set(promoted.map((memory) => memory.metadata?.category));

  assert.ok(promotedCategories.has('preference'));
  assert.ok(promotedCategories.has('project'));
  assert.ok(promotedCategories.has('workflow'));
  assert.ok(promotedCategories.has('technical-decision'));
  assert.match(promoted[0].content, /^MEMORY_RECORD$/m);
  assert.match(promoted[0].content, /^DURABILITY=long-term$/m);
  assert.equal(remote.sessions.length, 1);
  assert.match(remote.sessions[0].metadata?.summary || '', /^TOOL_TARGETS=apply_patch:/m);
  assert.match(remote.sessions[0].metadata?.summary || '', /^SUBAGENTS=start:probe-subagent, stop:probe-subagent$/m);
  assert.match(remote.sessions[0].metadata?.focus || '', /tools=apply_patch:/);
  assert.match(remote.sessions[0].metadata?.focus || '', /subagents=start:probe-subagent, stop:probe-subagent/);

  await closeServer(server);
  cleanupFixture(fixture.rootPath);
});

test('Stop prefers the richest matching snapshot when stale duplicates still exist', async () => {
  const fixture = createFixture();
  const remote = createRemoteMemoryState({ preserveDeletedSnapshots: true, listOldestFirst: true });
  const server = await createMemoryServer(remote);
  const runtimeSessionId = 'runtime-session-richest';

  await runHook(fixture.scriptPath, {
    hookEventName: 'SessionStart',
    session_id: runtimeSessionId
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  await runHook(fixture.scriptPath, {
    hookEventName: 'UserPromptSubmit',
    session_id: runtimeSessionId,
    prompt: 'sempre preservar promptCount e tools no stop richest-snapshot-token'
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  await runHook(fixture.scriptPath, {
    hookEventName: 'PostToolUse',
    session_id: runtimeSessionId,
    tool_name: 'memory',
    tool_input: { path: '/memories/repo/copilot-cli-memory-guidance.md' }
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  const stopResult = await runHook(fixture.scriptPath, {
    hookEventName: 'Stop',
    session_id: runtimeSessionId
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });

  assert.equal(stopResult.status, 0);
  assert.match(stopResult.stdout, /Memory cycle persisted for this session\./);
  assert.equal(remote.sessions.length, 1);
  assert.equal(remote.sessions[0].metadata?.prompt_count, 1);
  assert.match(remote.sessions[0].metadata?.summary || '', /richest-snapshot-token/);
  assert.equal(remote.sessions[0].turns?.[0]?.role, 'user');
  assert.match(remote.sessions[0].turns?.[0]?.content || '', /richest-snapshot-token/);

  await closeServer(server);
  cleanupFixture(fixture.rootPath);
});

test('Stop persists the latest session state even when backend strips nested session snapshot metadata', async () => {
  const fixture = createFixture();
  const remote = createRemoteMemoryState({ stripSessionSnapshotMetadata: true });
  const server = await createMemoryServer(remote);
  const runtimeSessionId = 'runtime-session-content-fallback';

  await runHook(fixture.scriptPath, {
    hookEventName: 'SessionStart',
    session_id: runtimeSessionId
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  await runHook(fixture.scriptPath, {
    hookEventName: 'UserPromptSubmit',
    session_id: runtimeSessionId,
    prompt: 'sempre lembrar content-fallback-token para validar persistencia do stop'
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  await runHook(fixture.scriptPath, {
    hookEventName: 'PostToolUse',
    session_id: runtimeSessionId,
    tool_name: 'memory',
    tool_input: { path: '/memories/repo/copilot-cli-memory-guidance.md' }
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  fs.rmSync(path.join(fixture.dataDir, `${runtimeSessionId}.json`), { force: true });
  const stopResult = await runHook(fixture.scriptPath, {
    hookEventName: 'Stop',
    session_id: runtimeSessionId
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });

  assert.equal(stopResult.status, 0);
  assert.match(stopResult.stdout, /Memory cycle persisted for this session\./);
  assert.equal(remote.sessions.length, 1);
  assert.equal(remote.sessions[0].metadata?.prompt_count, 1);
  assert.match(remote.sessions[0].metadata?.summary || '', /content-fallback-token/);
  assert.equal(remote.sessions[0].metadata?.state_source, 'content-fallback');
  assert.equal(remote.sessions[0].turns?.[0]?.role, 'user');
  assert.match(remote.sessions[0].turns?.[0]?.content || '', /content-fallback-token/);

  await closeServer(server);
  cleanupFixture(fixture.rootPath);
});

test('Stop persists the latest session state when backend ignores duplicate active-session stores until old snapshot is removed', async () => {
  const fixture = createFixture();
  const remote = createRemoteMemoryState({ dedupeActiveSessionStores: true });
  const server = await createMemoryServer(remote);
  const runtimeSessionId = 'runtime-session-replace-before-store';

  await runHook(fixture.scriptPath, {
    hookEventName: 'SessionStart',
    session_id: runtimeSessionId
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  await runHook(fixture.scriptPath, {
    hookEventName: 'UserPromptSubmit',
    session_id: runtimeSessionId,
    prompt: 'sempre lembrar replace-before-store-token para validar snapshot atualizado'
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  await runHook(fixture.scriptPath, {
    hookEventName: 'PostToolUse',
    session_id: runtimeSessionId,
    tool_name: 'memory',
    tool_input: { path: '/memories/repo/copilot-cli-memory-guidance.md' }
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  const stopResult = await runHook(fixture.scriptPath, {
    hookEventName: 'Stop',
    session_id: runtimeSessionId
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });

  assert.equal(stopResult.status, 0);
  assert.match(stopResult.stdout, /Memory cycle persisted for this session\./);
  assert.equal(remote.sessions.length, 1);
  assert.equal(remote.sessions[0].metadata?.prompt_count, 1);
  assert.match(remote.sessions[0].metadata?.summary || '', /replace-before-store-token/);
  assert.match(remote.sessions[0].metadata?.focus || '', /tools=memory/);

  await closeServer(server);
  cleanupFixture(fixture.rootPath);
});

test('Hook keeps the latest session state when remote active-session reads are temporarily stale', async () => {
  const fixture = createFixture();
  const remote = createRemoteMemoryState({ hideActiveSessionsFromList: true });
  const server = await createMemoryServer(remote);
  const runtimeSessionId = 'runtime-session-local-cache';

  await runHook(fixture.scriptPath, {
    hookEventName: 'SessionStart',
    session_id: runtimeSessionId
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  const promptResult = await runHook(fixture.scriptPath, {
    hookEventName: 'UserPromptSubmit',
    session_id: runtimeSessionId,
    prompt: 'sempre lembrar local-cache-token para validar fallback local do hook'
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  const toolResult = await runHook(fixture.scriptPath, {
    hookEventName: 'PostToolUse',
    session_id: runtimeSessionId,
    tool_name: 'memory',
    tool_input: { path: '/memories/repo/copilot-cli-memory-guidance.md' }
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  const stopResult = await runHook(fixture.scriptPath, {
    hookEventName: 'Stop',
    session_id: runtimeSessionId
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });

  assert.match(promptResult.stdout, /Memory cycle reminder: no matching memory found\./);
  assert.match(toolResult.stdout, /Tool recorded for memory cycle: memory\./);
  assert.match(stopResult.stdout, /Memory cycle persisted for this session\./);
  assert.equal(remote.sessions.length, 1);
  assert.equal(remote.sessions[0].metadata?.prompt_count, 1);
  assert.match(remote.sessions[0].metadata?.summary || '', /local-cache-token/);
  assert.match(remote.sessions[0].metadata?.focus || '', /tools=memory/);
  assert.equal(remote.sessions[0].metadata?.state_source, 'local-cache');

  await closeServer(server);
  cleanupFixture(fixture.rootPath);
});

test('expired local cache is ignored in favor of fresher remote session state', async () => {
  const fixture = createFixture();
  const remote = createRemoteMemoryState();
  const server = await createMemoryServer(remote);
  const runtimeSessionId = 'runtime-session-expired-cache';
  const cacheFilePath = path.join(fixture.dataDir, `${runtimeSessionId}.json`);

  await runHook(fixture.scriptPath, {
    hookEventName: 'SessionStart',
    session_id: runtimeSessionId
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });
  await runHook(fixture.scriptPath, {
    hookEventName: 'UserPromptSubmit',
    session_id: runtimeSessionId,
    prompt: 'sempre lembrar expired-cache-token para validar expiracao do cache local'
  }, { MCP_MEMORY_HTTP_ENDPOINT: server.url });

  fs.writeFileSync(cacheFilePath, JSON.stringify({
    id: runtimeSessionId,
    updatedAt: '2020-01-01T00:00:00.000Z',
    promptCount: 0,
    prompts: [],
    keywords: [],
    categories: [],
    recall: { status: 'pending', matchedMemoryIds: [], lastRecallAt: '' },
    tools: [],
    subagents: []
  }), 'utf8');

  const stopResult = await runHook(fixture.scriptPath, {
    hookEventName: 'Stop',
    session_id: runtimeSessionId
  }, {
    MCP_MEMORY_HTTP_ENDPOINT: server.url,
    MEMORY_HOOK_SESSION_CACHE_MAX_AGE_MS: '1'
  });

  assert.match(stopResult.stdout, /Memory cycle persisted for this session\./);
  assert.equal(remote.sessions.length, 1);
  assert.equal(remote.sessions[0].metadata?.prompt_count, 1);
  assert.match(remote.sessions[0].metadata?.summary || '', /expired-cache-token/);
  assert.equal(remote.sessions[0].metadata?.state_source, 'remote-metadata');

  await closeServer(server);
  cleanupFixture(fixture.rootPath);
});

function createFixture() {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-cycle-test-'));
  const hooksRoot = path.join(rootPath, 'hooks');
  const scriptDir = path.join(hooksRoot, 'scripts');
  const dataDir = path.join(rootPath, 'session-state', 'memory-hook');
  const scriptPath = path.join(scriptDir, 'memory-cycle.js');

  fs.mkdirSync(scriptDir, { recursive: true });
  fs.copyFileSync(sourceScript, scriptPath);
  for (const fileName of cliDependencies) {
    fs.copyFileSync(path.resolve(__dirname, `../scripts/${fileName}`), path.join(scriptDir, fileName));
  }

  return { rootPath, scriptPath, dataDir };
}

function runHook(scriptPath, payload, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [scriptPath], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      resolve({
        status: typeof code === 'number' ? code : 0,
        stdout,
        stderr
      });
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function createRemoteMemoryState(overrides = {}) {
  return {
    nextId: 1,
    memories: overrides.memories ? [...overrides.memories] : [],
    sessions: [],
    requests: [],
    searchResults: overrides.searchResults ? [...overrides.searchResults] : [],
    preserveDeletedSnapshots: Boolean(overrides.preserveDeletedSnapshots),
    listOldestFirst: Boolean(overrides.listOldestFirst),
    stripSessionSnapshotMetadata: Boolean(overrides.stripSessionSnapshotMetadata),
    dedupeActiveSessionStores: Boolean(overrides.dedupeActiveSessionStores),
    hideActiveSessionsFromList: Boolean(overrides.hideActiveSessionsFromList)
  };
}

function createMemory(memory) {
  return {
    content: memory.content,
    content_hash: memory.contentHash,
    tags: memory.tags || [],
    memory_type: memory.memoryType || 'observation',
    metadata: memory.metadata || {},
    created_at: 1,
    created_at_iso: '2026-05-31T00:00:00.000Z',
    updated_at: 1,
    updated_at_iso: '2026-05-31T00:00:00.000Z'
  };
}

function createSearchResult(memory) {
  return {
    memory: createMemory(memory),
    similarity_score: 0.9
  };
}

function createMemoryServer(state) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const url = new URL(req.url, 'http://127.0.0.1');
        state.requests.push({ method: req.method, url: `${url.pathname}${url.search}`, body });
        handleMemoryRequest(state, req, res, url, body);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ instance: server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function handleMemoryRequest(state, request, response, url, body) {
  if (request.method === 'GET' && url.pathname === '/api/memories') {
    sendJson(response, 200, buildListResponse(state));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/memories') {
    sendJson(response, 200, buildStoreResponse(state, body));
    return;
  }

  if (request.method === 'DELETE' && url.pathname.startsWith('/api/memories/')) {
    sendJson(response, 200, buildDeleteResponse(state, url));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/search') {
    sendJson(response, 200, buildSearchResponse(state, body));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/sessions') {
    sendJson(response, 200, buildSessionResponse(state, body));
    return;
  }

  sendJson(response, 404, { message: `Unhandled route: ${request.method} ${url.pathname}` });
}

function buildListResponse(state) {
  const visibleMemories = state.hideActiveSessionsFromList
    ? state.memories.filter((memory) => !(Array.isArray(memory.tags) && memory.tags.includes('active-session')))
    : state.memories;
  const memories = state.listOldestFirst ? [...visibleMemories].reverse() : visibleMemories;
  return {
    memories,
    total: memories.length,
    page: 1,
    page_size: memories.length || 10,
    has_more: false
  };
}

function buildStoreResponse(state, body) {
  const payload = JSON.parse(body || '{}');
  if (state.dedupeActiveSessionStores && Array.isArray(payload.tags) && payload.tags.includes('active-session')) {
    const existingMemory = state.memories.find((memory) => Array.isArray(memory.tags) && memory.tags.includes('active-session') && payload.tags.some((tag) => String(tag).startsWith('hook-session:')) && payload.tags.some((tag) => memory.tags.includes(tag)));
    if (existingMemory) {
      return { success: true, message: 'stored', content_hash: existingMemory.content_hash, memory: existingMemory };
    }
  }

  const metadata = payload.metadata || {};
  if (state.stripSessionSnapshotMetadata) {
    delete metadata.session_snapshot;
  }
  const memory = createMemory({
    contentHash: `hash-${state.nextId++}`,
    content: payload.content,
    tags: payload.tags || [],
    memoryType: payload.memory_type || 'observation',
    metadata
  });
  state.memories.unshift(memory);
  return { success: true, message: 'stored', content_hash: memory.content_hash, memory };
}

function buildDeleteResponse(state, url) {
  const contentHash = decodeURIComponent(url.pathname.slice('/api/memories/'.length));
  if (!state.preserveDeletedSnapshots) {
    state.memories = state.memories.filter((memory) => memory.content_hash !== contentHash);
  }
  return { success: true, message: 'deleted', content_hash: contentHash };
}

function buildSearchResponse(state, body) {
  const payload = JSON.parse(body || '{}');
  const results = state.searchResults.length > 0 ? state.searchResults : state.memories.map(createDefaultSearchResult);
  return {
    results: payload.query ? results : [],
    total_found: payload.query ? results.length : 0,
    query: payload.query || '',
    search_type: 'semantic'
  };
}

function createDefaultSearchResult(memory) {
  return { memory, similarity_score: 0.8 };
}

function buildSessionResponse(state, body) {
  const payload = JSON.parse(body || '{}');
  state.sessions.push(payload);
  return {
    success: true,
    message: 'stored',
    session_id: payload.session_id || 'session-1',
    turn_count: payload.turns?.length || 0
  };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.instance.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function cleanupFixture(rootPath) {
  fs.rmSync(rootPath, { recursive: true, force: true });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}