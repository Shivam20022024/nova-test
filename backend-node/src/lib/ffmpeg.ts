import * as fsSync from 'fs';
import * as path from 'path';

// Resolves an absolute path to ffmpeg.exe so video compression keeps working
// even when the Node process's PATH doesn't include it (e.g. the dev server
// was started in a terminal opened before ffmpeg was installed — PATH
// updates from winget/choco only apply to shells opened afterward). Falls
// back to the bare "ffmpeg" command, which still works if PATH is correct.
let cachedFfmpegPath: string | null = null;

function findFfmpegInWinget(): string | null {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;

  const wingetPackages = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  if (!fsSync.existsSync(wingetPackages)) return null;

  try {
    const entries = fsSync.readdirSync(wingetPackages, { recursive: true }) as string[];
    const match = entries.find((entry) => entry.toLowerCase().endsWith(path.join('bin', 'ffmpeg.exe').toLowerCase()));
    if (match) return path.join(wingetPackages, match);
  } catch {
    // Ignore — fall through to other resolution strategies.
  }
  return null;
}

export function resolveFfmpegPath(): string {
  if (cachedFfmpegPath) return cachedFfmpegPath;

  if (process.env.FFMPEG_PATH && fsSync.existsSync(process.env.FFMPEG_PATH)) {
    cachedFfmpegPath = process.env.FFMPEG_PATH;
    return cachedFfmpegPath;
  }

  const wingetPath = findFfmpegInWinget();
  if (wingetPath) {
    cachedFfmpegPath = wingetPath;
    return cachedFfmpegPath;
  }

  // Last resort: rely on the process's own PATH.
  cachedFfmpegPath = 'ffmpeg';
  return cachedFfmpegPath;
}
