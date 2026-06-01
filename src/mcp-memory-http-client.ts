import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { MemoryHttpError, type MemoryHttpRequest, type MultipartPart, type StreamResponse } from './types.js';

/**
 * Default request timeout used by the memory HTTP client.
 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Constructor options for the memory HTTP client.
 */
export interface MemoryHttpClientOptions {
  apiKey?: string;
  endpoint?: string;
  insecureTls?: boolean;
  timeoutMs?: number;
}

/**
 * HTTP client wrapper for the remote memory service.
 */
export class MemoryHttpClient {
  public readonly apiBase: string;
  public readonly apiKey: string;
  public readonly endpoint: string;
  public readonly insecureTls: boolean;
  public readonly rootBase: string;
  public readonly timeoutMs: number;

  public constructor(options: MemoryHttpClientOptions) {
    this.endpoint = normalizeEndpoint(options.endpoint);
    this.apiBase = deriveApiBase(this.endpoint);
    this.rootBase = deriveRootBase(this.endpoint);
    this.apiKey = options.apiKey ?? '';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.insecureTls = Boolean(options.insecureTls);
  }

  /**
   * Executes a request expecting a JSON payload.
   *
   * @param request - Request definition.
   * @returns Parsed JSON response.
   */
  public async requestJson<T>(request: MemoryHttpRequest): Promise<T> {
    return this.request<T>({ ...request, responseType: 'json' });
  }

  /**
   * Executes a request expecting plain text.
   *
   * @param request - Request definition.
   * @returns Raw response text.
   */
  public async requestText(request: MemoryHttpRequest): Promise<string> {
    return this.request<string>({ ...request, responseType: 'text' });
  }

  /**
   * Executes a request expecting a readable stream.
   *
   * @param request - Request definition.
   * @returns Stream and content type information.
   */
  public async requestStream(request: MemoryHttpRequest): Promise<StreamResponse> {
    const response = await this.fetchResponse({ ...request, accept: 'text/event-stream' });
    if (!response.body) {
      throw new Error('Response stream is not available.');
    }

    return {
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      stream: Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
    };
  }

  private async request<T>(request: MemoryHttpRequest): Promise<T> {
    const response = await this.fetchResponse(request);
    if (request.responseType === 'text') {
      return await response.text() as T;
    }

    const responseText = await response.text();
    if (responseText.length === 0) {
      return {} as T;
    }

    try {
      return JSON.parse(responseText) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown JSON parsing error';
      throw new Error(`Invalid JSON response: ${message}`);
    }
  }

  private async fetchResponse(request: MemoryHttpRequest): Promise<Response> {
    const scope = request.scope ?? 'api';
    const url = buildUrl(
      request.query === undefined
        ? {
            baseUrl: scope === 'root' ? this.rootBase : this.apiBase,
            pathname: request.path
          }
        : {
            baseUrl: scope === 'root' ? this.rootBase : this.apiBase,
            pathname: request.path,
            query: request.query
          }
    );
    const headers = new Headers();
    const init: RequestInit = {
      headers,
      method: request.method ?? 'GET',
      signal: AbortSignal.timeout(this.timeoutMs)
    };

    if (this.apiKey.length > 0) {
      headers.set('Authorization', `Bearer ${this.apiKey}`);
    }

    if (request.accept) {
      headers.set('Accept', request.accept);
    } else {
      headers.set('Accept', request.responseType === 'text' ? 'text/plain, application/json' : 'application/json');
    }

    if (request.jsonBody !== undefined) {
      headers.set('Content-Type', 'application/json');
      init.body = JSON.stringify(request.jsonBody);
    } else if (request.multipart) {
      init.body = buildFormData(request.multipart);
    }

    const response = await fetch(url, init);
    if (!response.ok) {
      throw await buildHttpError(response);
    }

    return response;
  }
}

function buildFormData(parts: MultipartPart[]): FormData {
  const formData = new FormData();
  for (const part of parts) {
    if ('kind' in part && part.kind === 'file') {
      const filePath = path.resolve(part.path);
      const fileName = part.fileName ?? path.basename(filePath);
      const fileBuffer = fs.readFileSync(filePath);
      const blob = new Blob([fileBuffer], { type: part.contentType ?? 'application/octet-stream' });
      formData.append(part.name, blob, fileName);
      continue;
    }

    formData.append(part.name, String(part.value));
  }

  return formData;
}

async function buildHttpError(response: Response): Promise<MemoryHttpError> {
  const responseText = await response.text();
  if (responseText.length === 0) {
    return new MemoryHttpError(`HTTP request failed with status ${response.status}`, response.status, {});
  }

  try {
    const parsed = JSON.parse(responseText) as { detail?: string; message?: string };
    return new MemoryHttpError(parsed.message ?? parsed.detail ?? `HTTP request failed with status ${response.status}`, response.status, parsed);
  } catch {
    return new MemoryHttpError(responseText, response.status, responseText);
  }
}

function buildUrl(input: {
  baseUrl: string;
  pathname: string;
  query?: Record<string, unknown>;
}): URL {
  const url = new URL(stripLeadingSlash(input.pathname), ensureTrailingSlash(input.baseUrl));
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new TypeError(`Query parameter ${key} must be a scalar value.`);
    }

    url.searchParams.set(key, String(value));
  }

  return url;
}

function normalizeEndpoint(endpoint?: string): string {
  if (!endpoint) {
    return '';
  }

  return endpoint.replace(/\/+$/u, '');
}

function deriveApiBase(endpoint: string): string {
  if (endpoint.length === 0) {
    return '';
  }

  return endpoint.endsWith('/api') ? endpoint : `${endpoint}/api`;
}

function deriveRootBase(endpoint: string): string {
  if (endpoint.length === 0) {
    return '';
  }

  return endpoint.endsWith('/api') ? endpoint.slice(0, -4) || endpoint : endpoint;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function stripLeadingSlash(value: string): string {
  return value.replace(/^\/+/, '');
}