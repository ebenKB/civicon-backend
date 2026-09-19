import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SeedImage {
  filename: string;
  mimetype: string;
  buffer: Buffer;
}

/** The upload service's accepted image types, by the extension they ship with. */
const TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * A demo photograph from seed/images, found by name whatever format the image
 * generator produced. Null when it has not been added yet — the images are made
 * separately, and the seed must run without them.
 */
export async function loadSeedImage(
  dir: string,
  name: string,
): Promise<SeedImage | null> {
  for (const [extension, mimetype] of Object.entries(TYPES)) {
    const filename = `${name}${extension}`;
    try {
      return {
        filename,
        mimetype,
        buffer: await readFile(join(dir, filename)),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return null;
}
