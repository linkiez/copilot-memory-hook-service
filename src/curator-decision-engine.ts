/**
 * Curator Decision Engine — Full lifecycle management for memory acceptance, refactoring, and deletion.
 * Implements complete curation decisions: what enters, what exits, and how memories are refactored.
 */

import type { MemoryMetadata } from './types.js';

/**
 * Assessment of whether memory content is durable or transient.
 */
export interface DurabilityAssessment {
  isDurable: boolean;
  reasons: string[];
  transientFlags: string[];
}

/**
 * Curator decision result for a memory submission.
 */
export interface CuratorDecision {
  action: 'accept' | 'reject' | 'review-refactor' | 'merge-with-existing';
  reason: string;
  confidence: number; // 0-1 scale
  suggestedRefactoring?: MemoryRefactoringPlan;
  conflictingMemoryId?: string;
}

/**
 * Plan for refactoring a memory (existing or incoming).
 */
export interface MemoryRefactoringPlan {
  normalizeAtomicity: boolean; // Split into single-fact entries if needed
  standardizeNaming: boolean; // Apply PascalCase or snake_case
  removeTransientFlags: string[]; // Phrases to remove (small-talk, debug noise)
  extractKeyEntities: string[]; // Entities to extract for linking
  mergeRelated: string[]; // Existing memory IDs to merge with
  deleteObsolete: string[]; // Existing memory IDs to mark for deletion
  refactoredContent: string;
}

/**
 * Full curator recommendation including decision + refactoring + memory cleanup.
 */
export interface FullCuratorRecommendation {
  decision: CuratorDecision;
  memoryRefactoring: MemoryRefactoringPlan;
  memoryCleanupPlan: MemoryCleanupAction[];
  nextAction: 'store' | 'review' | 'refactor-existing' | 'skip';
}

/**
 * Action to take on an existing memory (update/delete/link).
 */
export interface MemoryCleanupAction {
  memoryId: string;
  action: 'delete' | 'deprecate' | 'link-to-new' | 'merge-update';
  reason: string;
  suggestedUpdate?: string;
}

/**
 * Decide whether curator accepts incoming memory based on durability, relevance, and conflicts.
 */
export function decideCuratorAcceptance(
  content: string,
  durability: DurabilityAssessment,
  searchResults?: { duplicateId?: string; relevance?: number }[]
): CuratorDecision {
  // Strong transient signals → reject
  if (!durability.isDurable && hasStrongTransientSignals(content)) {
    return {
      action: 'reject',
      reason: 'Strong transient signals detected (small-talk, debug noise, temporary code)',
      confidence: 0.95
    };
  }

  // High-relevance duplicate detected → review for merge
  if (searchResults && searchResults.length > 0) {
    const highRelevance = searchResults.find((r) => (r.relevance ?? 0) > 0.85);
    if (highRelevance) {
      const result: CuratorDecision = {
        action: 'merge-with-existing',
        reason: `High-relevance duplicate found (relevance: ${highRelevance.relevance ?? 0.9})`,
        confidence: 0.9
      };
      if (highRelevance.duplicateId) {
        result.conflictingMemoryId = highRelevance.duplicateId;
      }
      return result;
    }

    // Medium-relevance duplicate → review for refactoring
    const mediumRelevance = searchResults.find((r) => (r.relevance ?? 0) > 0.7);
    if (mediumRelevance) {
      const result: CuratorDecision = {
        action: 'review-refactor',
        reason: `Potential duplicate or related memory found (relevance: ${mediumRelevance.relevance ?? 0.75})`,
        confidence: 0.75
      };
      if (mediumRelevance.duplicateId) {
        result.conflictingMemoryId = mediumRelevance.duplicateId;
      }
      return result;
    }
  }

  // Durable content → accept with confidence
  if (durability.isDurable) {
    return {
      action: 'accept',
      reason: `Durable memory: ${durability.reasons.join('; ')}`,
      confidence: 0.95
    };
  }

  // Low durability but no conflicts → accept cautiously
  return {
    action: 'accept',
    reason: 'Low durability content accepted (no conflicts detected)',
    confidence: 0.5
  };
}

/**
 * Refactor incoming memory content: atomize, standardize naming, remove transients.
 */
export function refactorMemoryContent(
  content: string,
  durability: DurabilityAssessment,
  extractRules?: string[]
): MemoryRefactoringPlan {
  const plan: MemoryRefactoringPlan = {
    normalizeAtomicity: needsAtomization(content),
    standardizeNaming: true,
    removeTransientFlags: detectTransientPhrases(content),
    extractKeyEntities: extractKeyEntitiesFromContent(content, extractRules),
    mergeRelated: [],
    deleteObsolete: [],
    refactoredContent: normalizeContent(content)
  };

  return plan;
}

/**
 * Plan memory cleanup for cases where incoming memory conflicts with existing ones.
 */
export function planMemoryCleanup(
  incomingContent: string,
  conflictingMemoryId: string,
  conflictingMemoryContent: string
): MemoryCleanupAction[] {
  const actions: MemoryCleanupAction[] = [];

  // If incoming is clearly newer/more precise version → deprecate old
  if (isNewerVersion(incomingContent, conflictingMemoryContent)) {
    actions.push({
      memoryId: conflictingMemoryId,
      action: 'deprecate',
      reason: 'Superseded by newer, more precise observation',
      suggestedUpdate: `[DEPRECATED] ${conflictingMemoryContent}`
    });
  }

  // If they're about same thing but different angles → link them
  if (isComplementaryPerspective(incomingContent, conflictingMemoryContent)) {
    actions.push({
      memoryId: conflictingMemoryId,
      action: 'link-to-new',
      reason: 'Related memory with complementary perspective'
    });
  }

  // If incoming contradicts old → flag for user review
  if (isContradiction(incomingContent, conflictingMemoryContent)) {
    actions.push({
      memoryId: conflictingMemoryId,
      action: 'merge-update',
      reason: 'Contradicts existing memory; requires user confirmation',
      suggestedUpdate: `OLD: ${conflictingMemoryContent}\nNEW: ${incomingContent}`
    });
  }

  return actions;
}

/**
 * Build full curator recommendation including decision, refactoring, and cleanup.
 */
export function buildFullCuratorRecommendation(
  content: string,
  durability: DurabilityAssessment,
  searchResults?: { duplicateId?: string; relevance?: number }[],
  conflictingMemory?: { id: string; content: string }
): FullCuratorRecommendation {
  const decision = decideCuratorAcceptance(content, durability, searchResults);
  const memoryRefactoring = refactorMemoryContent(content, durability);
  let memoryCleanupPlan: MemoryCleanupAction[] = [];

  if (conflictingMemory) {
    memoryCleanupPlan = planMemoryCleanup(content, conflictingMemory.id, conflictingMemory.content);
  }

  let nextAction: FullCuratorRecommendation['nextAction'] = 'store';
  if (decision.action === 'reject') nextAction = 'skip';
  else if (decision.action === 'review-refactor') nextAction = 'review';
  else if (decision.action === 'merge-with-existing') nextAction = 'refactor-existing';

  return {
    decision,
    memoryRefactoring,
    memoryCleanupPlan,
    nextAction
  };
}

/**
 * Apply refactoring transformations to memory content.
 */
export function applyMemoryRefactoring(
  content: string,
  plan: MemoryRefactoringPlan
): string {
  let result = content;

  // Remove transient phrases
  for (const phrase of plan.removeTransientFlags) {
    result = result.replace(new RegExp(escapeRegex(phrase), 'gi'), '');
  }

  // Trim and normalize whitespace
  result = result
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');

  // Standardize naming: preserve PascalCase/snake_case boundaries
  result = standardizeEntityNames(result);

  return result;
}

/**
 * Export curator hints to attach to memory metadata.
 */
export function attachCuratorDecisionMetadata(
  metadata: MemoryMetadata,
  recommendation: FullCuratorRecommendation
): MemoryMetadata {
  return {
    ...metadata,
    curator: {
      decision: recommendation.decision.action,
      reason: recommendation.decision.reason,
      confidence: recommendation.decision.confidence,
      nextAction: recommendation.nextAction,
      refactoringApplied: recommendation.memoryRefactoring.normalizeAtomicity ||
        recommendation.memoryRefactoring.standardizeNaming ||
        recommendation.memoryRefactoring.removeTransientFlags.length > 0,
      entitiesExtracted: recommendation.memoryRefactoring.extractKeyEntities,
      conflictingMemoryId: recommendation.decision.conflictingMemoryId
    }
  };
}

// ============ PRIVATE HELPERS ============

/**
 * Detect if content has strong transient signals (debug noise, small talk, etc).
 */
function hasStrongTransientSignals(content: string): boolean {
  const transientPatterns = [
    /\b(hello|hi|thank|sorry|please)\b/gi,
    /\b(test|debug|quick|temporary|wip|todo|fixme)\b/gi,
    /^(Error:|TypeError:|SyntaxError:)/m,
    /\b(on hold|postpone|later|maybe)\b/gi
  ];

  const matches = transientPatterns.filter((p) => p.test(content));
  return matches.length >= 2; // Strong signal = multiple transient patterns
}

/**
 * Detect individual transient phrases to remove.
 */
function detectTransientPhrases(content: string): string[] {
  const phrases: string[] = [];
  const patterns = [
    'Hello', 'Hi there', 'Thank you', 'Sorry', 'Just wanted to say',
    'Quick test', 'Temporary code', 'Debug only', 'WIP', 'FIXME', 'TODO'
  ];

  for (const pattern of patterns) {
    if (new RegExp(pattern, 'i').test(content)) {
      phrases.push(pattern);
    }
  }

  return phrases;
}

/**
 * Detect if content needs atomization (multiple facts in one entry).
 */
function needsAtomization(content: string): boolean {
  // Heuristic: multiple sentences + multiple "and/but" connectors = needs split
  const sentences = content.split(/[.!?]+/).length;
  const conjunctions = (content.match(/\band\b|\bbut\b/gi) || []).length;
  return sentences > 3 && conjunctions > 1;
}

/**
 * Extract key entities from content using regex patterns.
 */
function extractKeyEntitiesFromContent(content: string, rules?: string[]): string[] {
  const entities: string[] = [];

  // Default entity patterns
  const patterns = [
    /(?:project|workflow|task):\s*([A-Z_]\w*)/g,
    /(?:technology|tool|framework):\s*(\w+)/g,
    /(?:pattern|architecture|design):\s*([A-Z]\w*)/g
  ];

  for (const pattern of patterns) {
    extractMatches(content, pattern, entities);
  }

  // Custom extraction rules
  if (rules) {
    for (const rule of rules) {
      const regex = new RegExp(rule, 'g');
      extractMatches(content, regex, entities);
    }
  }

  return [...new Set(entities)]; // Deduplicate
}

/**
 * Helper to extract regex matches into array.
 */
function extractMatches(content: string, pattern: RegExp, results: string[]): void {
  let match;
  const tempPattern = new RegExp(pattern.source, pattern.flags);
  // eslint-disable-next-line no-cond-assign
  while ((match = tempPattern.exec(content)) !== null) {
    if (match[1]) {
      results.push(match[1]);
    }
  }
}

/**
 * Normalize content: standardize whitespace, remove redundancy.
 */
function normalizeContent(content: string): string {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Standardize entity names to PascalCase or snake_case consistently.
 */
function standardizeEntityNames(content: string): string {
  // Simple heuristic: if a word appears in mixed patterns, standardize to snake_case
  let result = content;

  // Convert CamelCase words followed by underscores to consistent snake_case
  result = result.replace(/([A-Z][a-z]+)_([A-Z][a-z]+)/g, (match, p1, p2) => {
    return `${p1.toLowerCase()}_${p2.toLowerCase()}`;
  });

  return result;
}

/**
 * Determine if incoming content is a newer version of conflicting memory.
 */
function isNewerVersion(incoming: string, existing: string): boolean {
  // Heuristic: incoming is newer if it's more specific or longer with same core topic
  const incomingLength = incoming.length;
  const existingLength = existing.length;
  const topicsMatch = incoming.split(/\s+/).some((word) =>
    existing.toLowerCase().includes(word.toLowerCase())
  );

  return topicsMatch && incomingLength > existingLength * 1.2;
}

/**
 * Determine if memories are complementary (different angles on same topic).
 */
function isComplementaryPerspective(incoming: string, existing: string): boolean {
  // Heuristic: look for overlapping nouns/verbs but different focus
  const incomingTerms = new Set(incoming.toLowerCase().match(/\b\w+\b/g) ?? []);
  const existingTerms = new Set(existing.toLowerCase().match(/\b\w+\b/g) ?? []);

  // Overlap > 40% but not identical
  const intersection = Array.from(incomingTerms).filter((t) => existingTerms.has(t));
  const overlapRatio = intersection.length / Math.max(incomingTerms.size, existingTerms.size);

  return overlapRatio > 0.4 && overlapRatio < 0.95;
}

/**
 * Determine if memories contradict each other.
 */
function isContradiction(incoming: string, existing: string): boolean {
  // Heuristic: detect negation pairs (prefer X vs prefer Y)
  const preferPattern = /prefer.*?([A-Z])/gi;

  const incomingPrefs = Array.from(incoming.matchAll(preferPattern)).map((m) => m[1]?.toLowerCase());
  const existingPrefs = Array.from(existing.matchAll(preferPattern)).map((m) => m[1]?.toLowerCase());

  // If same topic but different preferences → contradiction
  return (
    incomingPrefs.length > 0 &&
    existingPrefs.length > 0 &&
    !incomingPrefs.some((p) => existingPrefs.includes(p))
  );
}

/**
 * Escape regex special characters.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
