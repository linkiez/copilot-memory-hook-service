#!/usr/bin/env node
/* eslint-disable unicorn/prefer-top-level-await */
import fs from 'node:fs';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';

import { DEFAULT_TIMEOUT_MS, MemoryHttpClient } from './mcp-memory-http-client.js';
import { listCommands, runCommand } from './mcp-memory-http-commands.js';
import type { CliGlobalOptions, FallbackEnv, ParsedCli, RawCliArguments, StreamResponse } from './types.js';

const DEFAULT_ENV_FILE = `${os.homedir()}/.env`;
const HELP_TEXT = buildHelpText();

/**
 * Parses the CLI invocation into global options, a command name, and command arguments.
 *
 * @param argv - Raw CLI arguments excluding the Node executable and script name.
 * @returns Parsed CLI payload.
 */
function parseCli(argv: string[]): ParsedCli {
  if (argv.length === 0 || argv.includes('--help')) {
    return {
      arguments: {},
      command: '',
      options: { apiKey: '', endpoint: '', insecureTls: false, timeoutMs: DEFAULT_TIMEOUT_MS },
      showHelp: true
    };
  }

  const globalOptions: CliGlobalOptions = {
    apiKey: '',
    endpoint: '',
    insecureTls: false,
    timeoutMs: DEFAULT_TIMEOUT_MS
  };
  let index = 0;

  while (index < argv.length && argv[index]?.startsWith('--')) {
    const option = argv[index] ?? '';
    if (option === '--endpoint') {
      globalOptions.endpoint = readOptionValue(argv, index, option);
      index += 2;
      continue;
    }

    if (option === '--api-key') {
      globalOptions.apiKey = readOptionValue(argv, index, option);
      index += 2;
      continue;
    }

    if (option === '--timeout') {
      globalOptions.timeoutMs = Number.parseInt(readOptionValue(argv, index, option), 10);
      index += 2;
      continue;
    }

    if (option === '--insecure') {
      globalOptions.insecureTls = true;
      index += 1;
      continue;
    }

    throw new Error(`Unknown global option: ${option}`);
  }

  const command = argv[index];
  if (!command) {
    throw new Error('Missing command. Use --help for usage.');
  }

  return {
    arguments: parseNamedArguments(argv.slice(index + 1)),
    command,
    options: globalOptions,
    showHelp: false
  };
}

function parseNamedArguments(argv: string[]): RawCliArguments {
  const parsed: RawCliArguments = {};
  let index = 0;

  while (index < argv.length) {
    const key = argv[index] ?? '';
    if (!key.startsWith('--')) {
      throw new Error(`Unexpected argument: ${key}`);
    }

    const normalizedKey = camelCaseKey(key.slice(2));
    const nextValue = argv[index + 1];
    if (!nextValue || nextValue.startsWith('--')) {
      parsed[normalizedKey] = true;
      index += 1;
      continue;
    }

    parsed[normalizedKey] = nextValue;
    index += 2;
  }

  return parsed;
}

function readOptionValue(argv: string[], index: number, optionName: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${optionName}`);
  }

  return value;
}

function camelCaseKey(value: string): string {
  return value.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

/**
 * CLI entrypoint for the remote memory service bridge.
 *
 * @returns Process completion promise.
 */
export async function main(): Promise<void> {
  try {
    const cli = parseCli(process.argv.slice(2));
    if (cli.showHelp) {
      process.stdout.write(`${HELP_TEXT}\n`);
      return;
    }

    const fallbackEnv = loadFallbackEnv(process.env.MCP_MEMORY_HTTP_ENV_FILE ?? DEFAULT_ENV_FILE);
    const resolvedApiKey = cli.options.apiKey || process.env.MCP_MEMORY_API_KEY || fallbackEnv.MCP_MEMORY_API_KEY || '';
    const resolvedEndpoint = cli.options.endpoint || process.env.MCP_MEMORY_HTTP_ENDPOINT || fallbackEnv.MCP_MEMORY_HTTP_ENDPOINT || '';
    const client = new MemoryHttpClient({
      apiKey: resolvedApiKey,
      endpoint: resolvedEndpoint,
      insecureTls: cli.options.insecureTls,
      timeoutMs: cli.options.timeoutMs
    });

    if (client.endpoint.length === 0) {
      throw new Error('Missing memory service endpoint. Use --endpoint or MCP_MEMORY_HTTP_ENDPOINT.');
    }

    const result = await runCommand(client, cli.command, cli.arguments);
    if (isStreamResponse(result)) {
      await pipeline(result.stream, process.stdout);
      return;
    }

    if (typeof result === 'string') {
      process.stdout.write(`${result}\n`);
      return;
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown CLI error';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

function buildHelpText(): string {
  const commands = listCommands().join(', ');
  return `Usage:
  mcp-memory-http-cli --endpoint <url> <command> [options]

Global options:
  --endpoint <url>     HTTP service root or /api URL, or use MCP_MEMORY_HTTP_ENDPOINT
  --api-key <token>    Bearer token, or use MCP_MEMORY_API_KEY
  --timeout <ms>       Request timeout in milliseconds
  --insecure           Skip TLS certificate validation for HTTPS
  --help               Show this help message
                       Fallback env file: MCP_MEMORY_HTTP_ENV_FILE or ~/.env

Commands:
  ${commands}

Command options for text preprocessing:
  --copilot-preprocess          Run Copilot CLI before sending text payloads
  --copilot-instruction <text>  Override the Copilot normalization instruction
  --copilot-model <name>        Override the Copilot model, default: GPT-5 mini
`;
}

function loadFallbackEnv(filePath: string): FallbackEnv {
  if (filePath.length === 0 || !fs.existsSync(filePath)) {
    return {};
  }

  const output: FallbackEnv = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)\s*$/u.exec(line);
    if (!match) {
      continue;
    }

    const key = match[1] as keyof FallbackEnv;
    const rawValue = match[2] ?? '';
    if (key !== 'MCP_MEMORY_HTTP_ENDPOINT' && key !== 'MCP_MEMORY_API_KEY') {
      continue;
    }

    output[key] = unquoteEnvValue(rawValue);
  }

  return output;
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function isStreamResponse(value: unknown): value is StreamResponse {
  return value !== null
    && typeof value === 'object'
    && 'stream' in value
    && 'contentType' in value;
}

void main();