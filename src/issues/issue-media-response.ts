import type { Types } from 'mongoose';

/**
 * The media shape the API returns. Explicit, like toPublicIssue: adding a field
 * to what GridFS stores must not silently widen what the API exposes.
 */
export interface PublicMedia {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  uploadedAt: Date;
  /** Ready to drop into a src attribute. */
  url: string;
}

/**
 * The subset of a GridFS files document this slice reads.
 *
 * contentType sits in `metadata` rather than at the top level: the GridFS
 * specification deprecated the top-level field, and the bundled driver has
 * dropped it from both the write options and the file document type.
 */
export interface MediaFileDocument {
  _id: Types.ObjectId;
  filename: string;
  length: number;
  uploadDate: Date;
  metadata?: {
    issueId?: Types.ObjectId;
    uploadedBy?: Types.ObjectId;
    contentType?: string;
  };
}

export function toPublicMedia(file: MediaFileDocument): PublicMedia {
  return {
    id: file._id.toString(),
    filename: file.filename,
    contentType: file.metadata?.contentType ?? 'application/octet-stream',
    size: file.length,
    uploadedAt: file.uploadDate,
    url: `/issues/media/${file._id.toString()}`,
  };
}
