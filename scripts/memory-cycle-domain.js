const memoryCategories = ['preference', 'project', 'workflow', 'technical-decision'];
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
const categorySignals = {
  preference: ['sempre', 'nunca', 'prefira', 'prefer', 'preferencia', 'preferência', 'padrao', 'padrão', 'evitar', 'usar', 'use', 'obrigatorio', 'obrigatório', 'convencao', 'convenção'],
  project: ['vscode', 'profile', 'workspace', 'settings', 'hooks', 'prompts', 'skills', 'instructions', 'mcp', 'smart-tree', 'path', 'arquivo', 'json', 'script', 'config', 'diretorio', 'diretório'],
  workflow: ['workflow', 'fluxo', 'ciclo', 'recall', 'apply', 'store', 'update', 'persist', 'persistir', 'checkpoint', 'pretooluse', 'posttooluse', 'sessionstart', 'stop', 'validar', 'gate', 'hook'],
  'technical-decision': ['heuristica', 'heurística', 'categoria', 'schema', 'migration', 'summary', 'memory_record', 'promocao', 'promoção', 'tradeoff', 'policy', 'estrutura', 'design', 'refactor', 'script']
};
const promotionPolicies = {
  preference: { minScore: 2, requiresDirective: true, reason: 'stable user preference detected' },
  project: { minScore: 3, requiresDirective: false, reason: 'project or profile-specific context detected' },
  workflow: { minScore: 3, requiresDirective: false, reason: 'repeatable workflow detected' },
  'technical-decision': { minScore: 3, requiresDirective: false, reason: 'durable technical decision detected' }
};

function extractPrompt(payload) {
  const directCandidates = [payload.prompt, payload.userPrompt, payload.user_prompt, payload.message, payload.text, payload?.data?.prompt, payload?.data?.userPrompt, payload?.data?.user_prompt, payload?.data?.message];
  const direct = directCandidates.find((value) => typeof value === 'string' && value.trim().length > 0);
  if (direct) {
    return direct.trim();
  }

  if (!Array.isArray(payload.messages)) {
    return '';
  }

  const userMessages = payload.messages.filter((item) => item?.role === 'user' && typeof item.content === 'string').map((item) => item.content.trim()).filter(Boolean);
  return userMessages[userMessages.length - 1] || '';
}

function getEventName(payload) {
  const candidates = [payload.hookEventName, payload.hook_event_name, payload.eventName, payload.event, payload.name, payload?.data?.hookEventName, payload?.data?.hook_event_name, payload?.hookSpecificOutput?.hookEventName, payload?.hookSpecificOutput?.hook_event_name];
  return candidates.find((value) => typeof value === 'string' && value.length > 0) || '';
}

function extractTool(payload) {
  const toolInput = normalizeToolInput(payload.tool_input);
  const toolName = String(payload.toolName || payload.tool_name || payload.tool || payload.name || payload?.data?.toolName || payload?.data?.tool_name || toolInput.toolName || toolInput.tool_name || '').trim();
  return {
    name: toolName,
    target: extractToolTarget(payload, toolInput, toolName)
  };
}

function extractToolTarget(payload, toolInput, toolName) {
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
    payload?.data?.command,
    payload?.data?.filePath,
    payload?.data?.file_path,
    payload?.data?.path
  ]);

  if (directTarget) {
    return directTarget;
  }

  if (toolName === 'apply_patch') {
    const patchText = firstNonEmptyString([toolInput.input, toolInput.patch, toolInput.content, payload.tool_input]);
    const updatedFile = /\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(String(patchText || ''));
    return updatedFile?.[1]?.trim() || '';
  }

  if (toolName === 'run_in_terminal') {
    return firstNonEmptyString([toolInput.command, toolInput.explanation, payload.tool_input]);
  }

  if (toolName === 'memory') {
    return firstNonEmptyString([toolInput.path, toolInput.filePath, toolInput.query, payload.tool_input]);
  }

  return firstNonEmptyString([toolInput.input, toolInput.query, toolInput.content, payload.tool_input]);
}

function normalizeToolInput(toolInput) {
  if (isObject(toolInput)) {
    return toolInput;
  }

  if (typeof toolInput !== 'string' || toolInput.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(toolInput);
    return isObject(parsed) ? parsed : {};
  } catch {
    return { input: toolInput };
  }
}

function firstNonEmptyString(values) {
  const value = values.find((item) => typeof item === 'string' && item.trim().length > 0);
  return value ? value.trim() : '';
}

function extractSubagentName(payload) {
  return String(payload.agentName || payload.subagentName || payload.name || payload?.data?.agentName || 'unknown-subagent');
}

function tokenize(text) {
  return unique(String(text || '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((item) => item.length >= 3 && !stopWords.has(item)));
}

function categorizeText(text) {
  return selectCategories(scoreCategorySignals([text]));
}

function categorizeTool(toolName, target) {
  return selectCategories(scoreCategorySignals([toolName, target]));
}

function findMatches(memories, keywords) {
  if (keywords.length === 0) {
    return [];
  }

  return memories
    .map((memory) => ({
      memory,
      score: keywords.reduce((total, keyword) => {
        const haystack = `${memory.content || ''} ${(memory.tags || []).join(' ')}`.toLowerCase();
        return total + (haystack.includes(keyword) ? 1 : 0);
      }, 0)
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || compareDates(right.memory.updated_at_iso, left.memory.updated_at_iso))
    .slice(0, maxMatches)
    .map((item) => item.memory);
}

function buildSummary(session) {
  const recentPrompt = session.prompts[session.prompts.length - 1] || 'none';
  const keywords = session.keywords.slice(0, 6).join(', ') || 'none';
  const categories = normalizeCategories(session.categories).join(', ') || 'workflow';
  const tools = session.tools.map((tool) => tool.name).slice(-4).join(', ') || 'none';
  const toolTargets = buildToolTargetSummary(session.tools);
  const subagents = buildSubagentSummary(session.subagents);
  if (recentPrompt === 'none' && keywords === 'none') {
    return '';
  }

  return ['MEMORY_RECORD', `CATEGORY=${pickPrimaryCategory(session.categories)}`, `CATEGORIES=${categories}`, `TOPICS=${keywords}`, `INTENT=${extractIntent(session)}`, `LATEST_PROMPT=${recentPrompt}`, `TOOLS=${tools}`, `TOOL_TARGETS=${toolTargets}`, `SUBAGENTS=${subagents}`, `RECALL_STATUS=${session.recall?.status || 'pending'}`, `SUMMARY=${buildNarrativeSummary(session)}`].join('\n');
}

function buildNarrativeSummary(session) {
  const focus = session.keywords.slice(0, 6).join(', ') || 'none';
  const tools = buildToolNarrativeSummary(session.tools);
  const subagents = buildSubagentSummary(session.subagents);
  return `focus=${focus}; tools=${tools}; subagents=${subagents}; promptCount=${session.promptCount}`;
}

function buildRecallReminder(session) {
  return `Memory cycle reminder: no matching memory found. Check ${normalizeCategories(session.categories).join(', ')} context before sensitive edits, then persist a searchable MEMORY_RECORD summary at the end.`;
}

function extractIntent(session) {
  return compressText(session.prompts[session.prompts.length - 1] || 'No explicit prompt captured', 120);
}

function formatMemories(memories) {
  return memories.map((memory) => `[${normalizeCategory(memory.metadata?.category || memory.category)}] ${compressText(memory.content || memory.text, 100)}`).join(' | ');
}

function compressText(text, limit) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeCategory(category) {
  return memoryCategories.includes(category) ? category : 'workflow';
}

function normalizeCategories(categories) {
  return unique((categories || []).map((category) => normalizeCategory(category)));
}

function pickPrimaryCategory(categories) {
  return normalizeCategories(categories)[0] || 'workflow';
}

function isSensitiveTool(tool) {
  if (!tool.name) {
    return false;
  }
  return sensitiveToolNames.has(tool.name) || /(patch|edit|rename|delete|write|terminal)/i.test(`${tool.name} ${tool.target}`);
}

function getRecallGap(session) {
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

function promoteSessionMemories(session, summary, timestamp) {
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
    if (!shouldPromoteCategory(scores[category] || 0, policy, directives.length > 0)) {
      return [];
    }

    return [{
      id: buildPromotedMemoryId(category, session),
      text: ['MEMORY_RECORD', `CATEGORY=${category}`, `CATEGORIES=${categories.join(', ')}`, 'DURABILITY=long-term', `PROMOTION_REASON=${policy.reason}`, `TOPICS=${topics}`, `INTENT=${extractIntent(session)}`, `LATEST_PROMPT=${session.prompts[session.prompts.length - 1] || 'none'}`, `TOOLS=${tools}`, `TOOL_TARGETS=${toolTargets}`, `SUBAGENTS=${subagents}`, `RECALL_STATUS=${session.recall?.status || 'pending'}`, `SUMMARY=${buildNarrativeSummary(session)}`].join('\n'),
      category,
      categories,
      tags: unique(['memory', 'long-term', 'promoted', category, ...session.keywords]).slice(0, 14),
      updatedAt: timestamp,
      source: 'session-promotion'
    }];
  });
}

function createSessionTurns(session) {
  return [...session.prompts.map((prompt) => ({ role: 'user', content: prompt })), { role: 'assistant', content: buildSummary(session) || buildNarrativeSummary(session) }];
}

function buildToolNarrativeSummary(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return 'none';
  }

  return tools.slice(-4).map((tool) => tool.target ? `${tool.name}:${compressText(tool.target, 60)}` : tool.name).join(', ');
}

function buildToolTargetSummary(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return 'none';
  }

  return tools.slice(-4).map((tool) => tool.target ? `${tool.name}:${compressText(tool.target, 80)}` : tool.name).join(', ');
}

function buildSubagentSummary(subagents) {
  if (!Array.isArray(subagents) || subagents.length === 0) {
    return 'none';
  }

  return subagents.slice(-4).map((item) => `${item.kind}:${item.name}`).join(', ');
}

function shouldPromoteCategory(score, policy, hasDirective) {
  return score >= policy.minScore && (!policy.requiresDirective || hasDirective);
}

function scoreCategorySignals(inputs) {
  const corpus = inputs.map((item) => String(item || '').toLowerCase()).filter(Boolean).join(' ');
  const scores = Object.fromEntries(memoryCategories.map((category) => [category, 0]));

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

function selectCategories(scores) {
  const selected = memoryCategories.filter((category) => scores[category] >= 2);
  if (selected.length > 0) {
    return selected;
  }

  const bestCategory = memoryCategories.reduce((best, category) => (scores[category] > scores[best] ? category : best), 'workflow');
  return scores[bestCategory] > 0 ? [bestCategory] : ['workflow'];
}

function detectDirectiveSignals(text) {
  const lower = String(text || '').toLowerCase();
  return ['sempre', 'nunca', 'prefira', 'prefer', 'obrigatorio', 'obrigatório', 'evitar'].filter((signal) => lower.includes(signal));
}

function buildPromotedMemoryId(category, session) {
  const seed = `${extractIntent(session)}|${session.keywords.slice(0, 6).join(',')}`;
  return `${category}-${Buffer.from(seed).toString('base64url').slice(0, 12)}`;
}

function compareDates(left, right) {
  return new Date(left || 0).getTime() - new Date(right || 0).getTime();
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function logDebug(eventName, metadata) {
  if (process.env.MEMORY_HOOK_DEBUG === '0') {
    return;
  }

  try {
    process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), eventName, metadata })}\n`);
  } catch {
    // Intentionally ignore debug logging failures.
  }
}

module.exports = {
  buildNarrativeSummary,
  buildRecallReminder,
  buildSummary,
  categorizeText,
  categorizeTool,
  compressText,
  createSessionTurns,
  extractIntent,
  extractPrompt,
  extractSubagentName,
  extractTool,
  findMatches,
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
};