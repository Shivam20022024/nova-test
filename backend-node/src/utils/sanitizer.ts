export function resolveSelector(sel: string, logMsg?: (msg: string) => void): string {
  if (!sel) return sel;
  
  let sanitized = sel;

  const fixAttribute = (prefix: string, attrName: string, isId: boolean = false) => {
    if (sel.startsWith(prefix + '="') || sel.startsWith(prefix + "='")) {
      const match = sel.match(new RegExp(`${prefix}=["'](.*?)["']`));
      if (match && match[1]) sanitized = isId ? `#${match[1]}` : `[${attrName}="${match[1]}"]`;
    } else if (sel.startsWith(prefix + '=')) {
      const val = sel.replace(prefix + '=', '').replace(/["']/g, '');
      sanitized = isId ? `#${val}` : `[${attrName}="${val}"]`;
    }
  };

  fixAttribute('data-test', 'data-test');
  fixAttribute('data-testid', 'data-testid');
  fixAttribute('name', 'name');
  fixAttribute('placeholder', 'placeholder');
  fixAttribute('type', 'type');
  fixAttribute('id', 'id', true);
  
  if (sel.startsWith('//') || sel.startsWith('(/')) {
    sanitized = `xpath=${sel}`;
  }

  // Reject malformed selectors
  if (sanitized.startsWith('=')) return '';
  if (sanitized.includes('""')) sanitized = sanitized.replace(/""/g, '"');

  if (sel !== sanitized && logMsg) {
    logMsg(`[Sanitizer] ORIGINAL selector: ${sel} -> SANITIZED selector: ${sanitized}`);
  }

  return sanitized;
}

export function sanitizeExecutionPlan(scriptCode: string, logMsg?: (msg: string) => void): string {
  try {
    const plan = JSON.parse(scriptCode);
    if (!Array.isArray(plan)) return scriptCode;

    const sanitizedPlan = plan.map((action: any) => {
      if (action.selector) {
        action.selector = resolveSelector(action.selector, logMsg);
      }
      return action;
    });

    return JSON.stringify(sanitizedPlan);
  } catch (err) {
    if (logMsg) logMsg(`[Sanitizer] Failed to parse/sanitize execution plan: ${err}`);
    return scriptCode;
  }
}
