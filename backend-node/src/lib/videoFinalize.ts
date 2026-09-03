import fs from 'fs/promises';
import * as fsSync from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { resolveFfmpegPath } from './ffmpeg';
import { supabase } from '../utils/storage';

const execP = promisify(exec);

export interface VideoFinalizeResult {
  /** Public URL of the uploaded artefact (what the report <video> plays). */
  url: string;
  /** Supabase Storage object path, e.g. `videos/<executionId>.mp4`. */
  storagePath: string;
  /** The finalized file on local disk — used to attach the clip to a Jira bug. */
  localPath: string;
}

const FFMPEG_TIMEOUT_MS = 120_000;
const MIN_RAW_BYTES = 5120; // smaller than this is a corrupt/empty recording

// mpdecimate drops frames that barely differ from the one before them; the
// thresholds are bumped a little past ffmpeg's defaults so that near-static
// stretches (the seconds the run spends blocked on an LLM call, plus codec
// shimmer) collapse to a couple of frames while real activity — typing,
// clicks, navigations — is always kept. setpts then re-stamps the survivors to
// a constant rate so the clip is only the actual browser work, not the waiting.
const DECIMATE_FILTER = 'mpdecimate=hi=64*20:lo=64*8:frac=0.33,setpts=N/FRAME_RATE/TB';

/**
 * Turns Playwright's raw WebM page recording into the single artefact shown on
 * the execution report:
 *   - strips the idle LLM-wait stretches (see DECIMATE_FILTER), and
 *   - transcodes to H.264 MP4 (+faststart) so it plays in every browser,
 *     Safari included — Playwright records VP8/WebM, which Safari cannot decode
 *     and which Chrome refuses when it is mislabelled `video/mp4`.
 *
 * Idempotent per execution: it uploads to one deterministic object key and
 * keeps exactly one `Video` row, so it is safe to call from both the success
 * path and the `finally` cleanup of the worker. If ffmpeg is unavailable or
 * fails, the raw WebM is uploaded as-is (correctly labelled) rather than
 * losing the recording.
 */
export async function finalizeExecutionVideo(
  rawVideoPath: string,
  executionId: string,
  log: (msg: string) => void = () => {},
): Promise<VideoFinalizeResult | null> {
  try {
    if (!rawVideoPath || !fsSync.existsSync(rawVideoPath)) {
      log('[Video] no raw recording to finalize');
      return null;
    }
    if (fsSync.statSync(rawVideoPath).size <= MIN_RAW_BYTES) {
      log('[Video] raw recording is empty/corrupt, skipping');
      return null;
    }

    // 1. Strip idle frames + transcode to mp4. Fall back to the raw webm on any
    //    ffmpeg problem so a run never loses its recording.
    const trimmedPath = rawVideoPath.replace(/\.webm$/i, '') + '.trimmed.mp4';
    let uploadPath = rawVideoPath;
    try {
      const ffmpeg = resolveFfmpegPath();
      const cmd =
        `"${ffmpeg}" -y -i "${rawVideoPath}" ` +
        `-vf "${DECIMATE_FILTER}" -r 30 -an ` +
        `-c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p -movflags +faststart ` +
        `"${trimmedPath}"`;
      log('[Video] Stripping idle LLM-wait frames and transcoding to mp4...');
      await Promise.race([
        execP(cmd),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('ffmpeg timeout')), FFMPEG_TIMEOUT_MS),
        ),
      ]);
      if (fsSync.existsSync(trimmedPath) && fsSync.statSync(trimmedPath).size > 0) {
        uploadPath = trimmedPath;
        log('[Video] idle frames stripped');
      } else {
        log('[Video] ffmpeg produced no output, uploading raw recording');
      }
    } catch (e: any) {
      log(`[Video] ffmpeg failed (${e?.message || e}), uploading raw recording`);
    }

    // 2. Upload under a single deterministic key. Extension + content-type
    //    always match the actual bytes.
    const isMp4 = uploadPath.toLowerCase().endsWith('.mp4');
    const objectKey = `${executionId}.${isMp4 ? 'mp4' : 'webm'}`;
    const contentType = isMp4 ? 'video/mp4' : 'video/webm';
    const bytes = await fs.readFile(uploadPath);

    const { data, error } = await supabase.storage
      .from('videos')
      .upload(objectKey, bytes, { contentType, upsert: true });
    if (error || !data) {
      log(`[Video] upload failed: ${error?.message || 'unknown error'}`);
      return null;
    }

    const { data: pub } = supabase.storage.from('videos').getPublicUrl(data.path);
    if (!pub?.publicUrl) {
      log('[Video] getPublicUrl returned nothing');
      return null;
    }

    const storagePath = `videos/${objectKey}`;

    // 3. Exactly one Video row per execution — replace any earlier row (e.g.
    //    from a run that was interrupted and retried).
    const { data: existing } = await supabase
      .from('Video')
      .select('id')
      .eq('executionLogId', executionId);
    if (existing && existing.length > 0) {
      await supabase
        .from('Video')
        .update({ url: pub.publicUrl, storagePath })
        .eq('executionLogId', executionId);
    } else {
      await supabase
        .from('Video')
        .insert({ executionLogId: executionId, url: pub.publicUrl, storagePath });
    }

    return { url: pub.publicUrl, storagePath, localPath: uploadPath };
  } catch (e: any) {
    log(`[Video] finalize failed: ${e?.message || e}`);
    return null;
  }
}
