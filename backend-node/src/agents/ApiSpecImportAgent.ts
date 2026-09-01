import { ApiStep, ApiAssertion } from './ApiExecutionAgent';
import { parseOpenApiDocument } from '../lib/openApiIntrospection';

/**
 * Converts an existing API spec (OpenAPI/Swagger, Postman collection, or a
 * single cURL command) into the ApiStep[] JSON schema consumed by
 * ApiExecutionAgent — the same format produced by ApiScriptGenerationAgent's
 * NL generation and by the manual request builder, so every downstream
 * consumer (worker, reporting, frontend builder) needs zero changes.
 */
export type ApiSpecType = 'openapi' | 'postman' | 'curl';

function defaultStatusAssertion(expected: number): ApiAssertion[] {
  return [{ type: 'status', operator: 'equals', expected }];
}

// ---------- cURL ----------

function parseCurl(content: string): ApiStep[] {
  const cmd = content.trim().replace(/\\\r?\n/g, ' ').replace(/^curl\s+/i, '');

  // Tokenize respecting single/double quotes.
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  }

  let method = 'GET';
  let url = '';
  const headers: Record<string, string> = {};
  let body: any = undefined;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] || '';
    if ((tok === '-X' || tok === '--request') && tokens[i + 1]) {
      method = (tokens[++i] || '').toUpperCase();
    } else if ((tok === '-H' || tok === '--header') && tokens[i + 1]) {
      const headerLine = tokens[++i] || '';
      const idx = headerLine.indexOf(':');
      if (idx > -1) {
        headers[headerLine.substring(0, idx).trim()] = headerLine.substring(idx + 1).trim();
      }
    } else if ((tok === '-d' || tok === '--data' || tok === '--data-raw' || tok === '--data-binary') && tokens[i + 1]) {
      const raw = tokens[++i] || '';
      try { body = JSON.parse(raw); } catch { body = raw; }
      if (method === 'GET') method = 'POST'; // curl -d implies POST unless -X specified
    } else if (tok === '-u' || tok === '--user') {
      i++; // skip credentials token; not mapped to a header automatically
    } else if (!tok.startsWith('-') && !url) {
      url = tok;
    }
  }

  if (!url) throw new Error('EMPTY_CURL_SPEC: Could not find a URL in the cURL command.');

  const step: ApiStep = {
    method: method as ApiStep['method'],
    url,
    scenarioName: 'Imported cURL Request',
    assertions: defaultStatusAssertion(200),
  };
  if (Object.keys(headers).length > 0) step.headers = headers;
  if (body !== undefined) step.body = body;
  return [step];
}

// ---------- Postman Collection ----------

function resolvePostmanUrl(urlField: any): string {
  if (typeof urlField === 'string') return urlField;
  if (urlField?.raw) return urlField.raw;
  return '';
}

function resolvePostmanBody(bodyField: any): any {
  if (!bodyField) return undefined;
  if (bodyField.mode === 'raw' && bodyField.raw) {
    try { return JSON.parse(bodyField.raw); } catch { return bodyField.raw; }
  }
  if (bodyField.mode === 'urlencoded' && Array.isArray(bodyField.urlencoded)) {
    const out: Record<string, string> = {};
    bodyField.urlencoded.forEach((p: any) => { if (p.key) out[p.key] = p.value; });
    return out;
  }
  return undefined;
}

function walkPostmanItems(items: any[], scenarioPrefix: string, out: ApiStep[]) {
  for (const item of items || []) {
    if (Array.isArray(item.item)) {
      // Folder — recurse, carrying the folder name into scenario names for context.
      walkPostmanItems(item.item, scenarioPrefix ? `${scenarioPrefix} / ${item.name}` : item.name, out);
      continue;
    }
    const req = item.request;
    if (!req) continue;
    const method = (typeof req.method === 'string' ? req.method : 'GET').toUpperCase();
    const url = resolvePostmanUrl(req.url);
    if (!url) continue;

    const headers: Record<string, string> = {};
    (req.header || []).forEach((h: any) => {
      if (h.key && !h.disabled) headers[h.key] = h.value;
    });

    const step: ApiStep = {
      method: method as ApiStep['method'],
      url,
      scenarioName: scenarioPrefix ? `${scenarioPrefix} / ${item.name}` : item.name,
      assertions: defaultStatusAssertion(200),
    };
    if (Object.keys(headers).length > 0) step.headers = headers;
    const resolvedBody = resolvePostmanBody(req.body);
    if (resolvedBody !== undefined) step.body = resolvedBody;
    out.push(step);
  }
}

function parsePostman(content: string): ApiStep[] {
  const collection = JSON.parse(content);
  const items = collection.item || collection.items;
  if (!Array.isArray(items)) {
    throw new Error('INVALID_POSTMAN_SPEC: Could not find an "item" array in the collection.');
  }
  const out: ApiStep[] = [];
  walkPostmanItems(items, '', out);
  if (out.length === 0) {
    throw new Error('EMPTY_POSTMAN_SPEC: Collection contained no requests.');
  }
  return out;
}

// ---------- OpenAPI / Swagger ----------

function parseOpenApi(content: string): ApiStep[] {
  const endpoints = parseOpenApiDocument(content);
  return endpoints.map((ep) => {
    const headers: Record<string, string> = {};
    let body: any;
    if (ep.requestBody !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = ep.requestBody;
    }
    const step: ApiStep = {
      method: ep.method as ApiStep['method'],
      url: ep.url,
      scenarioName: ep.summary,
      assertions: defaultStatusAssertion(ep.successStatus),
    };
    if (Object.keys(headers).length > 0) step.headers = headers;
    if (body !== undefined) step.body = body;
    return step;
  });
}

export class ApiSpecImportAgent {
  importSpec(specType: ApiSpecType, content: string): ApiStep[] {
    if (!content || !content.trim()) {
      throw new Error('EMPTY_SPEC_CONTENT: No spec content provided.');
    }
    switch (specType) {
      case 'curl':
        return parseCurl(content);
      case 'postman':
        return parsePostman(content);
      case 'openapi':
        return parseOpenApi(content);
      default:
        throw new Error(`UNSUPPORTED_SPEC_TYPE: ${specType}`);
    }
  }
}
