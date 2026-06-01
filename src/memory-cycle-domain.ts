import type {
  ActiveSession,
  ExtractedTool,
  HookMessage,
  HookPayload,
  MemoryCategory,
  PromotedMemory,
  SessionTurn,
  StoredMemory,
  SubagentRecord,
  ToolRecord
} from './types.js';

const maxMatches = 4;
const sensitiveToolNames = new Set([
  'apply_patch',
  'create_file',
  'edit_notebook_file',
  'vscode_renameSymbol',
  'run_in_terminal',
  'create_directory',
  'mcp_smart-tree_edit'
]);
const stopWords = new Set([
  'about', 'after', 'agent', 'agora', 'ainda', 'algo', 'algum', 'alguma', 'antes', 'aqui', 'assim', 'cada', 'como', 'com', 'consigo', 'could', 'depois', 'desde', 'dessa', 'desse', 'deste', 'direto', 'dizer', 'eles', 'elas', 'esta', 'este', 'fazer', 'foi', 'for', 'from', 'have', 'isso', 'isto', 'mais', 'make', 'muito', 'need', 'para', 'porque', 'precisa', 'quero', 'queria', 'same', 'sem', 'ser', 'sobre', 'some', 'tambem', 'that', 'them', 'this', 'tipo', 'uma', 'umas', 'uns', 'usar', 'user', 'with'
]);

interface PromotionPolicy {
  minScore: number;
  reason: string;
  requiresDirective: boolean;
}

interface MemoryLike {
  category?: string;
  content?: string;
  metadata?: { category?: string };
  tags?: string[];
  text?: string;
  updated_at_iso?: string;
}

type CategoryScores = Record<MemoryCategory, number>;

export const memoryCategories: MemoryCategory[] = ['preference', 'project', 'workflow', 'technical-decision'];

const categorySignals: Record<MemoryCategory, string[]> = {
  preference: ['sempre', 'nunca', 'prefira', 'prefer', 'preferencia', 'preferência', 'padrao', 'padrão', 'evitar', 'usar', 'use', 'obrigatorio', 'obrigatório', 'convencao', 'convenção'],
  project: ['vscode', 'profile', 'workspace', 'settings', 'hooks', 'prompts', 'skills', 'instructions', 'mcp', 'smart-tree', 'path', 'arquivo', 'json', 'script', 'config', 'diretorio', 'diretório'],
  workflow: ['workflow', 'fluxo', 'ciclo', 'recall', 'apply', 'store', 'update', 'persist', 'persistir', 'checkpoint', 'pretooluse', 'posttooluse', 'sessionstart', 'stop', 'validar', 'gate', 'hook'],
  'technical-decision': ['heuristica', 'heurística', 'categoria', 'schema', 'migration', 'summary', 'memory_record', 'promocao', 'promoção', 'tradeoff', 'policy', 'estrutura', 'design', 'refactor', 'script']
};
const promotionPolicies: Record<MemoryCategory, PromotionPolicy> = {
  preference: { minScore: 2, reason: 'stable user preference detected', requiresDirective: true },
  project: { minScore: 3, reason: 'project or profile-specific context detected', requiresDirective: false },
  workflow: { minScore: 3, reason: 'repeatable workflow detected', requiresDirective: false },
  'technical-decision': { minScore: 3, reason: 'durable technical decision detected', requiresDirective: false }
};

export function extractPrompt(payload: HookPayload): string {
  const directCandidates = [
    payload.prompt,
    payload.userPrompt,
    payload.user_prompt,
    payload.message,
    payload.text,
    payload.data?.prompt,
    payload.data?.userPrompt,
    payload.data?.user_prompt,
    payload.data?.message
  ];
  const direct = firstNonEmptyString(directCandidates);
  if (direct) {
    return direct;
  }

  if (!Array.isArray(payload.messages)) {
    return '';
  }

  const userMessages = payload.messages
    .filter((item): item is HookMessage & { content: string; role?: string } => item?.role === 'user' && typeof item.content === 'string')
    .map((item) => item.content.trim())
    .filter(Boolean);
  return userMessages.at(-1) ?? '';
}

export function getEventName(payload: HookPayload): string {
  return firstNonEmptyString([
    payload.hookEventName,
    payload.hook_event_name,
    payload.eventName,
    payload.event,
    payload.name,
    payload.data?.hookEventName,
    payload.data?.hook_event_name,
    payload.hookSpecificOutput?.hookEventName,
    payload.hookSpecificOutput?.hook_event_name
  ]);
}

export function extractTool(payload: HookPayload): ExtractedTool {
  const toolInput = normalizeToolInput(payload.tool_input);
  const toolName = firstNonEmptyString([
    payload.toolName,
    payload.tool_name,
    payload.tool,
    payload.name,
    payload.data?.toolName,
    payload.data?.tool_name,
    toolInput.toolName,
    toolInput.tool_name
  ]);

  return {
    name: toolName,
    target: extractToolTarget(payload, toolInput, toolName)
  };
}

function extractToolTarget(payload: HookPayload, toolInput: Record<string, unknown>, toolName: string): string {
  const directTarget = firstNonEmptyString([
    payload.command,
    payload.filePath,
    payload.file_path,
    payload.path,
    payload.uri,
    toolInput.command,
    toolInput.filePath,
    toolInput.file_path,
    toolInput.path,
    toolInput.uri,
    payload.data?.command,
    payload.data?.filePath,
    payload.data?.file_path,
    payload.data?.path
  ]);

  if (directTarget) {
    return directTarget;
  }

  if (toolName === 'apply_patch') {
    const patchText = firstNonEmptyString([toolInput.input, toolInput.patch, toolInput.content, payload.tool_input]);
    const updatedFile = /\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(patchText);
    return updatedFile?.[1]?.trim() ?? '';
  }

  if (toolName === 'run_in_terminal') {
    return firstNonEmptyString([toolInput.command, toolInput.explanation, payload.tool_input]);
  }

  if (toolName === 'memory') {
    return firstNonEmptyString([toolInput.path, toolInput.filePath, toolInput.query, payload.tool_input]);
  }

  return firstNonEmptyString([toolInput.input, toolInput.query, toolInput.content, payload.tool_input]);
}

function normalizeToolInput(toolInput: unknown): Record<string, unknown> {
  if (isRecord(toolInput)) {
    return toolInput;
  }

  if (typeof toolInput !== 'string' || toolInput.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(toolInput) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return { input: toolInput };
  }
}

function firstNonEmptyString(values: unknown[]): string {
  const value = values.find((item) => typeof item === 'string' && item.trim().length > 0);
  return typeof value === 'string' ? value.trim() : '';
}

export function extractSubagentName(payload: HookPayload): string {
  return firstNonEmptyString([payload.agentName, payload.subagentName, payload.name, payload.data?.agentName]) || 'unknown-subagent';
}

export function tokenize(text: string): string[] {
  return unique(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((item) => item.length >= 3 && !stopWords.has(item))
  );
}

export function categorizeText(text: string): MemoryCategory[] {
  return selectCategories(scoreCategorySignals([text]));
}

export function categorizeTool(toolName: string, target: string): MemoryCategory[] {
  return selectCategories(scoreCategorySignals([toolName, target]));
}

export function findMatches(memories: StoredMemory[], keywords: string[]): StoredMemory[] {
  if (keywords.length === 0) {
    return [];
  }

  return memories
    .map((memory) => ({
      memory,
      score: keywords.reduce((total, keyword) => {
        const haystack = `${memory.content} ${memory.tags.join(' ')}`.toLowerCase();
        return total + (haystack.includes(keyword) ? 1 : 0);
      }, 0)
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || compareDates(right.memory.updated_at_iso, left.memory.updated_at_iso))
    .slice(0, maxMatches)
    .map((item) => item.memory);
}

export function buildSummary(session: ActiveSession): string {
  const recentPrompt = session.prompts.at(-1) ?? 'none';
  const keywords = session.keywords.slice(0, 6).join(', ') || 'none';
  const categories = normalizeCategories(session.categories).join(', ') || 'workflow';
  const tools = session.tools.map((tool) => tool.name).slice(-4).join(', ') || 'none';
  const toolTargets = buildToolTargetSummary(session.tools);
  const subagents = buildSubagentSummary(session.subagents);
  if (recentPrompt === 'none' && keywords === 'none') {
    return '';
  }

  return [
    'MEMORY_RECORD',
    `CATEGORY=${pickPrimaryCategory(session.categories)}`,
    `CATEGORIES=${categories}`,
    `TOPICS=${keywords}`,
    `INTENT=${extractIntent(session)}`,
    `LATEST_PROMPT=${recentPrompt}`,
    `TOOLS=${tools}`,
    `TOOL_TARGETS=${toolTargets}`,
    `SUBAGENTS=${subagents}`,
    `RECALL_STATUS=${session.recall?.status ?? 'pending'}`,
    `SUMMARY=${buildNarrativeSummary(session)}`
  ].join('\n');
}

export function buildNarrativeSummary(session: ActiveSession): string {
  const focus = session.keywords.slice(0, 6).join(', ') || 'none';
  const tools = buildToolNarrativeSummary(session.tools);
  const subagents = buildSubagentSummary(session.subagents);
  return `focus=${focus}; tools=${tools}; subagents=${subagents}; promptCount=${session.promptCount}`;
}

export function buildRecallReminder(session: ActiveSession): string {
  return `Memory cycle reminder: no matching memory found. Check ${normalizeCategories(session.categories).join(', ')} context before sensitive edits, then persist a searchable MEMORY_RECORD summary at the end.`;
}

export function extractIntent(session: ActiveSession): string {
  return compressText(session.prompts.at(-1) ?? 'No explicit prompt captured', 120);
}

export function formatMemories(memories: MemoryLike[]): string {
  return memories
    .map((memory) => `[${normalizeCategory(memory.metadata?.category ?? memory.category)}] ${compressText(memory.content ?? memory.text ?? '', 100)}`)
    .join(' | ');
}

export function compressText(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizeCategory(category: unknown): MemoryCategory {
  return typeof category === 'string' && memoryCategories.includes(category as MemoryCategory)
    ? category as MemoryCategory
    : 'workflow';
}

export function normalizeCategories(categories: unknown[]): MemoryCategory[] {
  return unique((categories ?? []).map((category) => normalizeCategory(category)));
}

export function pickPrimaryCategory(categories: unknown[]): MemoryCategory {
  return normalizeCategories(categories)[0] ?? 'workflow';
}

export function isSensitiveTool(tool: ExtractedTool | ToolRecord): boolean {
  if (!tool.name) {
    return false;
  }

  return sensitiveToolNames.has(tool.name) || /(patch|edit|rename|delete|write|terminal)/i.test(`${tool.name} ${tool.target}`);
}

export function getRecallGap(session: ActiveSession): string {
  if (!session.recall?.lastRecallAt) {
    return 'No recall ran in this session yet.';
  }

  if (session.recall.status !== 'matched') {
    return 'Recall did not find relevant memory for the current intent.';
  }

  if (session.promptCount <= 0) {
    return 'There is no user prompt recorded for this session.';
  }

  return '';
}

export function promoteSessionMemories(session: ActiveSession, summary: string, timestamp: string): PromotedMemory[] {
  if (!summary) {
    return [];
  }

  const categories = normalizeCategories(session.categories);
  const scores = scoreCategorySignals([summary, ...session.prompts, ...session.tools.map((tool) => `${tool.name} ${tool.target}`)]);
  const directives = detectDirectiveSignals([summary, ...session.prompts].join(' '));
  const tools = session.tools.map((tool) => tool.name).slice(-4).join(', ') || 'none';
  const toolTargets = buildToolTargetSummary(session.tools);
  const subagents = buildSubagentSummary(session.subagents);
  const topics = session.keywords.slice(0, 8).join(', ') || 'none';

  return categories.flatMap((category) => {
    const policy = promotionPolicies[category];
    if (!shouldPromoteCategory(scores[category], policy, directives.length > 0)) {
      return [];
    }

    return [{
      categories,
      category,
      id: buildPromotedMemoryId(category, session),
      source: 'session-promotion',
      tags: unique(['memory', 'long-term', 'promoted', category, ...session.keywords]).slice(0, 14),
      text: [
        'MEMORY_RECORD',
        `CATEGORY=${category}`,
        `CATEGORIES=${categories.join(', ')}`,
        'DURABILITY=long-term',
        `PROMOTION_REASON=${policy.reason}`,
        `TOPICS=${topics}`,
        `INTENT=${extractIntent(session)}`,
        `LATEST_PROMPT=${session.prompts.at(-1) ?? 'none'}`,
        `TOOLS=${tools}`,
        `TOOL_TARGETS=${toolTargets}`,
        `SUBAGENTS=${subagents}`,
        `RECALL_STATUS=${session.recall?.status ?? 'pending'}`,
        `SUMMARY=${buildNarrativeSummary(session)}`
      ].join('\n'),
      updatedAt: timestamp
    }];
  });
}

export function createSessionTurns(session: ActiveSession): SessionTurn[] {
  return [
    ...session.prompts.map((prompt) => ({ content: prompt, role: 'user' })),
    { content: buildSummary(session) || buildNarrativeSummary(session), role: 'assistant' }
  ];
}

function buildToolNarrativeSummary(tools: ToolRecord[]): string {
  if (tools.length === 0) {
    return 'none';
  }

  return tools.slice(-4).map((tool) => tool.target ? `${tool.name}:${compressText(tool.target, 60)}` : tool.name).join(', ');
}

function buildToolTargetSummary(tools: ToolRecord[]): string {
  if (tools.length === 0) {
    return 'none';
  }

  return tools.slice(-4).map((tool) => tool.target ? `${tool.name}:${compressText(tool.target, 80)}` : tool.name).join(', ');
}

function buildSubagentSummary(subagents: SubagentRecord[]): string {
  if (subagents.length === 0) {
    return 'none';
  }

  return subagents.slice(-4).map((item) => `${item.kind}:${item.name}`).join(', ');
}

function shouldPromoteCategory(score: number, policy: PromotionPolicy, hasDirective: boolean): boolean {
  return score >= policy.minScore && (!policy.requiresDirective || hasDirective);
}

function scoreCategorySignals(inputs: string[]): CategoryScores {
  const corpus = inputs.map((item) => item.toLowerCase()).filter(Boolean).join(' ');
  const scores = Object.fromEntries(memoryCategories.map((category) => [category, 0])) as CategoryScores;

  for (const category of memoryCategories) {
    for (const signal of categorySignals[category]) {
      if (corpus.includes(signal)) {
        scores[category] += 1;
      }
    }
  }

  if (/(apply_patch|run_in_terminal|create_file|vscode_renamesymbol|mcp_smart-tree_edit)/.test(corpus)) {
    scores.workflow += 1;
    scores['technical-decision'] += 1;
  }

  if (/(profile|vscode|settings|prompts|skills|instructions)/.test(corpus)) {
    scores.project += 1;
  }

  return scores;
}

function selectCategories(scores: CategoryScores): MemoryCategory[] {
  const selected = memoryCategories.filter((category) => scores[category] >= 2);
  if (selected.length > 0) {
    return selected;
  }

  const bestCategory = memoryCategories.reduce((best, category) => (scores[category] > scores[best] ? category : best), 'workflow');
  return scores[bestCategory] > 0 ? [bestCategory] : ['workflow'];
}

function detectDirectiveSignals(text: string): string[] {
  const lower = text.toLowerCase();
  return ['sempre', 'nunca', 'prefira', 'prefer', 'obrigatorio', 'obrigatório', 'evitar'].filter((signal) => lower.includes(signal));
}

function buildPromotedMemoryId(category: MemoryCategory, session: ActiveSession): string {
  const seed = `${extractIntent(session)}|${session.keywords.slice(0, 6).join(',')}`;
  return `${category}-${Buffer.from(seed).toString('base64url').slice(0, 12)}`;
}

function compareDates(left?: string, right?: string): number {
  return new Date(left ?? 0).getTime() - new Date(right ?? 0).getTime();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function logDebug(eventName: string, metadata: unknown): void {
  if (process.env.MEMORY_HOOK_DEBUG === '0') {
    return;
  }

  try {
    process.stderr.write(`${JSON.stringify({ eventName, metadata, timestamp: new Date().toISOString() })}\n`);
  } catch {
    // Ignore debug logging failures.
  }
}