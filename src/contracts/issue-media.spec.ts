import {
  MAX_UPLOAD_BYTES,
  MEDIA_LIMITS,
  checkUpload,
  mediaKindFor,
} from './index.js';

const MB = 1024 * 1024;

describe('mediaKindFor', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp'])(
    'classifies %s as an image',
    (type) => expect(mediaKindFor(type)).toBe('image'),
  );

  it.each(['video/mp4', 'video/webm'])('classifies %s as video', (type) =>
    expect(mediaKindFor(type)).toBe('video'),
  );

  it.each(['application/pdf', 'text/html', 'image/svg+xml', ''])(
    'refuses to classify %s',
    (type) => expect(mediaKindFor(type)).toBeNull(),
  );
});

describe('checkUpload', () => {
  it('accepts an image within its cap', () => {
    expect(checkUpload('image/png', 4 * MB)).toBeNull();
  });

  it('accepts a video within its cap', () => {
    expect(checkUpload('video/mp4', 40 * MB)).toBeNull();
  });

  it('rejects a disallowed type before looking at size', () => {
    expect(checkUpload('application/pdf', 1)).toEqual({ reason: 'type' });
  });

  it('rejects an image over the image cap', () => {
    expect(checkUpload('image/png', 6 * MB)).toEqual({
      reason: 'size',
      kind: 'image',
      maxBytes: MEDIA_LIMITS.image.maxBytes,
    });
  });

  // The whole reason the image cap is enforced separately: 6MB is under the
  // 50MB ceiling multer is configured with, so only a per-type check catches it.
  it('rejects an image that a video of the same size would be allowed', () => {
    expect(checkUpload('image/png', 6 * MB)).not.toBeNull();
    expect(checkUpload('video/mp4', 6 * MB)).toBeNull();
  });

  it('rejects a video over the video cap', () => {
    expect(checkUpload('video/mp4', 51 * MB)).toEqual({
      reason: 'size',
      kind: 'video',
      maxBytes: MEDIA_LIMITS.video.maxBytes,
    });
  });

  it('accepts a file exactly on the cap', () => {
    expect(checkUpload('video/mp4', MEDIA_LIMITS.video.maxBytes)).toBeNull();
  });
});

describe('MAX_UPLOAD_BYTES', () => {
  it('is the larger of the two caps, since multer takes only one number', () => {
    expect(MAX_UPLOAD_BYTES).toBe(MEDIA_LIMITS.video.maxBytes);
  });
});
