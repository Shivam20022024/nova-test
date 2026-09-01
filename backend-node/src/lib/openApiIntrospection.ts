import { parse as parseYaml } from 'yaml';

/**
 * Shared low-level OpenAPI/Swagger walker. ApiSpecImportAgent's 1:1 import
 * uses this for its bare method/url/status extraction; ApiTestSuiteGeneratorAgent
 * uses the richer parameters/responseProperties fields to build functional and
 * negative checks deterministically — no LLM involved, since an OpenAPI spec is
 * already fully structured data with no ambiguity to resolve.
 */
export interface OpenApiParameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
}

export interface OpenApiEndpoint {
  method: string; // uppercase
  pathTemplate: string; // raw spec path, e.g. /pets/{id}
  url: string; // baseUrl + path with {id} -> {{id}}
  summary: string;
  successStatus: number;
  parameters: OpenApiParameter[];
  requestBody?: any;
  responseProperties: string[];
  // True when the documented success response is a JSON array (e.g. a list
  // endpoint) rather than a single object — callers building jsonPath
  // assertions against responseProperties need to target array elements
  // ("[0].field") rather than the response root ("field") in that case.
  responseIsArray: boolean;
}

function resolveResponseProperties(op: any): { properties: string[]; isArray: boolean } {
  const successEntry = Object.entries<any>(op.responses || {}).find(([code]) => code.startsWith('2'));
  const schema = successEntry?.[1]?.content?.['application/json']?.schema;
  if (!schema) return { properties: [], isArray: false };
  const isArray = schema.type === 'array';
  const target = isArray ? schema.items : schema;
  if (target?.properties && typeof target.properties === 'object') {
    return { properties: Object.keys(target.properties), isArray };
  }
  return { properties: [], isArray };
}

function resolveOpenApiExampleBody(reqBody: any): any {
  if (!reqBody) return undefined;
  const content = reqBody.content?.['application/json'];
  if (!content) return undefined;
  if (content.example !== undefined) return content.example;
  if (content.examples) {
    const first = Object.values(content.examples)[0] as any;
    if (first?.value !== undefined) return first.value;
  }
  const schema = content.schema;
  if (schema?.example !== undefined) return schema.example;
  if (schema?.type === 'object' && schema.properties) {
    const out: Record<string, any> = {};
    for (const [key, prop] of Object.entries<any>(schema.properties)) {
      out[key] = prop.example ?? (prop.type === 'string' ? 'string' : prop.type === 'integer' || prop.type === 'number' ? 0 : prop.type === 'boolean' ? true : undefined);
    }
    return out;
  }
  return undefined;
}

export function parseOpenApiDocument(content: string): OpenApiEndpoint[] {
  const trimmed = content.trim();
  const spec = trimmed.startsWith('{') ? JSON.parse(content) : parseYaml(content);

  const baseUrl = (spec.servers && spec.servers[0]?.url) || '';
  const paths = spec.paths || {};
  const out: OpenApiEndpoint[] = [];

  for (const [pathKey, pathItem] of Object.entries<any>(paths)) {
    const pathLevelParams: any[] = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = pathItem[method];
      if (!op) continue;

      const resolvedPath = pathKey.replace(/\{(\w+)\}/g, (_: string, name: string) => `{{${name}}}`);
      const url = `${baseUrl}${resolvedPath}`;

      const successCode = Object.keys(op.responses || {}).find((code) => code.startsWith('2'));

      const rawParams = [...pathLevelParams, ...(Array.isArray(op.parameters) ? op.parameters : [])];
      const parameters: OpenApiParameter[] = rawParams
        .filter((p: any) => p.in === 'path' || p.in === 'query')
        .map((p: any) => ({ name: p.name, in: p.in, required: !!p.required || p.in === 'path' }));

      const { properties, isArray } = resolveResponseProperties(op);
      out.push({
        method: method.toUpperCase(),
        pathTemplate: pathKey,
        url,
        summary: op.summary || op.operationId || `${method.toUpperCase()} ${pathKey}`,
        successStatus: successCode ? parseInt(successCode, 10) : 200,
        parameters,
        requestBody: resolveOpenApiExampleBody(op.requestBody),
        responseProperties: properties,
        responseIsArray: isArray,
      });
    }
  }

  if (out.length === 0) {
    throw new Error('EMPTY_OPENAPI_SPEC: No operations found under any path.');
  }
  return out;
}
