/** The GridFS bucket name. Yields issue_media.files and issue_media.chunks. */
export const MEDIA_BUCKET = 'issue_media';

/**
 * Every cap in one place, so the interceptor, the service, the tests and the
 * documentation cannot disagree about a number.
 */
export const MEDIA_LIMITS = {
  maxPerIssue: 5,
  image: {
    maxBytes: 5 * 1024 * 1024,
    types: ['image/jpeg', 'image/png', 'image/webp'],
  },
  video: {
    maxBytes: 50 * 1024 * 1024,
    types: ['video/mp4', 'video/webm'],
  },
} as const;

/**
 * multer's limits.fileSize takes a single number, so it is set to the larger
 * ceiling and the per-type cap is applied afterwards, once the type is known.
 */
export const MAX_UPLOAD_BYTES = Math.max(
  MEDIA_LIMITS.image.maxBytes,
  MEDIA_LIMITS.video.maxBytes,
);

export type MediaKind = 'image' | 'video';

export function mediaKindFor(mimetype: string): MediaKind | null {
  if ((MEDIA_LIMITS.image.types as readonly string[]).includes(mimetype)) {
    return 'image';
  }
  if ((MEDIA_LIMITS.video.types as readonly string[]).includes(mimetype)) {
    return 'video';
  }
  return null;
}

export type UploadRejection =
  { reason: 'type' } | { reason: 'size'; kind: MediaKind; maxBytes: number };

/** Returns null when the upload is acceptable, or why it is not. */
export function checkUpload(
  mimetype: string,
  size: number,
): UploadRejection | null {
  const kind = mediaKindFor(mimetype);
  if (!kind) {
    return { reason: 'type' };
  }

  const { maxBytes } = MEDIA_LIMITS[kind];
  if (size > maxBytes) {
    return { reason: 'size', kind, maxBytes };
  }

  return null;
}
