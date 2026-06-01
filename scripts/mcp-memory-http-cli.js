#!/usr/bin/env node
/* eslint-disable unicorn/prefer-top-level-await */

const fs = require('node:fs');
const os = require('node:os');
const { pipeline } = require('node:stream/promises');

const { DEFAULT_TIMEOUT_MS, MemoryHttpClient } = require('./mcp-memory-http-client');
const { listCommands, runCommand } = require('./mcp-memory-http-commands');

const DEFAULT_ENV_FILE = `${os.homedir()}/.env`;
const HELP_TEXT = buildHelpText();

function parseCli(argv) {
  if (argv.length === 0 || argv.includes('--help')) {
    return { showHelp: true, options: {}, command: '', arguments: {} };
  }

  const globalOptions = {
    endpoint: '',
    apiKey: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    insecureTls: false
  };
  let index = 0;

  while (index < argv.length && argv[index].startsWith('--')) {
    const option = argv[index];
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

  const commandArguments = argv.slice(index + 1);
  return {
    showHelp: false,
    options: globalOptions,
    command,
    arguments: parseCommandArguments(command, commandArguments)
  };
}

function parseCommandArguments(command, argv) {
  return parseNamedArguments(argv);
}

function parseNamedArguments(argv) {
  const parsed = {};
  let index = 0;

  while (index < argv.length) {
    const key = argv[index];
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

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${optionName}`);
  }

  return value;
}

function camelCaseKey(value) {
  return value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

async function main() {
  try {
    const cli = parseCli(process.argv.slice(2));
    if (cli.showHelp) {
      process.stdout.write(`${HELP_TEXT}\n`);
      return;
    }

    const fallbackEnv = loadFallbackEnv(process.env.MCP_MEMORY_HTTP_ENV_FILE || DEFAULT_ENV_FILE);
    const client = new MemoryHttpClient({
      endpoint: cli.options.endpoint || process.env.MCP_MEMORY_HTTP_ENDPOINT || fallbackEnv.MCP_MEMORY_HTTP_ENDPOINT,
      apiKey: cli.options.apiKey || process.env.MCP_MEMORY_API_KEY || fallbackEnv.MCP_MEMORY_API_KEY,
      timeoutMs: cli.options.timeoutMs,
      insecureTls: cli.options.insecureTls
    });

    if (!client.endpoint) {
      throw new Error('Missing memory service endpoint. Use --endpoint or MCP_MEMORY_HTTP_ENDPOINT.');
    }

    const result = await runCommand(client, cli.command, cli.arguments);
    if (result?.stream) {
      await pipeline(result.stream, process.stdout);
      return;
    }

    if (typeof result === 'string') {
      process.stdout.write(`${result}\n`);
      return;
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

function buildHelpText() {
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

function loadFallbackEnv(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }

  const output = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)\s*$/u);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (key !== 'MCP_MEMORY_HTTP_ENDPOINT' && key !== 'MCP_MEMORY_API_KEY') {
      continue;
    }

    output[key] = unquoteEnvValue(rawValue);
  }

  return output;
}

function unquoteEnvValue(value) {
  const trimmed = String(value || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

void main();