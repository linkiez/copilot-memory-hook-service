/**
 * Simplified curator integration helpers for preprocessStoreArgs
 */

import type { MemoryMetadata } from './types.js';
import type {
  FullCuratorRecommendation
} from './curator-decision-engine.js';

/**
 * Enhance existing curator metadata with cleanup actions from recommendation.
 * Preserves existing curator fields (isDurable, durabilityReasons, etc.)
 */
export function enhanceCuratorMetadataWithCleanup(
  metadata: MemoryMetadata,
  recommendation: FullCuratorRecommendation
): MemoryMetadata {
  if (recommendation.memoryCleanupPlan.length === 0) {
    return metadata;
  }

  const enhanced = { ...metadata };
  const curator = (enhanced as Record<string, unknown>).curator as Record<string, unknown> | undefined;

  if (curator) {
    curator.cleanupActions = recommendation.memoryCleanupPlan;
  }

  return enhanced;
}

/**
 * Check if curator recommends rejection (for early-return scenarios).
 */
export function isCuratorRecommendingRejection(recommendation: FullCuratorRecommendation): boolean {
  return recommendation.decision.action === 'reject';
}

/**
 * Check if curator recommends refactoring.
 */
export function isCuratorRecommendingRefactoring(recommendation: FullCuratorRecommendation): boolean {
  return (
    recommendation.memoryRefactoring.normalizeAtomicity ||
    recommendation.memoryRefactoring.removeTransientFlags.length > 0
  );
}
