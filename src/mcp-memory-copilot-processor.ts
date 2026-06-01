import { execFile } from 'node:child_process';

import type { JsonObject } from './types.js';

/**
 * Default instruction used when normalizing durable memory content.
 */
export const DEFAULT_COPILOT_INSTRUCTION = 'Normalize this memory for storage. Preserve facts, remove filler, and return only JSON with a top-level content string and optional metadata object.';

/**
 * Default instruction used when rewriting search queries.
 */
export const DEFAULT_SEARCH_COPILOT_INSTRUCTION = 'Rewrite this memory search query for retrieval. Return only minified JSON with a top-level query string and optional semantic_query, quality_boost, and quality_weight fields.';

/**
 * Default Copilot model used by the preprocessing bridge.
 */
export const DEFAULT_COPILOT_MODEL = 'GPT-5 mini';

const MAX_BUFFER_BYTES = 1024 * 1024;
const MEMORY_QUALITY_RULES = [
  'Treat the memory service as long-term context: optimize output so the user does not need to repeat themselves later.',
  'Keep memories specific, contextual, and actionable.',
  'Preserve exact facts such as commands, file paths, technologies, workflows, decisions, and rationale when they are present.',
  'Prefer metadata that improves retrieval, especially tags about preferences, workflows, architecture, testing, debugging, and deployment.',
  'Never invent facts, credentials, or missing context.'
] as const;
const SEARCH_QUALITY_RULES = [
  'Optimize retrieval for prior solutions, user preferences, workflows, architecture decisions, and recent debugging context.',
  'Keep the rewritten query grounded in the user wording, but expand it with precise technical terms only when that improves recall.',
  'Use semantic_query only when it adds useful retrieval context without changing the intent.',
  'Never invent filters or entities that are not supported by the original query.'
] as const;

interface PreprocessMemoryInput {
  commandName?: string;
  content: string;
  instruction?: string;
  model?: string;
  role?: string | null;
}

interface PreprocessSearchInput {
  commandName?: string;
  instruction?: string;
  model?: string;
  query: string;
}

interface ProcessorRunner {
  args: string[];
  command: string;
  label: string;
  mode: 'prompt-arg' | 'stdin-json';
}

interface MemoryPromptPayload {
  commandName: string;
  content: string;
  instruction: string;
  model: string;
  role: string | null;
}

interface SearchPromptPayload {
  commandName: string;
  instruction: string;
  model: string;
  query: string;
}

interface ProcessedMemoryOutput {
  content: string;
  metadata: JsonObject;
}

interface ProcessedSearchOutput {
  qualityBoost?: boolean;
  qualityWeight?: number;
  query: string;
  semanticQuery?: string;
}

/**
 * Preprocesses memory text through Copilot CLI before it is sent to the service.
 *
 * @param input - Raw content and runtime options for the preprocessor.
 * @returns Normalized content, metadata, and execution metadata.
 */
export async function preprocessMemoryText(input: PreprocessMemoryInput): Promise<{
  content: string;
  instruction: string;
  metadata: JsonObject;
  model: string;
  processor: string;
}> {
  const model = resolveModel(input.model);
  const payload: MemoryPromptPayload = {
    commandName: input.commandName ?? 'store',
    content: input.content,
    instruction: resolveInstruction(input.instruction, DEFAULT_COPILOT_INSTRUCTION, MEMORY_QUALITY_RULES),
    model,
    role: input.role ?? null
  };
  const runner = resolveRunner();
  const stdout = await runProcessor(runner, payload, buildPrompt);
  const normalized = parseProcessorOutput(stdout);

  return {
    content: normalized.content,
    instruction: payload.instruction,
    metadata: normalized.metadata,
    model,
    processor: runner.label
  };
}

/**
 * Rewrites a search query through Copilot CLI before retrieval.
 *
 * @param input - Raw search query and runtime options.
 * @returns Rewritten semantic query payload.
 */
export async function preprocessSearchQuery(input: PreprocessSearchInput): Promise<{
  instruction: string;
  model: string;
  processor: string;
  qualityBoost?: boolean;
  qualityWeight?: number;
  query: string;
  semanticQuery?: string;
}> {
  const model = resolveModel(input.model);
  const payload: SearchPromptPayload = {
    commandName: input.commandName ?? 'search',
    instruction: resolveInstruction(input.instruction, DEFAULT_SEARCH_COPILOT_INSTRUCTION, SEARCH_QUALITY_RULES),
    model,
    query: input.query
  };
  const runner = resolveRunner();
  const stdout = await runProcessor(runner, payload, buildSearchPrompt);
  const normalized = parseSearchOutput(stdout);

  return {
    instruction: payload.instruction,
    model,
    processor: runner.label,
    query: normalized.query,
    ...(normalized.qualityBoost === undefined ? {} : { qualityBoost: normalized.qualityBoost }),
    ...(normalized.qualityWeight === undefined ? {} : { qualityWeight: normalized.qualityWeight }),
    ...(normalized.semanticQuery === undefined ? {} : { semanticQuery: normalized.semanticQuery })
  };
}

function resolveRunner(): ProcessorRunner {
  const customCommand = process.env.MCP_MEMORY_COPILOT_CLI_COMMAND;
  if (typeof customCommand === 'string' && customCommand.trim().length > 0) {
    return {
      args: parseCommandArgs(process.env.MCP_MEMORY_COPILOT_CLI_ARGS),
      command: customCommand,
      label: customCommand,
      mode: 'stdin-json'
    };
  }

  return {
    args: ['copilot'],
    command: 'gh',
    label: 'gh copilot',
    mode: 'prompt-arg'
  };
}

function resolveModel(value?: string): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  const environmentModel = process.env.MCP_MEMORY_COPILOT_MODEL;
  if (typeof environmentModel === 'string' && environmentModel.trim().length > 0) {
    return environmentModel.trim();
  }

  return DEFAULT_COPILOT_MODEL;
}

function resolveInstruction(value: string | undefined, fallbackInstruction: string, rules: readonly string[]): string {
  const baseInstruction = typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : fallbackInstruction;

  return [baseInstruction, ...rules].join(' ');
}

function parseCommandArgs(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      throw new TypeError('MCP_MEMORY_COPILOT_CLI_ARGS must be a JSON array');
    }

    return parsed.map(String);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown argument parsing error';
    throw new Error(`Invalid MCP_MEMORY_COPILOT_CLI_ARGS: ${message}`);
  }
}

async function runProcessor(
  runner: ProcessorRunner,
  payload: MemoryPromptPayload | SearchPromptPayload,
  promptBuilder: (payload: MemoryPromptPayload | SearchPromptPayload) => string
): Promise<string> {
  if (runner.mode === 'prompt-arg') {
    return execFileText(runner.command, [...runner.args, '--model', payload.model, '-p', promptBuilder(payload)]);
  }

  return execFileText(runner.command, runner.args, JSON.stringify(payload));
}

function buildPrompt(payload: MemoryPromptPayload | SearchPromptPayload): string {
  if (!('content' in payload)) {
    throw new TypeError('Expected a memory prompt payload.');
  }

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

function buildSearchPrompt(payload: MemoryPromptPayload | SearchPromptPayload): string {
  if (!('query' in payload)) {
    throw new TypeError('Expected a search prompt payload.');
  }

  return [
    'Rewrite the following query for a semantic memory search.',
    'Return only minified JSON.',
    'Use this schema: {"query":"string","semantic_query":"string?","quality_boost":true|false,"quality_weight":number?}.',
    `Instruction: ${payload.instruction}`,
    `Command: ${payload.commandName}`,
    `Query: ${payload.query}`
  ].join('\n');
}

function execFileText(command: string, args: string[], stdinText = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { encoding: 'utf8', maxBuffer: MAX_BUFFER_BYTES }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }

      resolve(stdout);
    });

    if (!child.stdin) {
      return;
    }

    if (stdinText.length > 0) {
      child.stdin.write(stdinText);
    }

    child.stdin.end();
  });
}

function parseProcessorOutput(stdout: string): ProcessedMemoryOutput {
  const text = stripCodeFence(stdout.trim());
  if (text.length === 0) {
    throw new Error('Copilot CLI returned an empty response.');
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (isJsonObject(parsed) && typeof parsed.content === 'string' && parsed.content.trim().length > 0) {
      return {
        content: parsed.content.trim(),
        metadata: isJsonObject(parsed.metadata) ? parsed.metadata : {}
      };
    }
  } catch {
    return { content: text, metadata: {} };
  }

  return { content: text, metadata: {} };
}

function parseSearchOutput(stdout: string): ProcessedSearchOutput {
  const text = stripCodeFence(stdout.trim());
  if (text.length === 0) {
    throw new Error('Copilot CLI returned an empty search rewrite response.');
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (isJsonObject(parsed) && typeof parsed.query === 'string' && parsed.query.trim().length > 0) {
      return {
        query: parsed.query.trim(),
        ...(typeof parsed.quality_boost === 'boolean' ? { qualityBoost: parsed.quality_boost } : {}),
        ...(typeof parsed.quality_weight === 'number' ? { qualityWeight: parsed.quality_weight } : {}),
        ...(typeof parsed.semantic_query === 'string' && parsed.semantic_query.trim().length > 0
          ? { semanticQuery: parsed.semantic_query.trim() }
          : {})
      };
    }
  } catch {
    return { query: text };
  }

  return { query: text };
}

function stripCodeFence(value: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value);
  return match?.[1]?.trim() ?? value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}