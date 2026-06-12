import type { JsonObject, SearchResult } from './types.js';

/**
 * Result of an automatic duplicate check before storing memory.
 */
export interface AutomaticDuplicateCheckResult {
  executedSearch: boolean;
  searchQuery: string;
  duplicatesFound: SearchResult[];
  highestRelevance: number;
  recommendation: 'proceed-store' | 'review-duplicates' | 'skip-store';
  warningMessage?: string;
}

/**
 * Executes an automatic duplicate check by querying the memory service.
 * Returns early if no HTTP client is available (offline mode).
 *
 * @param query - The search query to execute (from proactive retrieval hints).
 * @param durability - The durability score object to decide whether to search.
 * @param httpClient - Optional HTTP client for remote searches.
 * @returns Result of the duplicate check.
 */
export async function checkForDuplicatesAutomatically(
  query: string,
  durability: { isDurable: boolean; transientFlags: string[] },
  httpClient?: { endpoint?: string; search(query: string): Promise<SearchResult[]> }
): Promise<AutomaticDuplicateCheckResult> {
  // Skip search for durable memories; they deserve to be stored.
  if (durability.isDurable) {
    return {
      executedSearch: false,
      searchQuery: query,
      duplicatesFound: [],
      highestRelevance: 0,
      recommendation: 'proceed-store'
    };
  }

  // Skip search if no HTTP client configured
  if (!httpClient?.endpoint) {
    return {
      executedSearch: false,
      searchQuery: query,
      duplicatesFound: [],
      highestRelevance: 0,
      recommendation: 'proceed-store'
    };
  }

  // Execute search for transient memories to check for near-duplicates
  try {
    const results = await httpClient.search(query);
    const duplicates = results.filter((r) => (r.relevance_score ?? 0) > 0.7);

    if (duplicates.length === 0) {
      return {
        executedSearch: true,
        searchQuery: query,
        duplicatesFound: [],
        highestRelevance: results[0]?.relevance_score ?? 0,
        recommendation: 'proceed-store'
      };
    }

    const highestRelevance = Math.max(...duplicates.map((d) => d.relevance_score ?? 0));

    // High relevance duplicates → skip storage
    if (highestRelevance > 0.85) {
      return {
        executedSearch: true,
        searchQuery: query,
        duplicatesFound: duplicates,
        highestRelevance,
        recommendation: 'skip-store',
        warningMessage: `Found highly similar memory (relevance: ${(highestRelevance * 100).toFixed(0)}%). Consider updating existing memory instead.`
      };
    }

    // Medium relevance → review
    if (highestRelevance > 0.7) {
      return {
        executedSearch: true,
        searchQuery: query,
        duplicatesFound: duplicates,
        highestRelevance,
        recommendation: 'review-duplicates',
        warningMessage: `Found potentially related memory (relevance: ${(highestRelevance * 100).toFixed(0)}%). Review before storing.`
      };
    }

    return {
      executedSearch: true,
      searchQuery: query,
      duplicatesFound: duplicates,
      highestRelevance,
      recommendation: 'proceed-store'
    };
  } catch (error) {
    // Graceful fallback: if search fails, allow storage to proceed
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      executedSearch: false,
      searchQuery: query,
      duplicatesFound: [],
      highestRelevance: 0,
      recommendation: 'proceed-store',
      warningMessage: `Duplicate check skipped (search error: ${errorMessage})`
    };
  }
}

/**
 * Attaches automatic duplicate check results to metadata for curator decision-making.
 *
 * @param metadata - Existing metadata.
 * @param checkResult - Result from checkForDuplicatesAutomatically.
 * @returns Updated metadata with curator hints.
 */
export function attachDuplicateCheckResult(
  metadata: JsonObject,
  checkResult: AutomaticDuplicateCheckResult
): JsonObject {
  return {
    ...metadata,
    duplicateCheck: {
      executedSearch: checkResult.executedSearch,
      searchQuery: checkResult.searchQuery,
      highestRelevance: checkResult.highestRelevance,
      recommendation: checkResult.recommendation,
      duplicatesCount: checkResult.duplicatesFound.length,
      warningMessage: checkResult.warningMessage
    }
  };
}
