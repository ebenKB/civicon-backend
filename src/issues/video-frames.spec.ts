import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { extractFrames, FFMPEG_PATH } from './video-frames.js';

const run = promisify(execFile);

/**
 * A real clip, generated rather than committed: ffmpeg is already a dependency,
 * so the suite can make its own fixture and no binary lives in git. `testsrc`
 * moves, which matters — two frames taken from a still image would pass a test
 * that a broken seek would also pass.
 */
async function makeTestVideo(seconds: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'civicon-video-spec-'));
  const file = join(dir, 'clip.mp4');
  try {
    await run(FFMPEG_PATH as string, [
      '-f',
      'lavfi',
      '-i',
      `testsrc=duration=${seconds}:size=320x240:rate=10`,
      '-pix_fmt',
      'yuv420p',
      file,
    ]);
    return await readFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const isJpeg = (buffer: Buffer) =>
  buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;

describe('extractFrames', () => {
  it('returns the requested number of JPEG frames from a video', async () => {
    const video = await makeTestVideo(2);

    const frames = await extractFrames(video, 2);

    expect(frames).toHaveLength(2);
    expect(frames.every(isJpeg)).toBe(true);
  });

  it('samples different moments rather than the same frame twice', async () => {
    const video = await makeTestVideo(2);

    const [first, second] = await extractFrames(video, 2);

    expect(first.equals(second)).toBe(false);
  });

  it('returns nothing when the bytes are not a video', async () => {
    const frames = await extractFrames(Buffer.from('not a video at all'), 2);

    expect(frames).toEqual([]);
  });

  it('gives up rather than hanging when extraction outruns its budget', async () => {
    const video = await makeTestVideo(2);

    const frames = await extractFrames(video, 2, 1);

    expect(frames).toEqual([]);
  });
});
