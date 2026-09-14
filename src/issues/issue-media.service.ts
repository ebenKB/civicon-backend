import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import mongoose, { Types } from 'mongoose';
// `import type`: mongoose is CommonJS, and Node's ESM interop cannot extract
// Connection as a named export at runtime. It is only ever a type here, so
// erasing it at compile time is both correct and necessary.
import type { Connection } from 'mongoose';
import { ByteRange } from '../common/http/byte-range.js';
import {
  checkUpload,
  IssueStatus,
  MEDIA_BUCKET,
  MEDIA_LIMITS,
} from '../contracts/index.js';
import {
  MediaFileDocument,
  PublicMedia,
  toPublicMedia,
} from './issue-media-response.js';
import { MediaStream, UploadedFile } from './issue-media.types.js';
import { IssuesService } from './issues.service.js';

/**
 * The only place in the codebase that knows the bytes live in GridFS. Its
 * public surface is storage-agnostic on purpose: moving to S3 replaces the body
 * of this file and nothing else.
 */
@Injectable()
export class IssueMediaService implements OnModuleInit {
  private readonly bucket: mongoose.mongo.GridFSBucket;
  private readonly files: mongoose.mongo.Collection;

  constructor(
    @InjectConnection() connection: Connection,
    private readonly issuesService: IssuesService,
  ) {
    // GridFSBucket is reached through mongoose rather than by importing the
    // mongodb driver, which is only a transitive dependency here.
    const db = connection.db as unknown as mongoose.mongo.Db;
    this.bucket = new mongoose.mongo.GridFSBucket(db, {
      bucketName: MEDIA_BUCKET,
    });
    this.files = db.collection(`${MEDIA_BUCKET}.files`);
  }

  /**
   * GridFS indexes _id and filename but knows nothing about our metadata, and
   * every query this service makes filters on metadata.issueId — the per-issue
   * listing, the batched page lookup, and the cap count. Without this they are
   * all collection scans.
   */
  async onModuleInit(): Promise<void> {
    await this.files.createIndex({ 'metadata.issueId': 1 });
  }

  async upload(
    issueId: string,
    actorId: string,
    file: UploadedFile,
  ): Promise<PublicMedia> {
    await this.assertMayAttach(issueId, actorId);

    const rejection = checkUpload(file.mimetype, file.size);
    if (rejection?.reason === 'type') {
      throw new UnsupportedMediaTypeException(
        `${file.mimetype} is not an accepted media type`,
      );
    }
    if (rejection?.reason === 'size') {
      throw new PayloadTooLargeException(
        `A ${rejection.kind} may be at most ${rejection.maxBytes} bytes`,
      );
    }

    const existing = await this.listFor(issueId);
    if (existing.length >= MEDIA_LIMITS.maxPerIssue) {
      throw new ConflictException(
        `An issue may carry at most ${MEDIA_LIMITS.maxPerIssue} files`,
      );
    }

    const upload = this.bucket.openUploadStream(file.originalname, {
      // contentType belongs in metadata: the GridFS spec deprecated the
      // top-level field and the driver no longer accepts it.
      metadata: {
        issueId: new Types.ObjectId(issueId),
        uploadedBy: new Types.ObjectId(actorId),
        contentType: file.mimetype,
      },
    });

    await new Promise<void>((resolve, reject) => {
      upload.once('error', reject);
      upload.once('finish', () => resolve());
      upload.end(file.buffer);
    });

    const stored = await this.findFile(upload.id.toString());
    return toPublicMedia(stored);
  }

  async listFor(issueId: string): Promise<PublicMedia[]> {
    const files = (await this.bucket
      .find({ 'metadata.issueId': new Types.ObjectId(issueId) })
      .toArray()) as unknown as MediaFileDocument[];

    return files.map(toPublicMedia);
  }

  /**
   * One query for a whole page of issues, so listing costs a single extra
   * round trip rather than one per issue.
   */
  async listForMany(issueIds: string[]): Promise<Map<string, PublicMedia[]>> {
    const grouped = new Map<string, PublicMedia[]>();
    if (issueIds.length === 0) {
      return grouped;
    }

    const files = (await this.bucket
      .find({
        'metadata.issueId': {
          $in: issueIds.map((id) => new Types.ObjectId(id)),
        },
      })
      .toArray()) as unknown as MediaFileDocument[];

    for (const file of files) {
      const key = file.metadata?.issueId?.toString();
      if (!key) {
        continue;
      }
      const list = grouped.get(key) ?? [];
      list.push(toPublicMedia(file));
      grouped.set(key, list);
    }

    return grouped;
  }

  async openDownload(mediaId: string, range?: ByteRange): Promise<MediaStream> {
    const file = await this.findFile(mediaId);

    // GridFS treats `end` as exclusive; HTTP byte ranges are inclusive.
    const stream = range
      ? this.bucket.openDownloadStream(file._id, {
          start: range.start,
          end: range.end + 1,
        })
      : this.bucket.openDownloadStream(file._id);

    return {
      stream,
      contentType: file.metadata?.contentType ?? 'application/octet-stream',
      size: file.length,
      range,
    };
  }

  async remove(mediaId: string, actorId: string): Promise<void> {
    const file = await this.findFile(mediaId);
    const issueId = file.metadata?.issueId?.toString();
    if (!issueId) {
      throw new NotFoundException(
        `Media "${mediaId}" is not attached to an issue`,
      );
    }

    await this.assertMayAttach(issueId, actorId);
    await this.bucket.delete(file._id);
  }

  /** Ownership and state are stated once, here, and reused by upload and remove. */
  private async assertMayAttach(
    issueId: string,
    actorId: string,
  ): Promise<void> {
    const issue = await this.issuesService.findOne(issueId);

    if (issue.reportedBy.toString() !== actorId) {
      throw new ForbiddenException(
        'You can only attach media to issues you reported',
      );
    }

    if (issue.status !== IssueStatus.OPEN) {
      throw new ConflictException(
        `Media can only be attached while an issue is OPEN; this one is ${issue.status}`,
      );
    }
  }

  private async findFile(mediaId: string): Promise<MediaFileDocument> {
    const [file] = (await this.bucket
      .find({ _id: new Types.ObjectId(mediaId) })
      .toArray()) as unknown as MediaFileDocument[];

    if (!file) {
      throw new NotFoundException(`Media with id "${mediaId}" not found`);
    }
    return file;
  }
}
