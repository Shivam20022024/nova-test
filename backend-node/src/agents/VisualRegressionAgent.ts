import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { supabase } from '../utils/storage';

export const visualRegressionSchema = z.object({
  hasVisualBugs: z.boolean(),
  issues: z.array(z.string())
});

export type VisualBaselineResult = {
  hasBaseline: boolean;
  baselineUrl?: string;
  currentUrl?: string;
  diffUrl?: string;
  diffPercent?: number;
  mismatchedPixels?: number;
  totalPixels?: number;
  passed?: boolean;
  error?: string;
};

// Reuses the SAME Supabase Storage bucket every other screenshot already
// uploads to ('screenshots') under its own path prefix, rather than
// provisioning a new bucket — one less manual setup step, and one less
// place cloud-storage config can silently diverge.
const BASELINE_BUCKET = 'screenshots';
const BASELINE_PREFIX = 'visual-baselines';
// How much of the image is allowed to differ before this is treated as a
// real regression rather than render noise (anti-aliasing, font hinting,
// a blinking cursor). Generous on purpose for a first version — false
// positives erode trust in a check faster than a missed true positive does.
const DIFF_THRESHOLD_PERCENT = 0.5;

function safeBaselineKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 180) || 'untitled';
}

export class VisualRegressionAgent {
  constructor(private executionId?: string) {}

  /**
   * Compares `currentPng` against the saved baseline for `key` (stable per
   * TEST, not per execution — e.g. "<testName>::<targetUrl>" — so every run
   * of the same test lands on the same baseline). The first time a key is
   * seen there is nothing to compare against, so that screenshot simply
   * BECOMES the baseline and `hasBaseline` comes back false — that is not a
   * failure, just "ground truth established." A dimension mismatch (viewport
   * or layout changed) is reported honestly rather than diffed, since
   * pixelmatch requires identical width/height. Never throws: any storage or
   * decoding failure comes back as `{ hasBaseline: false, error }` so a test
   * that opts into this never fails for a reason unrelated to its own steps.
   */
  async compareAgainstBaseline(key: string, currentPng: Buffer): Promise<VisualBaselineResult> {
    const safeKey = safeBaselineKey(key);
    const baselinePath = `${BASELINE_PREFIX}/${safeKey}/baseline.png`;
    const currentPath = `${BASELINE_PREFIX}/${safeKey}/${Date.now()}.png`;

    try {
      const { error: currentUploadError } = await supabase.storage.from(BASELINE_BUCKET).upload(currentPath, currentPng, { contentType: 'image/png', upsert: true });
      if (currentUploadError) {
        // Storage itself is unavailable (quota, outage, misconfigured
        // bucket) — report that plainly rather than silently falling
        // through to "no baseline yet", which would hide a real problem
        // behind a normal-looking first-run message.
        return { hasBaseline: false, error: `Could not upload screenshot to storage: ${currentUploadError.message}` };
      }
      const { data: currentPublic } = supabase.storage.from(BASELINE_BUCKET).getPublicUrl(currentPath);

      const { data: existingBaseline, error: downloadError } = await supabase.storage.from(BASELINE_BUCKET).download(baselinePath);

      // A missing-object error means "no baseline yet" (expected on a
      // test's first run) — any OTHER download error (network, permission,
      // quota) is a real failure and must not be treated the same way.
      const baselineMissing = downloadError && /not.?found/i.test((downloadError as any).message || '');
      if (downloadError && !baselineMissing) {
        return { hasBaseline: false, currentUrl: currentPublic?.publicUrl, error: `Could not read baseline from storage: ${downloadError.message}` };
      }

      if (!existingBaseline) {
        const { error: baselineUploadError } = await supabase.storage.from(BASELINE_BUCKET).upload(baselinePath, currentPng, { contentType: 'image/png', upsert: true });
        if (baselineUploadError) {
          return { hasBaseline: false, currentUrl: currentPublic?.publicUrl, error: `Could not save new baseline to storage: ${baselineUploadError.message}` };
        }
        return { hasBaseline: false, currentUrl: currentPublic?.publicUrl };
      }

      const baselineBuffer = Buffer.from(await existingBaseline.arrayBuffer());
      const baselinePng = PNG.sync.read(baselineBuffer);
      const currentPngDecoded = PNG.sync.read(currentPng);
      const { data: baselinePublic } = supabase.storage.from(BASELINE_BUCKET).getPublicUrl(baselinePath);

      if (baselinePng.width !== currentPngDecoded.width || baselinePng.height !== currentPngDecoded.height) {
        return {
          hasBaseline: true, baselineUrl: baselinePublic?.publicUrl, currentUrl: currentPublic?.publicUrl,
          error: `Screenshot dimensions changed (baseline ${baselinePng.width}x${baselinePng.height} vs current ${currentPngDecoded.width}x${currentPngDecoded.height}) — cannot pixel-diff.`,
        };
      }

      const { width, height } = baselinePng;
      const diffPng = new PNG({ width, height });
      const mismatchedPixels = pixelmatch(baselinePng.data, currentPngDecoded.data, diffPng.data, width, height, { threshold: 0.1 });
      const totalPixels = width * height;
      const diffPercent = Math.round((mismatchedPixels / totalPixels) * 10000) / 100;
      const passed = diffPercent <= DIFF_THRESHOLD_PERCENT;

      const diffPath = `${BASELINE_PREFIX}/${safeKey}/diff-${Date.now()}.png`;
      await supabase.storage.from(BASELINE_BUCKET).upload(diffPath, PNG.sync.write(diffPng), { contentType: 'image/png', upsert: true });
      const { data: diffPublic } = supabase.storage.from(BASELINE_BUCKET).getPublicUrl(diffPath);

      return {
        hasBaseline: true, baselineUrl: baselinePublic?.publicUrl, currentUrl: currentPublic?.publicUrl,
        diffUrl: diffPublic?.publicUrl, diffPercent, mismatchedPixels, totalPixels, passed,
      };
    } catch (e: any) {
      return { hasBaseline: false, error: `Visual baseline comparison failed: ${e.message}` };
    }
  }

  async analyzeScreenshot(base64Image: string): Promise<{ hasVisualBugs: boolean, issues: string[] }> {
    const model = new ChatOpenAI({
      modelName: 'gpt-4o',
      temperature: 0.2,
      openAIApiKey: process.env.OPENAI_API_KEY || 'mock-key',
    });
    
    const structuredModel = model.withStructuredOutput(visualRegressionSchema, { name: "VisualRegression" });

    const prompt = `You are an expert QA automation engineer specializing in visual regression testing.
Please analyze the provided screenshot of a web application and identify any obvious visual bugs.
Look for:
- Overlapping text or buttons
- Broken CSS (unrendered styles, massive unstyled lists)
- Severe color contrast issues (e.g., white text on white background)
- Elements clipping off the screen
- Popups or overlays that incorrectly block the main UI

Return hasVisualBugs=true if any issues are found, and list them in the 'issues' array.`;

    const message = {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } }
      ]
    };

    console.log(`[VisualRegressionAgent] Analyzing screenshot for visual bugs...`);
    
    try {
      const response = await structuredModel.invoke([message as any]);
      return response as { hasVisualBugs: boolean, issues: string[] };
    } catch (err) {
      console.error(`[VisualRegressionAgent] Failed to analyze image:`, err);
      return { hasVisualBugs: false, issues: ['AI Analysis Failed'] };
    }
  }
}
