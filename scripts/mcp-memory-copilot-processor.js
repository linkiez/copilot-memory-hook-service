const { execFile } = require('node:child_process');

const DEFAULT_COPILOT_INSTRUCTION = 'Normalize this memory for storage. Preserve facts, remove filler, and return only JSON with a top-level content string and optional metadata object.';
const DEFAULT_SEARCH_COPILOT_INSTRUCTION = 'Rewrite this memory search query for retrieval. Return only minified JSON with a top-level query string and optional semantic_query, quality_boost, and quality_weight fields.';
const DEFAULT_COPILOT_MODEL = 'GPT-5 mini';
const MEMORY_QUALITY_RULES = [
  'Treat the memory service as long-term context: optimize output so the user does not need to repeat themselves later.',
  'Keep memories specific, contextual, and actionable.',
  'Preserve exact facts such as commands, file paths, technologies, workflows, decisions, and rationale when they are present.',
  'Prefer metadata that improves retrieval, especially tags about preferences, workflows, architecture, testing, debugging, and deployment.',
  'Never invent facts, credentials, or missing context.'
];

const SEARCH_QUALITY_RULES = [
  'Optimize retrieval for prior solutions, user preferences, workflows, architecture decisions, and recent debugging context.',
  'Keep the rewritten query grounded in the user wording, but expand it with precise technical terms only when that improves recall.',
  'Use semantic_query only when it adds useful retrieval context without changing the intent.',
  'Never invent filters or entities that are not supported by the original query.'
];

async function preprocessMemoryText(input) {
  const model = resolveModel(input.model);
  const payload = {
    content: input.content,
    instruction: resolveInstruction(input.instruction, DEFAULT_COPILOT_INSTRUCTION, MEMORY_QUALITY_RULES),
    commandName: input.commandName || 'store',
    role: input.role || null,
    model
  };
  const runner = resolveRunner();
  const stdout = await runProcessor(runner, payload);
  const normalized = parseProcessorOutput(stdout);

  return {
    content: normalized.content,
    metadata: normalized.metadata,
    instruction: payload.instruction,
    processor: runner.label,
    model
  };
}

async function preprocessSearchQuery(input) {
  const model = resolveModel(input.model);
  const payload = {
    query: input.query,
    instruction: resolveInstruction(input.instruction, DEFAULT_SEARCH_COPILOT_INSTRUCTION, SEARCH_QUALITY_RULES),
    commandName: input.commandName || 'search',
    model
  };
  const runner = resolveRunner();
  const stdout = await runProcessor(runner, payload, buildSearchPrompt);
  const normalized = parseSearchOutput(stdout);

  return {
    query: normalized.query,
    semanticQuery: normalized.semanticQuery,
    qualityBoost: normalized.qualityBoost,
    qualityWeight: normalized.qualityWeight,
    instruction: payload.instruction,
    processor: runner.label,
    model
  };
}

function resolveRunner() {
  const customCommand = process.env.MCP_MEMORY_COPILOT_CLI_COMMAND;
  if (customCommand) {
    return {
      command: customCommand,
      args: parseCommandArgs(process.env.MCP_MEMORY_COPILOT_CLI_ARGS),
      mode: 'stdin-json',
      label: customCommand
    };
  }

  return {
    command: 'gh',
    args: ['copilot'],
    mode: 'prompt-arg',
    label: 'gh copilot'
  };
}

function resolveModel(value) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (typeof process.env.MCP_MEMORY_COPILOT_MODEL === 'string' && process.env.MCP_MEMORY_COPILOT_MODEL.trim()) {
    return process.env.MCP_MEMORY_COPILOT_MODEL.trim();
  }

  return DEFAULT_COPILOT_MODEL;
}

function resolveInstruction(value, fallbackInstruction, rules) {
  const baseInstruction = typeof value === 'string' && value.trim()
    ? value.trim()
    : fallbackInstruction;

  return [baseInstruction].concat(rules).join(' ');
}

function parseCommandArgs(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new TypeError('MCP_MEMORY_COPILOT_CLI_ARGS must be a JSON array');
    }

    return parsed.map(String);
  } catch (error) {
    throw new Error(`Invalid MCP_MEMORY_COPILOT_CLI_ARGS: ${error.message}`);
  }
}

async function runProcessor(runner, payload, promptBuilder = buildPrompt) {
  if (runner.mode === 'prompt-arg') {
    return execFileText(runner.command, [...runner.args, '--model', payload.model, '-p', promptBuilder(payload)]);
  }

  return execFileText(runner.command, runner.args, JSON.stringify(payload));
}

function buildPrompt(payload) {
  return [
    'Normalize the following memory before it is sent to a memory service.',
    'Preserve facts, remove filler, and return only minified JSON.',
    'Use exactly this schema: {"content":"string","metadata":{}}.',
    `Instruction: ${payload.instruction}`,
    payload.role ? `Role: ${payload.role}` : '',
    `Command: ${payload.commandName}`,
    `Content: ${payload.content}`
  ].filter(Boolean).join('\n');
}

function buildSearchPrompt(payload) {
  return [
    'Rewrite the following query for a semantic memory search.',
    'Return only minified JSON.',
    'Use this schema: {"query":"string","semantic_query":"string?","quality_boost":true|false,"quality_weight":number?}.',
    `Instruction: ${payload.instruction}`,
    `Command: ${payload.commandName}`,
    `Query: ${payload.query}`
  ].join('\n');
}

function execFileText(command, args, stdinText = '') {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }

      resolve(stdout);
    });

    if (!child.stdin) {
      return;
    }

    if (stdinText) {
      child.stdin.write(stdinText);
    }

    child.stdin.end();
  });
}

function parseProcessorOutput(stdout) {
  const text = stripCodeFence(String(stdout || '').trim());
  if (!text) {
    throw new Error('Copilot CLI returned an empty response.');
  }

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.content === 'string' && parsed.content.trim()) {
      return {
        content: parsed.content.trim(),
        metadata: isPlainObject(parsed.metadata) ? parsed.metadata : {}
      };
    }
  } catch {
    return { content: text, metadata: {} };
  }

  return { content: text, metadata: {} };
}

function parseSearchOutput(stdout) {
  const text = stripCodeFence(String(stdout || '').trim());
  if (!text) {
    throw new Error('Copilot CLI returned an empty search rewrite response.');
  }

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.query === 'string' && parsed.query.trim()) {
      return {
        query: parsed.query.trim(),
        semanticQuery: typeof parsed.semantic_query === 'string' && parsed.semantic_query.trim() ? parsed.semantic_query.trim() : undefined,
        qualityBoost: typeof parsed.quality_boost === 'boolean' ? parsed.quality_boost : undefined,
        qualityWeight: typeof parsed.quality_weight === 'number' ? parsed.quality_weight : undefined
      };
    }
  } catch {
    return { query: text };
  }

  return { query: text };
}

function stripCodeFence(value) {
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  DEFAULT_COPILOT_INSTRUCTION,
  DEFAULT_SEARCH_COPILOT_INSTRUCTION,
  DEFAULT_COPILOT_MODEL,
  preprocessMemoryText,
  preprocessSearchQuery
};