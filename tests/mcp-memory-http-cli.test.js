const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const cliPath = path.resolve(__dirname, '../scripts/mcp-memory-http-cli.js');

test('health command checks the remote memory service', async () => {
  const server = await createServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/api/health');

    sendJson(res, 200, {
      status: 'ok',
      storage_type: 'sqlite',
      statistics: { memories: 3 }
    });
  });

  const result = await runCli(server.url, ['health']);
  await closeServer(server);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'ok',
    backend: 'sqlite',
    statistics: { memories: 3 }
  });
});

test('health command can load endpoint and api key from a .env fallback file', async () => {
  const server = await createServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/api/health');
    assert.equal(req.headers.authorization, 'Bearer local-test-token');

    sendJson(res, 200, { status: 'ok' });
  });
  const envFile = createEnvFile([
    `export MCP_MEMORY_HTTP_ENDPOINT="${server.url}"`,
    'export MCP_MEMORY_API_KEY="local-test-token"'
  ]);

  const result = await runCli('', ['health'], {
    MCP_MEMORY_HTTP_ENV_FILE: envFile
  });

  fs.rmSync(envFile, { force: true });
  await closeServer(server);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'ok' });
});

test('store command posts content and metadata to the remote memory service', async () => {
  const requests = [];
  const server = await createServer((req, res, body) => {
    requests.push({ method: req.method, url: req.url, body: JSON.parse(body) });
    sendJson(res, 201, { success: true, message: 'stored' });
  });

  const result = await runCli(server.url, [
    'store',
    '--content',
    'memory text',
    '--tags',
    'hook,workflow',
    '--type',
    'note',
    '--metadata',
    '{"source":"hook"}'
  ]);
  await closeServer(server);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    method: 'POST',
    url: '/api/memories',
    body: {
      content: 'memory text',
      tags: ['hook', 'workflow'],
      memory_type: 'note',
      metadata: {
        source: 'hook'
      }
    }
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    success: true,
    message: 'stored'
  });
});

test('store command can preprocess content with Copilot CLI before sending', async () => {
  const requests = [];
  const server = await createServer((req, res, body) => {
    requests.push({ method: req.method, url: req.url, body: JSON.parse(body) });
    sendJson(res, 201, { success: true, message: 'stored' });
  });

  const result = await runCli(server.url, [
    'store',
    '--content',
    'raw memory text',
    '--tags',
    'hook,workflow',
    '--copilot-preprocess',
    '--copilot-instruction',
    'Normalize this memory',
    '--copilot-model',
    'GPT-5 mini'
  ], {
    MCP_MEMORY_COPILOT_CLI_COMMAND: 'node',
    MCP_MEMORY_COPILOT_CLI_ARGS: JSON.stringify([
      path.join(__dirname, 'fixtures-copilot-preprocessor.js')
    ])
  });
  await closeServer(server);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, '/api/memories');
  assert.equal(requests[0].body.content, 'treated::raw memory text');
  assert.deepEqual(requests[0].body.tags, ['hook', 'workflow']);
  assert.equal(requests[0].body.metadata.copilot.processor, 'node');
  assert.equal(requests[0].body.metadata.copilot.model, 'GPT-5 mini');
  assert.match(requests[0].body.metadata.copilot.instruction, /Normalize this memory/);
  assert.match(requests[0].body.metadata.copilot.instruction, /Keep memories specific, contextual, and actionable\./);
});

test('store command default Copilot prompt carries memory quality guidance', async () => {
  const requests = [];
  const server = await createServer((req, res, body) => {
    requests.push({ method: req.method, url: req.url, body: JSON.parse(body) });
    sendJson(res, 201, { success: true, message: 'stored' });
  });

  const result = await runCli(server.url, [
    'store',
    '--content',
    'project decision about hook architecture',
    '--copilot-preprocess'
  ], {
    MCP_MEMORY_COPILOT_CLI_COMMAND: 'node',
    MCP_MEMORY_COPILOT_CLI_ARGS: JSON.stringify([
      path.join(__dirname, 'fixtures-copilot-preprocessor.js')
    ])
  });
  await closeServer(server);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  assert.match(
    requests[0].body.metadata.copilot.instruction,
    /Keep memories specific, contextual, and actionable\./
  );
  assert.match(
    requests[0].body.metadata.copilot.instruction,
    /Prefer metadata that improves retrieval/
  );
  assert.match(result.stdout, /stored/);
});

test('session-store can preprocess turn messages with Copilot CLI before sending', async () => {
  const requests = [];
  const server = await createServer((req, res, body) => {
    requests.push({ method: req.method, url: req.url, body: JSON.parse(body) });
    sendJson(res, 201, { success: true, session_id: 'session-1' });
  });

  const result = await runCli(server.url, [
    'session-store',
    '--turns',
    '[{"role":"user","content":"primeira mensagem"},{"role":"assistant","content":"segunda mensagem"}]',
    '--copilot-preprocess',
    '--copilot-instruction',
    'Normalize these messages',
    '--copilot-model',
    'GPT-5 mini'
  ], {
    MCP_MEMORY_COPILOT_CLI_COMMAND: 'node',
    MCP_MEMORY_COPILOT_CLI_ARGS: JSON.stringify([
      path.join(__dirname, 'fixtures-copilot-preprocessor.js')
    ])
  });
  await closeServer(server);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    method: 'POST',
    url: '/api/sessions',
    body: {
      turns: [
        { role: 'user', content: 'treated::primeira mensagem' },
        { role: 'assistant', content: 'treated::segunda mensagem' }
      ],
      metadata: {
        copilot: {
          instruction: 'Normalize these messages',
          processor: 'node',
          model: 'GPT-5 mini',
          treated_turns: 2
        }
      }
    }
  });
});

test('search command can rewrite the query with Copilot CLI for more relevant retrieval', async () => {
  const requests = [];
  const server = await createServer((req, res, body) => {
    requests.push({ method: req.method, url: req.url, body: JSON.parse(body) });
    sendJson(res, 200, {
      results: [],
      total_found: 0,
      query: 'normalized semantic query',
      search_type: 'semantic'
    });
  });

  const result = await runCli(server.url, [
    'search',
    '--query',
    'busca baguncada sobre hook e memoria',
    '--copilot-preprocess',
    '--copilot-instruction',
    'Rewrite this search query for better memory retrieval',
    '--copilot-model',
    'GPT-5 mini'
  ], {
    MCP_MEMORY_COPILOT_CLI_COMMAND: 'node',
    MCP_MEMORY_COPILOT_CLI_ARGS: JSON.stringify([
      path.join(__dirname, 'fixtures-copilot-query-preprocessor.js')
    ])
  });
  await closeServer(server);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    method: 'POST',
    url: '/api/search',
    body: {
      query: 'normalized semantic query',
      n_results: 10,
      quality_boost: true,
      quality_weight: 0.45
    }
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    results: [],
    total_found: 0,
    query: 'normalized semantic query',
    search_type: 'semantic'
  });
});

test('call command maps MCP tool names to direct HTTP endpoints', async () => {
  const requests = [];
  const server = await createServer((req, res, body) => {
    requests.push({ method: req.method, url: req.url, body: JSON.parse(body) });
    sendJson(res, 200, {
      results: [
        {
          memory: {
            content: 'saved memory',
            tags: ['workflow'],
            memory_type: 'note',
            created_at_iso: '2026-05-31T12:00:00.000Z'
          },
          relevance_score: 0.91
        }
      ]
    });
  });

  const result = await runCli(server.url, [
    'call',
    '--tool',
    'search_by_tag',
    '--arguments',
    '{"tags":["workflow"],"match_all":true}'
  ]);
  await closeServer(server);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(requests[0], {
    method: 'POST',
    url: '/api/search/by-tag',
    body: {
      tags: ['workflow'],
      match_all: true,
      time_filter: null
    }
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    memories: [
      {
        content: 'saved memory',
        metadata: {
          tags: ['workflow'],
          type: 'note',
          created_at: '2026-05-31T12:00:00.000Z',
          relevance_score: 0.91
        }
      }
    ]
  });
});

test('list command sends pagination and filter query parameters', async () => {
  const requests = [];
  const server = await createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    sendJson(res, 200, {
      memories: [],
      total: 0,
      page: 2,
      page_size: 5,
      has_more: false
    });
  });

  const result = await runCli(server.url, [
    'list',
    '--page',
    '2',
    '--page-size',
    '5',
    '--tag',
    'workflow',
    '--memory-type',
    'decision',
    '--tag-match',
    'all'
  ]);
  await closeServer(server);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(requests[0], {
    method: 'GET',
    url: '/api/memories?page=2&page_size=5&tag=workflow&memory_type=decision&tag_match=all'
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    memories: [],
    total: 0,
    page: 2,
    page_size: 5,
    has_more: false
  });
});

test('update command sends partial memory metadata updates', async () => {
  const requests = [];
  const server = await createServer((req, res, body) => {
    requests.push({ method: req.method, url: req.url, body: JSON.parse(body) });
    sendJson(res, 200, {
      success: true,
      message: 'updated',
      content_hash: 'abc123',
      memory: null
    });
  });

  const result = await runCli(server.url, [
    'update',
    '--hash',
    'abc123',
    '--tags',
    'workflow,decision',
    '--memory-type',
    'decision',
    '--metadata',
    '{"source":"cli"}'
  ]);
  await closeServer(server);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(requests[0], {
    method: 'PUT',
    url: '/api/memories/abc123',
    body: {
      tags: ['workflow', 'decision'],
      memory_type: 'decision',
      metadata: {
        source: 'cli'
      }
    }
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    success: true,
    message: 'updated',
    content_hash: 'abc123',
    memory: null
  });
});

test('documents-upload sends multipart form data with file and options', async () => {
  const requests = [];
  const fixtureFile = path.join(__dirname, 'fixtures-memory-upload.txt');
  const server = await createServer((req, res, body) => {
    requests.push({
      method: req.method,
      url: req.url,
      contentType: req.headers['content-type'],
      body
    });
    sendJson(res, 200, {
      upload_id: 'upload-1',
      status: 'queued'
    });
  });

  const result = await runCli(server.url, [
    'documents-upload',
    '--file',
    fixtureFile,
    '--tags',
    'docs,cli',
    '--chunk-size',
    '256',
    '--chunk-overlap',
    '32',
    '--memory-type',
    'document'
  ]);
  await closeServer(server);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, '/api/documents/upload');
  assert.match(requests[0].contentType, /^multipart\/form-data; boundary=/);
  assert.match(requests[0].body, /name="tags"/);
  assert.match(requests[0].body, /docs,cli/);
  assert.match(requests[0].body, /name="chunk_size"/);
  assert.match(requests[0].body, /256/);
  assert.match(requests[0].body, /name="file"; filename="fixtures-memory-upload.txt"/);
  assert.match(requests[0].body, /fixture upload content/);
  assert.deepEqual(JSON.parse(result.stdout), {
    upload_id: 'upload-1',
    status: 'queued'
  });
});

test('mcp-call sends a JSON-RPC payload to the MCP endpoint', async () => {
  const requests = [];
  const server = await createServer((req, res, body) => {
    requests.push({ method: req.method, url: req.url, body: JSON.parse(body) });
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: '1',
      result: { ok: true }
    });
  });

  const result = await runCli(server.url, [
    'mcp-call',
    '--method',
    'tools/list',
    '--id',
    '1',
    '--params',
    '{"scope":"all"}'
  ]);
  await closeServer(server);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(requests[0], {
    method: 'POST',
    url: '/mcp',
    body: {
      jsonrpc: '2.0',
      id: '1',
      method: 'tools/list',
      params: { scope: 'all' }
    }
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    jsonrpc: '2.0',
    id: '1',
    result: { ok: true }
  });
});

function runCli(endpoint, args, env = {}) {
  return new Promise((resolve) => {
    const commandArgs = endpoint ? [cliPath, '--endpoint', endpoint, ...args] : [cliPath, ...args];
    execFile('node', commandArgs, { encoding: 'utf8', env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve({
        status: error && typeof error.code === 'number' ? error.code : 0,
        stdout,
        stderr
      });
    });
  });
}

function createEnvFile(lines) {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-http-env-')), '.env');
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

function createServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        handler(req, res, body);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        instance: server,
        url: `http://127.0.0.1:${address.port}`
      });
    });
  });
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

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}