import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * ffmpeg-static is CommonJS shipping an ESM-shaped declaration, so a default
 * import type-checks as the module namespace and is the string at runtime —
 * the same interop trap as mongoose's Connection. Requiring it outright is
 * honest about what the package is, and types correctly.
 *
 * Null when the platform has no prebuilt binary, which turns extraction off
 * rather than crashing the resolve path.
 */
export const FFMPEG_PATH: string | null = createRequire(import.meta.url)(
  'ffmpeg-static',
);

/**
 * A volunteer is waiting on the whole resolve request, and the AI call that
 * follows this one already budgets 60 seconds. Decoding must not be able to
 * spend the rest of that budget on one pathological file.
 */
export const FRAME_TIMEOUT_MS = 15_000;

/** Wide enough to judge a repair, small enough to keep the request cheap. */
const FRAME_MAX_WIDTH = 1024;

/**
 * Where in the clip to sample. The opening frames are usually a blur or a black
 * lead-in, and the very last one is often mid-pan, so the window sits in the
 * second half: the midpoint for context, near the end for the finished state.
 */
const FIRST_FRACTION = 0.5;
const LAST_FRACTION = 0.85;

function fractionsFor(count: number): number[] {
  if (count === 1) {
    return [LAST_FRACTION];
  }
  const step = (LAST_FRACTION - FIRST_FRACTION) / (count - 1);
  return Array.from({ length: count }, (_, i) => FIRST_FRACTION + i * step);
}

/**
 * ffmpeg-static ships ffmpeg but not ffprobe, so the duration comes from
 * ffmpeg's own banner. Asking it to read a file with no output is an error by
 * design — it exits non-zero having printed what it learned.
 */
async function probeDuration(
  binary: string,
  source: string,
  timeoutMs: number,
): Promise<number | null> {
  let output = '';
  try {
    const { stderr } = await run(binary, ['-i', source], {
      timeout: timeoutMs,
    });
    output = stderr;
  } catch (error) {
    output = (error as { stderr?: string }).stderr ?? '';
  }

  const match = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(output);
  if (!match) {
    return null;
  }

  const seconds =
    Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return seconds > 0 ? seconds : null;
}

/**
 * Stills from a video, as JPEG buffers, for the proof assessment to compare
 * like any other photograph.
 *
 * Never throws: a file that cannot be decoded yields no frames, and the caller
 * treats that the same as a side with no images at all. Seeking with `-ss`
 * before `-i` makes each grab a keyframe jump rather than a full decode, which
 * is what keeps a 50MB clip inside the budget above.
 */
export async function extractFrames(
  video: Buffer,
  count: number,
  timeoutMs: number = FRAME_TIMEOUT_MS,
): Promise<Buffer[]> {
  const binary = FFMPEG_PATH;
  if (!binary || count < 1) {
    return [];
  }

  const deadline = Date.now() + timeoutMs;
  const remaining = () => deadline - Date.now();

  const dir = await mkdtemp(join(tmpdir(), 'civicon-frames-'));
  try {
    const source = join(dir, 'input');
    await writeFile(source, video);

    const duration = await probeDuration(
      binary,
      source,
      Math.max(remaining(), 1),
    );
    if (duration === null) {
      return [];
    }

    const frames: Buffer[] = [];
    for (const [index, fraction] of fractionsFor(count).entries()) {
      if (remaining() <= 0) {
        break;
      }

      const target = join(dir, `frame-${index}.jpg`);
      try {
        await run(
          binary,
          [
            '-ss',
            (duration * fraction).toFixed(3),
            '-i',
            source,
            '-frames:v',
            '1',
            '-vf',
            `scale='min(${FRAME_MAX_WIDTH},iw)':-2`,
            '-q:v',
            '3',
            target,
          ],
          { timeout: remaining() },
        );
        frames.push(await readFile(target));
      } catch {
        // A clip too short for this offset, or a timeout: keep what we have.
        break;
      }
    }

    return frames;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
