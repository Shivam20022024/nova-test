import { supabase } from './storage';

/**
 * Writes a healed selector back into the saved TestRun.steps so the SAME
 * fix is already in place the next time this test runs, instead of the
 * AI re-discovering it from scratch on every run. This is the one piece of
 * "AutoHeal" that used to require a human to click Approve — now it runs
 * automatically the moment a heal is applied and the step it fixed goes on
 * to pass (see executionWorker.ts), matching the rest of AutoHeal's
 * already-automatic behavior. Was previously duplicated inline in
 * routes/healing.ts's POST /:id/approve handler; that handler is gone, this
 * is the one copy.
 *
 * Returns true if a matching step was actually found and updated, false if
 * there was nothing to persist to (e.g. an ad-hoc run with no saved
 * TestRun) — callers use this to record an honest audit trail rather than
 * claiming a save that didn't happen.
 */
export async function applyHealedSelectorToTestRun(params: {
  suiteId?: string | null;
  testName?: string | null;
  stepIndex?: number | null;
  originalSelector: string;
  healedSelector: string;
}): Promise<boolean> {
  const { suiteId, testName, stepIndex, originalSelector, healedSelector } = params;
  if (!suiteId || !testName || !originalSelector || !healedSelector) return false;

  const { data: testRun, error: testRunErr } = await supabase
    .from('TestRun')
    .select('*')
    .eq('suiteId', suiteId)
    .eq('name', testName)
    .maybeSingle();
  if (testRunErr) throw testRunErr;
  if (!testRun) return false;

  let steps: any[] = [];
  try {
    steps = JSON.parse(testRun.steps);
  } catch (e) {
    return false;
  }

  // stepIndex is 1-based (see the Python-side step numbering it originated
  // from) — try the exact step first, then fall back to matching the
  // selector anywhere in the test (the same two-tier search the old
  // approve handler did).
  let updated = false;
  if (stepIndex && steps.length >= stepIndex) {
    const stepToUpdate = steps[stepIndex - 1];
    if (stepToUpdate && stepToUpdate.selector === originalSelector) {
      stepToUpdate.selector = healedSelector;
      updated = true;
    }
  }
  if (!updated) {
    for (const step of steps) {
      if (step.selector === originalSelector) {
        step.selector = healedSelector;
        updated = true;
      }
    }
  }
  if (!updated) return false;

  const { error: updateErr } = await supabase
    .from('TestRun')
    .update({ steps: JSON.stringify(steps) })
    .eq('id', testRun.id);
  if (updateErr) throw updateErr;
  return true;
}
