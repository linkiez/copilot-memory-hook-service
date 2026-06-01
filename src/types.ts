/**
 * Primitive JSON values accepted by the memory service payloads.
 */
export type JsonPrimitive = boolean | null | number | string;

/**
 * JSON array payload.
 */
export type JsonArray = JsonValue[];

/**
 * JSON object payload.
 */
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

/**
 * Any JSON value accepted by the service boundaries.
 */
export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

/**
 * Canonical durable memory categories used by the hook workflow.
 */
export type MemoryCategory = 'preference' | 'project' | 'technical-decision' | 'workflow';

/**
 * Where the active session snapshot was recovered from.
 */
export type SessionStateSource = 'content-fallback' | 'local-cache' | 'remote-metadata' | 'unknown';

/**
 * Generic metadata bag attached to memories and summaries.
 */
export interface MemoryMetadata extends JsonObject {
  category?: string;
  categories?: JsonValue;
  kind?: string;
  session_id?: string;
  session_snapshot?: JsonObject | string;
  source?: string;
}

/**
 * Remote memory record returned by the memory service.
 */
export interface StoredMemory {
  content: string;
  content_hash: string;
  created_at_iso?: string;
  memory_type?: string;
  metadata?: MemoryMetadata;
  tags: string[];
  updated_at_iso?: string;
}

/**
 * Search result item returned by semantic or tag-based queries.
 */
export interface SearchResult {
  memory: StoredMemory;
  relevance_score?: number;
  similarity_score?: number;
}

/**
 * CLI list response from the remote memory service.
 */
export interface MemoryListResponse {
  memories?: StoredMemory[];
}

/**
 * CLI search response from the remote memory service.
 */
export interface MemorySearchResponse {
  results?: SearchResult[];
}

/**
 * Turn persisted in a session summary.
 */
export interface SessionTurn {
  content: string;
  role: string;
}

/**
 * Recall state recorded for the current working session.
 */
export interface RecallState {
  lastRecallAt: string;
  matchedMemoryIds: string[];
  status: 'matched' | 'missing' | 'pending';
}

/**
 * Tool usage record tracked during a hook session.
 */
export interface ToolRecord {
  name: string;
  recordedAt: string;
  sensitive: boolean;
  target: string;
}

/**
 * Subagent invocation captured during a hook session.
 */
export interface SubagentRecord {
  kind: string;
  name: string;
  recordedAt: string;
}

/**
 * Working hook session snapshot persisted between events.
 */
export interface ActiveSession {
  categories: string[];
  id: string;
  keywords: string[];
  promptCount: number;
  prompts: string[];
  recall: RecallState;
  remoteHash?: string;
  startedAt: string;
  stateFallbacks?: string[];
  stateSource?: SessionStateSource;
  subagents: SubagentRecord[];
  tools: ToolRecord[];
  updatedAt: string;
}

/**
 * Structured memory write request issued by the hook runtime.
 */
export interface StructuredMemoryInput {
  content: string;
  conversationId?: string;
  memoryType?: string;
  metadata?: MemoryMetadata;
  tags?: string[];
}

/**
 * Session summary write request issued by the hook runtime.
 */
export interface SessionSummaryInput {
  metadata?: MemoryMetadata;
  sessionId: string;
  tags?: string[];
  turns: SessionTurn[];
}

/**
 * Promoted durable memory record generated from a finalized session.
 */
export interface PromotedMemory {
  categories: string[];
  category: string;
  id: string;
  source: string;
  tags: string[];
  text: string;
  updatedAt: string;
}

/**
 * Tool extraction result derived from a hook payload.
 */
export interface ExtractedTool {
  name: string;
  target: string;
}

/**
 * Generic message item accepted in hook payloads.
 */
export interface HookMessage {
  content?: string;
  role?: string;
}

/**
 * Generic hook payload emitted by the Copilot runtime.
 */
export interface HookPayload extends Record<string, unknown> {
  data?: Record<string, unknown>;
  hookSpecificOutput?: Record<string, unknown>;
  messages?: HookMessage[];
  tool_input?: unknown;
}

/**
 * Runtime configuration used to talk to the remote memory service.
 */
export interface RemoteClient {
  apiKey: string;
  cliPath: string;
  endpoint: string;
  env: NodeJS.ProcessEnv;
  nodePath: string;
  sessionCacheDir: string;
  sessionCacheMaxAgeMs: number;
}

/**
 * Parsed session snapshot recovered from remote content or metadata.
 */
export interface SessionSnapshotParseResult {
  fallbacks: string[];
  snapshot: ActiveSession;
}

/**
 * Generic CLI argument bag.
 */
export type RawCliArguments = Record<string, unknown>;

/**
 * Parsed global CLI options.
 */
export interface CliGlobalOptions {
  apiKey: string;
  endpoint: string;
  insecureTls: boolean;
  timeoutMs: number;
}

/**
 * Parsed CLI invocation.
 */
export interface ParsedCli {
  arguments: RawCliArguments;
  command: string;
  options: CliGlobalOptions;
  showHelp: boolean;
}

/**
 * Environment fallback values loaded from disk.
 */
export interface FallbackEnv {
  MCP_MEMORY_API_KEY?: string;
  MCP_MEMORY_HTTP_ENDPOINT?: string;
}

/**
 * Multipart upload part accepted by the HTTP client.
 */
export type MultipartPart = FileUploadPart | ScalarPart;

/**
 * File upload part used in multipart requests.
 */
export interface FileUploadPart {
  contentType?: string;
  fileName?: string;
  kind: 'file';
  name: string;
  path: string;
}

/**
 * Scalar multipart field.
 */
export interface ScalarPart {
  kind?: 'field';
  name: string;
  value: string | number;
}

/**
 * Base request shape used by the HTTP client.
 */
export interface MemoryHttpRequest {
  accept?: string;
  jsonBody?: JsonValue | Record<string, unknown>;
  method?: string;
  multipart?: MultipartPart[];
  path: string;
  query?: Record<string, unknown>;
  responseType?: 'json' | 'text';
  scope?: 'api' | 'root';
}

/**
 * Stream response returned by server-sent event endpoints.
 */
export interface StreamResponse {
  contentType: string;
  stream: NodeJS.ReadableStream;
}

/**
 * Error raised when the memory service responds with a failing status.
 */
export class MemoryHttpError extends Error {
  public readonly body: unknown;
  public readonly statusCode: number;

  public constructor(message: string, statusCode: number, body: unknown) {
    super(message);
    this.body = body;
    this.name = 'MemoryHttpError';
    this.statusCode = statusCode;
  }
}
