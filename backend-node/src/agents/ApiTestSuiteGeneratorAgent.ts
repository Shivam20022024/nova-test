import { ApiStep, ApiAssertion } from './ApiExecutionAgent';
import { parseOpenApiDocument, OpenApiEndpoint } from '../lib/openApiIntrospection';

/**
 * Sibling to DbTestSuiteGeneratorAgent — but unlike a database schema (which
 * has to be described to an LLM in prose and reasoned over), an OpenAPI spec
 * is already fully structured JSON/YAML. Endpoints, parameters, and response
 * fields can be parsed directly with zero ambiguity, so this generator is
 * entirely deterministic — no LLM call, no hallucination surface. Steps land
 * in the same editable Manual Request Builder as every other generation path
 * — never auto-executed.
 *
 * Only GET endpoints are auto-generated. Write endpoints (POST/PUT/PATCH/
 * DELETE) have no rollback safety net the way DB writes do, so a generated
 * negative test could actually mutate real data — they're left out entirely
 * and must be added manually.
 */
function buildFunctionalStep(ep: OpenApiEndpoint): ApiStep {
  const assertions: ApiAssertion[] = [{ type: 'status', operator: 'equals', expected: ep.successStatus }];
  // A list endpoint's documented fields live on each array element, not the
  // response root — "[0].field" targets the first item so the check still
  // holds even against an empty array's sibling non-empty runs.
  const pathPrefix = ep.responseIsArray ? '[0].' : '';
  for (const prop of ep.responseProperties) {
    assertions.push({ type: 'jsonPath', path: `${pathPrefix}${prop}`, operator: 'exists' });
  }
  // Required query params aren't part of ep.url (only path params are
  // templated in) — append them as {{paramName}} placeholders so the
  // happy-path step is genuinely complete, resolvable via Environment
  // Variables at run time, same convention as path params.
  const requiredQueryParams = ep.parameters.filter((p) => p.in === 'query' && p.required);
  const url = requiredQueryParams.length > 0
    ? `${ep.url}?${requiredQueryParams.map((p) => `${p.name}={{${p.name}}}`).join('&')}`
    : ep.url;
  return {
    method: 'GET',
    url,
    scenarioName: `[FUNCTIONAL] ${ep.summary}`,
    assertions,
  };
}

function buildNegativeSteps(ep: OpenApiEndpoint): ApiStep[] {
  const steps: ApiStep[] = [];
  for (const param of ep.parameters) {
    if (!param.required) continue;
    if (param.in === 'path') {
      const url = ep.url.replace(`{{${param.name}}}`, '');
      steps.push({
        method: 'GET',
        url,
        scenarioName: `[NEGATIVE] ${ep.summary} — missing required path param "${param.name}" (expected status is a starting point, verify against actual API behavior)`,
        assertions: [{ type: 'status', operator: 'equals', expected: 404 }],
      });
    } else {
      // Query param omission — the URL never had it templated in, so the
      // "negative" case is simply calling without ever supplying it. There's
      // nothing to strip from ep.url; document intent via scenario naming
      // and let the user add the param manually to the positive-path variant
      // if their functional step needs one.
      steps.push({
        method: 'GET',
        url: ep.url,
        scenarioName: `[NEGATIVE] ${ep.summary} — missing required query param "${param.name}" (expected status is a starting point, verify against actual API behavior)`,
        assertions: [{ type: 'status', operator: 'equals', expected: 400 }],
      });
    }
  }
  return steps;
}

export class ApiTestSuiteGeneratorAgent {
  generateSuiteFromOpenApi(specContent: string): ApiStep[] {
    const endpoints = parseOpenApiDocument(specContent).filter((ep) => ep.method === 'GET');
    if (endpoints.length === 0) {
      throw new Error('NO_GET_ENDPOINTS: This spec has no GET endpoints to auto-generate read-only tests from. Write endpoints must be added manually.');
    }

    const steps: ApiStep[] = [];
    for (const ep of endpoints) {
      steps.push(buildFunctionalStep(ep));
      steps.push(...buildNegativeSteps(ep));
    }
    return steps;
  }
}
