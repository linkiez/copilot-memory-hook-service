import type { JsonObject } from './types.js';

/**
 * Proactive retrieval metadata attached to store commands to warn about potential duplicates or conflicts.
 */
export interface ProactiveRetrievalWarning {
  potentialDuplicate: boolean;
  relatedMemories: Array<{
    contentSnippet: string;
    relevanceScore: number;
    conflictSeverity: 'low' | 'medium' | 'high';
  }>;
  recommendation: 'store-new' | 'update-existing' | 'skip-storage';
}

/**
 * Analyzes content against curator rules to detect if this is a candidate for durable storage.
 *
 * @param content - The memory content to analyze for durability.
 * @returns A scoring object indicating whether to store, update, or skip.
 */
export function scoreMemoryDurability(content: string): {
  isDurable: boolean;
  reasons: string[];
  transientFlags: string[];
} {
  const reasons: string[] = [];
  const transientFlags: string[] = [];

  // Check for durable patterns
  if (/preference|decision|workflow|architecture|pattern|rule|best practice/i.test(content)) {
    reasons.push('Contains durable architectural or preference language.');
  }

  if (/command|path|tool|technology|framework/i.test(content)) {
    reasons.push('References exact technical references (commands, paths, technologies).');
  }

  // Check for transient patterns
  if (/hello|hi|thank|sorry|please|temporary|test|debug|try|quick/i.test(content)) {
    transientFlags.push('Contains conversational or temporary language.');
  }

  if (/error|failed|bug|broken|crash|issue|problem/i.test(content) && content.length < 100) {
    transientFlags.push('Short error message; likely transient.');
  }

  if (/todo|fixme|wip|in progress|draft/i.test(content)) {
    transientFlags.push('Marked as incomplete or work-in-progress.');
  }

  const isDurable = reasons.length > transientFlags.length;

  return {
    isDurable,
    reasons,
    transientFlags
  };
}

/**
 * Builds a query rewrite instruction for proactive retrieval before store operations.
 * This query helps detect related/duplicate memories before writing new ones.
 *
 * @param content - The memory content being stored.
 * @returns A curated search query to find related memories.
 */
export function buildProactiveRetrievalQuery(content: string): string {
  // Extract key terms: noun phrases, technical terms, and decision keywords
  const keyTerms: string[] = [];

  // Technical patterns
  const techMatch = /(?:language|framework|tool|library|API|protocol|pattern):\s*([^.,\n]+)/i.exec(content);
  if (techMatch?.[1]) {
    const term = techMatch[1].trim().split(/\s+/)[0];
    if (term) {
      keyTerms.push(term);
    }
  }

  // Decision patterns
  const decisionMatch = /(?:decided|decided to|we use|prefer|best practice):\s*([^.,\n]+)/i.exec(content);
  if (decisionMatch?.[1]) {
    keyTerms.push(...decisionMatch[1].trim().split(/\s+/).slice(0, 2));
  }

  // Project/workflow keywords
  const projMatch = /(?:project|workflow|process|task):\s*([^.,\n]+)/i.exec(content);
  if (projMatch?.[1]) {
    keyTerms.push(...projMatch[1].trim().split(/\s+/).slice(0, 2));
  }

  // Fallback: use first few meaningful words
  if (keyTerms.length === 0) {
    const words = content
      .split(/\s+/)
      .filter((w) => w.length > 4 && !/^(the|and|this|that|with|from|into|have|been)$/i.test(w))
      .slice(0, 3);
    keyTerms.push(...words);
  }

  return keyTerms.length > 0
    ? `Find related or duplicate memories about: ${keyTerms.join(', ')}`
    : 'Find related memories for potential conflicts or duplicates';
}

/**
 * Attaches durability metadata to a store command before sending.
 *
 * @param metadata - Existing metadata object.
 * @param content - Memory content being stored.
 * @returns Updated metadata with curator/retrieval hints.
 */
export function attachCuratorRetrievalHints(metadata: JsonObject, content: string): JsonObject {
  const durability = scoreMemoryDurability(content);
  const retrievalQuery = buildProactiveRetrievalQuery(content);

  return {
    ...metadata,
    curator: {
      ...(typeof metadata.curator === 'object' && metadata.curator !== null ? metadata.curator : {}),
      isDurable: durability.isDurable,
      durabilityReasons: durability.reasons,
      transientFlags: durability.transientFlags,
      proactiveRetrievalQuery: retrievalQuery,
      retrieverIntent: durability.isDurable ? 'store-and-link' : 'validate-before-store'
    }
  };
}
