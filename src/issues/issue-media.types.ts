import { ByteRange } from '../common/http/byte-range.js';

/**
 * The four fields we use from a parsed upload. Declared here rather than taken
 * from Express.Multer.File so the service does not depend on the HTTP layer,
 * and so a future storage backend need not re-type its input.
 */
export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface MediaStream {
  stream: NodeJS.ReadableStream;
  contentType: string;
  /** Total size of the file, not of the slice being returned. */
  size: number;
  /** Present when this is a partial response. */
  range?: ByteRange;
}
