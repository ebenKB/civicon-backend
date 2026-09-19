import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSeedImage } from './seed-images.js';

describe('loadSeedImage', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'civicon-seed-images-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds an image by name whatever its extension, with its type', async () => {
    await writeFile(join(dir, 'pothole-before.jpg'), Buffer.from('jpeg-bytes'));

    const image = await loadSeedImage(dir, 'pothole-before');

    expect(image).toEqual({
      filename: 'pothole-before.jpg',
      mimetype: 'image/jpeg',
      buffer: Buffer.from('jpeg-bytes'),
    });
  });

  it('reads png and webp as well', async () => {
    await writeFile(join(dir, 'drain-before.png'), Buffer.from('p'));
    await writeFile(join(dir, 'skip-before.webp'), Buffer.from('w'));

    expect((await loadSeedImage(dir, 'drain-before'))?.mimetype).toBe(
      'image/png',
    );
    expect((await loadSeedImage(dir, 'skip-before'))?.mimetype).toBe(
      'image/webp',
    );
  });

  // The images are generated separately and may not exist yet; the seed must
  // still run, falling back to a placeholder.
  it('returns null when no image has been added yet', async () => {
    expect(await loadSeedImage(dir, 'streetlight-before')).toBeNull();
  });

  it('returns null when the folder itself does not exist', async () => {
    expect(
      await loadSeedImage(join(dir, 'missing'), 'streetlight-before'),
    ).toBeNull();
  });
});
