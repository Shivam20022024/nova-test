/**
 * When a selector matches several elements, `.first()` silently picks whichever comes first in
 * the DOM - often a hidden twin, a background element behind an open dialog, or a tab instead of
 * the submit button. This ranks the candidates instead (generic, no site-specific rules):
 *   1. visible beats hidden
 *   2. if a modal dialog is open, elements inside it beat elements behind it
 *   3. submit controls beat other buttons
 *   4. otherwise DOM order
 */
export interface BestMatch {
  index: number;
  count: number;
  visibleCount: number;
  reason: string;
}

export async function pickBestMatch(all: any): Promise<BestMatch | null> {
  const count = await all.count();
  if (count < 2) return null;
  const info: { vis: boolean; inDialog: boolean; submit: boolean; dialogOpen: boolean }[] = await all.evaluateAll((nodes: Element[]) => {
    const openDialog = Array.from(document.querySelectorAll('[role="dialog"],dialog[open],[aria-modal="true"]')).some((d) => {
      const r = (d as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    return nodes.map((n) => {
      const el = n as HTMLElement;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        vis: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
        inDialog: !!el.closest('[role="dialog"],dialog,[aria-modal="true"]'),
        submit: el.getAttribute('type') === 'submit',
        dialogOpen: openDialog,
      };
    });
  });

  const visible = info.map((x, i) => ({ ...x, i })).filter((x) => x.vis);
  const pool = visible.length > 0 ? visible : info.map((x, i) => ({ ...x, i }));
  let reason = visible.length > 0 ? 'first visible' : 'first (none visible)';
  let chosen = pool;
  if (pool.some((x) => x.dialogOpen) && pool.some((x) => x.inDialog)) {
    chosen = pool.filter((x) => x.inDialog);
    reason = 'inside the open dialog';
  }
  const submits = chosen.filter((x) => x.submit);
  if (submits.length > 0 && submits.length < chosen.length) {
    chosen = submits;
    reason = reason + ', submit control';
  }
  const pick = chosen[0] ?? pool[0];
  if (!pick) return null;
  return { index: pick.i, count, visibleCount: visible.length, reason };
}
