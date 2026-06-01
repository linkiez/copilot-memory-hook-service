const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const DEFAULT_TIMEOUT_MS = 10_000;

class MemoryHttpClient {
  constructor(options) {
    this.endpoint = normalizeEndpoint(options.endpoint);
    this.apiBase = deriveApiBase(this.endpoint);
    this.rootBase = deriveRootBase(this.endpoint);
    this.apiKey = options.apiKey || '';
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.insecureTls = Boolean(options.insecureTls);
  }

  async requestJson(request) {
    return this.request({ ...request, responseType: 'json' });
  }

  async requestText(request) {
    return this.request({ ...request, responseType: 'text' });
  }

  async requestStream(request) {
    const response = await this.fetchResponse({ ...request, accept: 'text/event-stream' });
    if (!response.body) {
      throw new Error('Response stream is not available.');
    }

    return {
      stream: Readable.fromWeb(response.body),
      contentType: response.headers.get('content-type') || 'application/octet-stream'
    };
  }

  async request(request) {
    const response = await this.fetchResponse(request);
    if (request.responseType === 'text') {
      return response.text();
    }

    const responseText = await response.text();
    if (!responseText) {
      return {};
    }

    try {
      return JSON.parse(responseText);
    } catch (error) {
      throw new Error(`Invalid JSON response: ${error.message}`);
    }
  }

  async fetchResponse(request) {
    const scope = request.scope || 'api';
    const url = buildUrl({
      baseUrl: scope === 'root' ? this.rootBase : this.apiBase,
      pathname: request.path,
      query: request.query
    });
    const headers = new Headers();
    const init = {
      method: request.method || 'GET',
      headers,
      signal: AbortSignal.timeout(this.timeoutMs)
    };

    if (this.apiKey) {
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

    const response = await fetch(url, {
      ...init,
      dispatcher: undefined,
      agent: undefined
    });

    if (!response.ok) {
      throw await buildHttpError(response);
    }

    return response;
  }
}

function buildFormData(parts) {
  const formData = new FormData();
  for (const part of parts) {
    if (part === null || part === undefined) {
      continue;
    }

    if (part.kind === 'file') {
      const filePath = path.resolve(part.path);
      const fileName = part.fileName || path.basename(filePath);
      const fileBuffer = fs.readFileSync(filePath);
      const blob = new Blob([fileBuffer], { type: part.contentType || 'application/octet-stream' });
      formData.append(part.name, blob, fileName);
      continue;
    }

    formData.append(part.name, String(part.value));
  }

  return formData;
}

async function buildHttpError(response) {
  const responseText = await response.text();
  if (!responseText) {
    return createHttpError(`HTTP request failed with status ${response.status}`, response.status, {});
  }

  try {
    const parsed = JSON.parse(responseText);
    return createHttpError(parsed.message || parsed.detail || `HTTP request failed with status ${response.status}`, response.status, parsed);
  } catch {
    return createHttpError(responseText, response.status, responseText);
  }
}

function createHttpError(message, statusCode, body) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.body = body;
  return error;
}

function buildUrl({ baseUrl, pathname, query }) {
  const url = new URL(stripLeadingSlash(pathname), ensureTrailingSlash(baseUrl));
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url;
}

function normalizeEndpoint(endpoint) {
  if (!endpoint) {
    return '';
  }

  return String(endpoint).replace(/\/+$/, '');
}

function deriveApiBase(endpoint) {
  if (!endpoint) {
    return '';
  }

  return endpoint.endsWith('/api') ? endpoint : `${endpoint}/api`;
}

function deriveRootBase(endpoint) {
  if (!endpoint) {
    return '';
  }

  return endpoint.endsWith('/api') ? endpoint.slice(0, -4) || endpoint : endpoint;
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function stripLeadingSlash(value) {
  return String(value || '').replace(/^\/+/, '');
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MemoryHttpClient
};