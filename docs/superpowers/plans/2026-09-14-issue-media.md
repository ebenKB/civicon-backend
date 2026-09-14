# Issue Media Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a citizen attach photographs and short video to an issue they reported, and let anyone view that evidence without an account.

**Architecture:** A GridFS bucket named `issue_media` holds the bytes; each file's own `metadata` subdocument (`issueId`, `uploadedBy`) is the only record of it, so nothing can drift. `IssueMediaService` is the one file that mentions GridFS. The rules that are worth testing without a database — which MIME types and sizes are allowed, and how to parse a `Range` header — are pure functions living outside the service.

**Tech Stack:** NestJS 12 (ESM), Mongoose 9 GridFS via `mongoose.mongo.GridFSBucket`, multer through `FileInterceptor`, Vitest, MongoDB 8.

**Spec:** `docs/superpowers/specs/2026-09-14-issue-media-design.md`

## Global Constraints

- **ESM codebase.** Every relative import carries a `.js` extension, even when importing a `.ts` file.
- **A type used in a decorated signature needs `import type`** — `isolatedModules` and `emitDecoratorMetadata` are both on. This applies to `AuthenticatedUser`, and to `Response` from express.
- **Mongoose 9 exports `QueryFilter`, not `FilterQuery`.**
- **GridFS `contentType` lives in `metadata`.** The spec deprecated the top-level field and the bundled driver rejects it.
- **`@Prop` on an enum property needs an explicit `type: String`** — TypeScript emits `Object` as its `design:type`.
- **Reach driver classes through `mongoose.mongo`**, never by importing `mongodb` directly — it is a transitive dependency.
- **Global pipe, filter and guards are already registered** in `AppModule`. Do not register more. `@Public()` opts a route out of auth; `@Roles()` requires a role.
- **One new devDependency, `@types/multer`.** Nothing else.
- **Caps live in exactly one place**, `src/contracts/issue-media.ts`: 5 files per issue, images ≤ 5MB (jpeg/png/webp), video ≤ 50MB (mp4/webm).
- **GridFS may be named in exactly one file:** `issue-media.service.ts`.
- **Vitest globals are on.** Unit specs sit beside their source; e2e specs live in `test/`.
- **e2e needs a running database** (`docker compose up -d`) and `JWT_SECRET` in `.env`, and refuses to run unless the database name ends in `_test`.
- **The e2e suite builds its actors once in `beforeAll`,** never per test: bcrypt at cost factor 12 measures ~1.2s per operation on a laptop.
- Run `npm run format` and `npm run lint` before each commit.

---

### Task 1: Media contracts and the upload rules

The caps, and the pure function that applies them. No Nest, no database.

**Files:**
- Create: `src/contracts/issue-media.ts`
- Create: `src/contracts/issue-media.spec.ts`
- Modify: `src/contracts/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MEDIA_BUCKET: 'issue_media'`; `MEDIA_LIMITS`; `MAX_UPLOAD_BYTES: number`; `MediaKind = 'image' | 'video'`; `mediaKindFor(mimetype: string): MediaKind | null`; `UploadRejection`; `checkUpload(mimetype: string, size: number): UploadRejection | null`.

- [ ] **Step 1: Write the failing test**

Create `src/contracts/issue-media.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/contracts/issue-media.spec.ts`
Expected: FAIL — `checkUpload` is not exported from `./index.js`.

- [ ] **Step 3: Write the contract**

Create `src/contracts/issue-media.ts`:

```ts
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
  | { reason: 'type' }
  | { reason: 'size'; kind: MediaKind; maxBytes: number };

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
```

Append to `src/contracts/index.ts`:

```ts
export * from './issue-media.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/contracts/issue-media.spec.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
npm run format && npm run lint
git add src/contracts
git commit -m "Add issue media contracts and upload rules"
```

---

### Task 2: Range header parsing

A pure function, so video seeking is provable without a database or an HTTP server.

**Files:**
- Create: `src/common/http/byte-range.ts`
- Create: `src/common/http/byte-range.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ByteRange { start: number; end: number }`; `parseByteRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null` — `null` means no range was requested.

- [ ] **Step 1: Write the failing test**

Create `src/common/http/byte-range.spec.ts`:

```ts
import { parseByteRange } from './byte-range.js';

const SIZE = 1000;

describe('parseByteRange', () => {
  it('returns null when no header is present', () => {
    expect(parseByteRange(undefined, SIZE)).toBeNull();
  });

  it('parses a closed range', () => {
    expect(parseByteRange('bytes=0-499', SIZE)).toEqual({ start: 0, end: 499 });
  });

  it('parses an open-ended range as running to the last byte', () => {
    expect(parseByteRange('bytes=500-', SIZE)).toEqual({
      start: 500,
      end: 999,
    });
  });

  it('parses a suffix range as the last N bytes', () => {
    expect(parseByteRange('bytes=-100', SIZE)).toEqual({
      start: 900,
      end: 999,
    });
  });

  it('clamps an end past the last byte', () => {
    expect(parseByteRange('bytes=900-5000', SIZE)).toEqual({
      start: 900,
      end: 999,
    });
  });

  it('accepts a range covering the whole file', () => {
    expect(parseByteRange('bytes=0-999', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it.each([
    ['bytes=1000-', 'a start at or past the end'],
    ['bytes=600-500', 'an end before the start'],
    ['bytes=-0', 'a zero-length suffix'],
  ])('reports %s as unsatisfiable (%s)', (header) => {
    expect(parseByteRange(header, SIZE)).toBe('unsatisfiable');
  });

  it.each([
    'items=0-10',
    'bytes=abc-def',
    'bytes=',
    'nonsense',
    'bytes=0-10, 20-30',
  ])('treats the malformed header %s as no range', (header) => {
    expect(parseByteRange(header, SIZE)).toBeNull();
  });

  it('treats a zero-byte file as unsatisfiable for any range', () => {
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/common/http/byte-range.spec.ts`
Expected: FAIL — cannot resolve `./byte-range.js`.

- [ ] **Step 3: Write the implementation**

Create `src/common/http/byte-range.ts`:

```ts
export interface ByteRange {
  start: number;
  end: number;
}

/** Inclusive on both ends, as HTTP byte ranges are. */
const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * Parses a Range header against a known file size.
 *
 * Returns null when the caller asked for no range, or asked in a way we do not
 * honour — a malformed header, or multiple ranges. RFC 9110 permits answering
 * such a request with the whole representation, and a single stream is all
 * GridFS gives us cheaply.
 *
 * Returns 'unsatisfiable' when the range is well formed but cannot be served,
 * which the caller answers with 416.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) {
    return null;
  }

  const match = SINGLE_RANGE.exec(header.trim());
  if (!match) {
    return null;
  }

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') {
    return null;
  }

  if (size === 0) {
    return 'unsatisfiable';
  }

  // "bytes=-100" means the last 100 bytes, not "up to byte 100".
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (suffix === 0) {
      return 'unsatisfiable';
    }
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) {
    return 'unsatisfiable';
  }

  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) {
    return 'unsatisfiable';
  }

  return { start, end };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/common/http/byte-range.spec.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
npm run format && npm run lint
git add src/common/http
git commit -m "Add byte range parsing for media streaming"
```

---

### Task 3: IssueMediaService

The only file in the codebase that mentions GridFS.

**Files:**
- Create: `src/issues/issue-media.types.ts`
- Create: `src/issues/issue-media-response.ts`
- Create: `src/issues/issue-media.service.ts`
- Create: `src/issues/issue-media.service.spec.ts`
- Modify: `src/issues/issues.module.ts`

**Interfaces:**
- Consumes: `MEDIA_BUCKET`, `MEDIA_LIMITS`, `checkUpload` (Task 1); `ByteRange`, `parseByteRange` (Task 2); `IssuesService.findOne` (existing).
- Produces: `UploadedFile`, `MediaStream` (in `issue-media.types.ts`); `PublicMedia`, `toPublicMedia(file)` (in `issue-media-response.ts`); `IssueMediaService` with `upload`, `listFor`, `listForMany`, `openDownload`, `remove`, and an `onModuleInit` that creates the `metadata.issueId` index.

- [ ] **Step 1: Write the types and the response shaper**

Create `src/issues/issue-media.types.ts`:

```ts
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
```

Create `src/issues/issue-media-response.ts`:

```ts
import { ObjectId } from 'mongodb';

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

/** The subset of a GridFS files document this slice reads. */
export interface MediaFileDocument {
  _id: ObjectId;
  filename: string;
  length: number;
  uploadDate: Date;
  // contentType sits in metadata, not at the top level: the GridFS spec
  // deprecated the top-level field, and the bundled driver has dropped it from
  // both GridFSBucketWriteStreamOptions and GridFSFile.
  metadata?: {
    issueId?: ObjectId;
    uploadedBy?: ObjectId;
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
```

Note the `mongodb` import here is for a **type only** and is erased at build time. If the linter objects to importing the transitive package even as a type, change it to `import type { Types } from 'mongoose'` and use `Types.ObjectId`.

- [ ] **Step 2: Write the failing service test**

Create `src/issues/issue-media.service.spec.ts`. The bucket is mocked: `find` and `delete` are ordinary calls, and `openUploadStream` is only exercised end-to-end in Task 7, where a real bucket is cheaper than a faithful stream double.

```ts
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { IssueStatus } from '../contracts/index.js';
import { IssueMediaService } from './issue-media.service.js';
import { IssuesService } from './issues.service.js';

const REPORTER = '507f1f77bcf86cd799439011';
const STRANGER = '507f1f77bcf86cd799439099';
const ISSUE_ID = '507f1f77bcf86cd799439022';

const fileDoc = (overrides: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  filename: 'culvert.png',
  contentType: 'image/png',
  length: 1234,
  uploadDate: new Date('2026-09-14T10:00:00Z'),
  metadata: {
    issueId: new Types.ObjectId(ISSUE_ID),
    uploadedBy: new Types.ObjectId(REPORTER),
  },
  ...overrides,
});

const anImage = (size = 1024) => ({
  originalname: 'culvert.png',
  mimetype: 'image/png',
  size,
  buffer: Buffer.alloc(0),
});

describe('IssueMediaService', () => {
  let service: IssueMediaService;
  let issuesService: { findOne: ReturnType<typeof vi.fn> };
  let bucket: {
    find: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    openUploadStream: ReturnType<typeof vi.fn>;
  };

  /** GridFSBucket.find returns a cursor; only toArray is used here. */
  const cursorOf = (docs: unknown[]) => ({ toArray: () => Promise.resolve(docs) });

  beforeEach(async () => {
    issuesService = { findOne: vi.fn() };
    bucket = { find: vi.fn(), delete: vi.fn(), openUploadStream: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IssueMediaService,
        { provide: IssuesService, useValue: issuesService },
        {
          provide: getConnectionToken(),
          useValue: { db: { collection: () => ({ createIndex: vi.fn() }) } },
        },
      ],
    }).compile();

    service = module.get<IssueMediaService>(IssueMediaService);
    // Replace the bucket built in the constructor with the double.
    (service as unknown as { bucket: unknown }).bucket = bucket;
  });

  const openIssue = () => ({
    _id: new Types.ObjectId(ISSUE_ID),
    reportedBy: new Types.ObjectId(REPORTER),
    status: IssueStatus.OPEN,
  });

  describe('upload guards', () => {
    it('refuses a caller who is not the reporter', async () => {
      issuesService.findOne.mockResolvedValue(openIssue());

      await expect(
        service.upload(ISSUE_ID, STRANGER, anImage()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses an issue that has left OPEN', async () => {
      issuesService.findOne.mockResolvedValue({
        ...openIssue(),
        status: IssueStatus.REJECTED,
      });

      await expect(
        service.upload(ISSUE_ID, REPORTER, anImage()),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses a disallowed type with 415', async () => {
      issuesService.findOne.mockResolvedValue(openIssue());
      bucket.find.mockReturnValue(cursorOf([]));

      await expect(
        service.upload(ISSUE_ID, REPORTER, {
          ...anImage(),
          mimetype: 'application/pdf',
        }),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    });

    it('refuses an oversize image with 413', async () => {
      issuesService.findOne.mockResolvedValue(openIssue());
      bucket.find.mockReturnValue(cursorOf([]));

      await expect(
        service.upload(ISSUE_ID, REPORTER, anImage(6 * 1024 * 1024)),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
    });

    it('refuses the sixth file on an issue', async () => {
      issuesService.findOne.mockResolvedValue(openIssue());
      bucket.find.mockReturnValue(cursorOf([1, 2, 3, 4, 5].map(() => fileDoc())));

      await expect(
        service.upload(ISSUE_ID, REPORTER, anImage()),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('listFor', () => {
    it('queries by the issue id held in file metadata', async () => {
      bucket.find.mockReturnValue(cursorOf([fileDoc()]));

      const result = await service.listFor(ISSUE_ID);

      const [filter] = bucket.find.mock.calls[0];
      expect(filter['metadata.issueId'].toString()).toBe(ISSUE_ID);
      expect(result[0].url).toBe(`/issues/media/${result[0].id}`);
    });
  });

  describe('listForMany', () => {
    it('fetches every issue in one query and groups the result', async () => {
      const other = new Types.ObjectId();
      bucket.find.mockReturnValue(
        cursorOf([
          fileDoc(),
          fileDoc({ metadata: { issueId: other, uploadedBy: other } }),
        ]),
      );

      const grouped = await service.listForMany([ISSUE_ID, other.toString()]);

      expect(bucket.find).toHaveBeenCalledTimes(1);
      expect(grouped.get(ISSUE_ID)).toHaveLength(1);
      expect(grouped.get(other.toString())).toHaveLength(1);
    });

    it('does not query at all for an empty page', async () => {
      const grouped = await service.listForMany([]);

      expect(bucket.find).not.toHaveBeenCalled();
      expect(grouped.size).toBe(0);
    });
  });

  describe('remove', () => {
    it('refuses a caller who is not the reporter', async () => {
      bucket.find.mockReturnValue(cursorOf([fileDoc()]));
      issuesService.findOne.mockResolvedValue(openIssue());

      await expect(
        service.remove(new Types.ObjectId().toString(), STRANGER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(bucket.delete).not.toHaveBeenCalled();
    });

    it('deletes the file and its chunks for the reporter', async () => {
      const doc = fileDoc();
      bucket.find.mockReturnValue(cursorOf([doc]));
      issuesService.findOne.mockResolvedValue(openIssue());

      await service.remove(doc._id.toString(), REPORTER);

      expect(bucket.delete).toHaveBeenCalledWith(doc._id);
    });

    it('throws NotFoundException for an unknown media id', async () => {
      bucket.find.mockReturnValue(cursorOf([]));

      await expect(
        service.remove(new Types.ObjectId().toString(), REPORTER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('openDownload', () => {
    it('throws NotFoundException for an unknown media id', async () => {
      bucket.find.mockReturnValue(cursorOf([]));

      await expect(
        service.openDownload(new Types.ObjectId().toString()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/issues/issue-media.service.spec.ts`
Expected: FAIL — cannot resolve `./issue-media.service.js`.

- [ ] **Step 4: Write the service**

Create `src/issues/issue-media.service.ts`:

```ts
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
import mongoose, { Connection, Types } from 'mongoose';
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
    this.bucket = new mongoose.mongo.GridFSBucket(
      connection.db as unknown as mongoose.mongo.Db,
      { bucketName: MEDIA_BUCKET },
    );
    this.files = (connection.db as unknown as mongoose.mongo.Db).collection(
      `${MEDIA_BUCKET}.files`,
    );
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

  async openDownload(
    mediaId: string,
    range?: ByteRange,
  ): Promise<MediaStream> {
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
      throw new NotFoundException(`Media "${mediaId}" is not attached to an issue`);
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
```

- [ ] **Step 5: Register the provider**

In `src/issues/issues.module.ts`, add
`import { IssueMediaService } from './issue-media.service.js';` and put
`IssueMediaService` in both `providers` and `exports`, beside the other two.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/issues/issue-media.service.spec.ts`
Expected: PASS (12 tests).

- [ ] **Step 7: Verify it compiles**

Run: `npm run build`
Expected: clean. A complaint about `connection.db` means the cast in the
constructor needs adjusting to the installed driver typings — keep the cast
local to that line rather than widening the field's type.

- [ ] **Step 8: Commit**

```bash
npm run format && npm run lint
git add src/issues
git commit -m "Add IssueMediaService backed by GridFS"
```

---

### Task 4: Upload and metadata endpoints

**Files:**
- Create: `src/issues/issue-media.controller.ts`
- Create: `src/issues/issue-media.controller.spec.ts`
- Modify: `src/issues/issues.module.ts`
- Modify: `package.json` (devDependencies)

**Interfaces:**
- Consumes: `IssueMediaService` (Task 3); `MAX_UPLOAD_BYTES` (Task 1); `@CurrentUser()`, `@Public()`, `ParseObjectIdPipe` (existing).
- Produces: `IssueMediaController` with `POST /issues/:id/media` and `GET /issues/:id/media`.

- [ ] **Step 1: Install the types**

```bash
npm install --save-dev @types/multer
```

Expected: one package added. multer itself is already present transitively.

- [ ] **Step 2: Write the failing controller test**

Create `src/issues/issue-media.controller.spec.ts`:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { IssueMediaController } from './issue-media.controller.js';
import { IssueMediaService } from './issue-media.service.js';

const ISSUE_ID = '507f1f77bcf86cd799439022';

const caller = {
  id: '507f1f77bcf86cd799439011',
  email: 'citizen@civicon.test',
  roles: [],
} as never;

const media = {
  id: 'abc',
  filename: 'culvert.png',
  contentType: 'image/png',
  size: 1234,
  uploadedAt: new Date(),
  url: '/issues/media/abc',
};

describe('IssueMediaController', () => {
  let controller: IssueMediaController;
  let service: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    service = {
      upload: vi.fn(),
      listFor: vi.fn(),
      openDownload: vi.fn(),
      remove: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [IssueMediaController],
      providers: [{ provide: IssueMediaService, useValue: service }],
    }).compile();

    controller = module.get<IssueMediaController>(IssueMediaController);
  });

  it('passes the issue, the caller and the file to the service', async () => {
    service.upload.mockResolvedValue(media);
    const file = {
      originalname: 'culvert.png',
      mimetype: 'image/png',
      size: 1234,
      buffer: Buffer.alloc(0),
    };

    await controller.upload(ISSUE_ID, caller, file as never);

    expect(service.upload).toHaveBeenCalledWith(
      ISSUE_ID,
      '507f1f77bcf86cd799439011',
      file,
    );
  });

  it('rejects a request carrying no file', async () => {
    await expect(
      controller.upload(ISSUE_ID, caller, undefined as never),
    ).rejects.toThrow(/file/i);
  });

  it('delegates the metadata listing', async () => {
    service.listFor.mockResolvedValue([media]);

    await expect(controller.listFor(ISSUE_ID)).resolves.toEqual([media]);
    expect(service.listFor).toHaveBeenCalledWith(ISSUE_ID);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/issues/issue-media.controller.spec.ts`
Expected: FAIL — cannot resolve `./issue-media.controller.js`.

- [ ] **Step 4: Write the controller**

Create `src/issues/issue-media.controller.ts`:

```ts
import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile as UploadedFileParam,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Public } from '../auth/decorators/public.decorator.js';
// `import type` is required: isolatedModules + emitDecoratorMetadata forbid a
// value import for a type referenced in a decorated signature.
import type { AuthenticatedUser } from '../auth/types/jwt-payload.js';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe.js';
import { MAX_UPLOAD_BYTES } from '../contracts/index.js';
import { IssueMediaService } from './issue-media.service.js';
import { UploadedFile } from './issue-media.types.js';

@Controller('issues')
export class IssueMediaController {
  constructor(private readonly issueMediaService: IssueMediaService) {}

  /**
   * No @Roles(): ownership is the requirement, and the service enforces it.
   *
   * multer's limits.fileSize takes a single number, so it carries the larger
   * of the two caps and aborts parsing past it — a 415 or 413 for anything
   * smaller comes from the service, once the type is known.
   */
  @Post(':id/media')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  upload(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFileParam() file: UploadedFile,
  ) {
    if (!file) {
      throw new BadRequestException('A file is required, in the "file" field');
    }
    return this.issueMediaService.upload(id, user.id, file);
  }

  @Public()
  @Get(':id/media')
  listFor(@Param('id', ParseObjectIdPipe) id: string) {
    return this.issueMediaService.listFor(id);
  }
}
```

- [ ] **Step 5: Register the controller**

In `src/issues/issues.module.ts`, add
`import { IssueMediaController } from './issue-media.controller.js';` and add
`IssueMediaController` to the `controllers` array, after `IssuesController`.

- [ ] **Step 6: Run the unit suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 7: Verify by hand**

```bash
docker compose up -d
npm run build && npm run seed
node dist/main.js &
```

In a second terminal:

```bash
TOKEN=$(curl -s -X POST localhost:9000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"citizen@civicon.test","password":"Password123!"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')

ISSUE=$(curl -s -X POST localhost:9000/issues -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Culvert","description":"Collapsed.","category":"DRAINAGE","location":"School road"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')

# A 1x1 PNG is enough to prove the path
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' \
  | base64 -d > /tmp/pixel.png

curl -s -X POST "localhost:9000/issues/$ISSUE/media" \
  -H "Authorization: Bearer $TOKEN" -F "file=@/tmp/pixel.png;type=image/png"

curl -s "localhost:9000/issues/$ISSUE/media"
```

Expected: a 201 body carrying `id`, `contentType: image/png` and a `url`, then
the same entry in the public listing. Then confirm the refusals:

```bash
# Wrong type
curl -s -o /dev/null -w '%{http_code}\n' -X POST "localhost:9000/issues/$ISSUE/media" \
  -H "Authorization: Bearer $TOKEN" -F "file=@/tmp/pixel.png;type=application/pdf"

# No token
curl -s -o /dev/null -w '%{http_code}\n' -X POST "localhost:9000/issues/$ISSUE/media" \
  -F "file=@/tmp/pixel.png;type=image/png"
```

Expected: `415` then `401`. Stop the dev server when done.

- [ ] **Step 8: Commit**

```bash
npm run format && npm run lint
git add src/issues src/contracts package.json package-lock.json
git commit -m "Add issue media upload and listing endpoints"
```

---

### Task 5: Download with range support

**Files:**
- Modify: `src/issues/issue-media.controller.ts`
- Modify: `src/issues/issue-media.controller.spec.ts`

**Interfaces:**
- Consumes: `IssueMediaService.openDownload` (Task 3); `parseByteRange` (Task 2).
- Produces: `GET /issues/media/:mediaId`.

- [ ] **Step 1: Write the failing test**

Append to `src/issues/issue-media.controller.spec.ts`, inside the outer
`describe`. Add `import { Readable } from 'node:stream';` at the top.

```ts
  describe('download', () => {
    const responseDouble = () => {
      const res = {
        status: vi.fn(() => res),
        set: vi.fn(() => res),
        headers: {} as Record<string, string>,
      };
      return res;
    };

    const streamFor = (body: string, range?: { start: number; end: number }) => ({
      stream: Readable.from([Buffer.from(body)]),
      contentType: 'image/png',
      size: 1000,
      range,
    });

    it('answers 200 with the whole file when no range is asked for', async () => {
      service.openDownload.mockResolvedValue(streamFor('whole'));
      const res = responseDouble();

      await controller.download('507f1f77bcf86cd799439033', {}, res as never);

      expect(service.openDownload).toHaveBeenCalledWith(
        '507f1f77bcf86cd799439033',
        undefined,
      );
      expect(res.status).toHaveBeenCalledWith(200);
      const [headers] = res.set.mock.calls[0];
      expect(headers['Accept-Ranges']).toBe('bytes');
      expect(headers['Content-Length']).toBe('1000');
    });

    it('answers 206 with Content-Range for a partial request', async () => {
      service.openDownload.mockResolvedValue(
        streamFor('part', { start: 0, end: 99 }),
      );
      const res = responseDouble();

      await controller.download(
        '507f1f77bcf86cd799439033',
        { range: 'bytes=0-99' },
        res as never,
      );

      expect(service.openDownload).toHaveBeenCalledWith(
        '507f1f77bcf86cd799439033',
        { start: 0, end: 99 },
      );
      expect(res.status).toHaveBeenCalledWith(206);
      const [headers] = res.set.mock.calls[0];
      expect(headers['Content-Range']).toBe('bytes 0-99/1000');
      expect(headers['Content-Length']).toBe('100');
    });

    it('answers 416 for an unsatisfiable range without opening a stream', async () => {
      service.openDownload.mockResolvedValue(streamFor('x'));
      // The size must be known before the range can be judged, so the metadata
      // lookup happens first and only the byte stream is skipped.
      service.openDownload.mockResolvedValueOnce(streamFor('x'));
      const res = responseDouble();

      await expect(
        controller.download(
          '507f1f77bcf86cd799439033',
          { range: 'bytes=5000-6000' },
          res as never,
        ),
      ).rejects.toThrow(/range/i);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/issues/issue-media.controller.spec.ts`
Expected: FAIL — `controller.download is not a function`.

- [ ] **Step 3: Write the route**

In `src/issues/issue-media.controller.ts`, widen the `@nestjs/common` import
with `Headers`, `HttpStatus`, `Res` and `RequestedRangeNotSatisfiableException`,
and add:

```ts
import { parseByteRange } from '../common/http/byte-range.js';
import type { Response } from 'express';
```

Then the route:

```ts
  /**
   * Public, so a plain <img> or <video> tag can load it with no token.
   *
   * Sits outside the :id prefix deliberately: a GridFS id is globally unique,
   * and routing bytes through the parent issue would invite a mismatched pair.
   */
  @Public()
  @Get('media/:mediaId')
  async download(
    @Param('mediaId', ParseObjectIdPipe) mediaId: string,
    @Headers() headers: Record<string, string | undefined>,
    @Res() res: Response,
  ): Promise<void> {
    // The file's size is needed before a range can be judged, so the metadata
    // is fetched first and the stream re-opened only once the range is known.
    const whole = await this.issueMediaService.openDownload(mediaId);
    const requested = parseByteRange(headers.range, whole.size);

    if (requested === 'unsatisfiable') {
      throw new RequestedRangeNotSatisfiableException(
        `Range is not satisfiable for a file of ${whole.size} bytes`,
      );
    }

    const media = requested
      ? await this.issueMediaService.openDownload(mediaId, requested)
      : whole;

    const length = requested
      ? requested.end - requested.start + 1
      : media.size;

    res.status(requested ? HttpStatus.PARTIAL_CONTENT : HttpStatus.OK).set({
      'Content-Type': media.contentType,
      'Content-Length': String(length),
      'Accept-Ranges': 'bytes',
      ...(requested
        ? {
            'Content-Range': `bytes ${requested.start}-${requested.end}/${media.size}`,
          }
        : {}),
    });

    media.stream.pipe(res);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/issues/issue-media.controller.spec.ts`
Expected: PASS.

- [ ] **Step 5: Verify a range request by hand**

With the server running and a file uploaded as in Task 4:

```bash
MEDIA=$(curl -s "localhost:9000/issues/$ISSUE/media" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8"))[0].id')

curl -s -D - -o /dev/null "localhost:9000/issues/media/$MEDIA"
curl -s -D - -o /dev/null -H 'Range: bytes=0-9' "localhost:9000/issues/media/$MEDIA"
curl -s -o /dev/null -w '%{http_code}\n' -H 'Range: bytes=99999-' "localhost:9000/issues/media/$MEDIA"
```

Expected: `200` with `Accept-Ranges: bytes`; then `206` with
`Content-Range: bytes 0-9/<size>` and `Content-Length: 10`; then `416`.

- [ ] **Step 6: Commit**

```bash
npm run format && npm run lint
git add src/issues
git commit -m "Serve issue media with byte range support"
```

---

### Task 6: Deletion, and media on issue responses

**Files:**
- Modify: `src/issues/issue-media.controller.ts`
- Modify: `src/issues/issue-media.controller.spec.ts`
- Modify: `src/issues/issue-response.ts`
- Modify: `src/issues/issue-response.spec.ts`
- Modify: `src/issues/issues.controller.ts`
- Modify: `src/issues/issues.controller.spec.ts`

**Interfaces:**
- Consumes: `IssueMediaService.remove`, `.listFor`, `.listForMany` (Task 3).
- Produces: `DELETE /issues/media/:mediaId`; `PublicIssue.media: PublicMedia[]`.

- [ ] **Step 1: Add the delete route**

In `src/issues/issue-media.controller.ts`, add `Delete`, `HttpCode` to the
`@nestjs/common` import and add:

```ts
  @Delete('media/:mediaId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('mediaId', ParseObjectIdPipe) mediaId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.issueMediaService.remove(mediaId, user.id);
  }
```

In `src/issues/issue-media.controller.spec.ts` add:

```ts
  it('passes the caller id to remove so ownership can be checked', async () => {
    service.remove.mockResolvedValue(undefined);

    await controller.remove('507f1f77bcf86cd799439033', caller);

    expect(service.remove).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439033',
      '507f1f77bcf86cd799439011',
    );
  });
```

- [ ] **Step 2: Widen the issue response**

In `src/issues/issue-response.ts`, add the import
`import { PublicMedia } from './issue-media-response.js';`, add the field to the
interface:

```ts
  media: PublicMedia[];
```

and give `toPublicIssue` a second parameter:

```ts
export function toPublicIssue(
  issue: IssueDocument,
  media: PublicMedia[] = [],
): PublicIssue {
```

adding `media,` to the returned object. The default keeps every existing caller
compiling and means an issue with no media reports an empty array rather than
omitting the field.

In `src/issues/issue-response.spec.ts`, add `media: []` to the expected object
in the first test, and add:

```ts
  it('carries the media it is given', () => {
    const media = [
      {
        id: 'abc',
        filename: 'culvert.png',
        contentType: 'image/png',
        size: 10,
        uploadedAt: new Date(),
        url: '/issues/media/abc',
      },
    ];

    expect(toPublicIssue(issueDoc(), media).media).toEqual(media);
  });

  it('defaults to an empty array rather than omitting the field', () => {
    expect(toPublicIssue(issueDoc()).media).toEqual([]);
  });
```

- [ ] **Step 3: Populate media in the issue routes**

In `src/issues/issues.controller.ts`, add
`import { IssueMediaService } from './issue-media.service.js';`, add it to the
constructor, and change the three read paths:

```ts
  @Public()
  @Get()
  async findAll(@Query() query: ListIssuesQuery) {
    const issues = await this.issuesService.findAll(query);
    // One query for the whole page rather than one per issue.
    const media = await this.issueMediaService.listForMany(
      issues.map((issue) => issue._id.toString()),
    );
    return issues.map((issue) =>
      toPublicIssue(issue, media.get(issue._id.toString()) ?? []),
    );
  }

  @Public()
  @Get(':id')
  async findOne(@Param('id', ParseObjectIdPipe) id: string) {
    const issue = await this.issuesService.findOne(id);
    return toPublicIssue(issue, await this.issueMediaService.listFor(id));
  }
```

`create`, `update` and `changeStatus` keep calling `toPublicIssue(issue)` with
no media argument: a freshly created issue has none, and a triage response is
about the status change.

In `src/issues/issues.controller.spec.ts`, add the new provider to the testing
module:

```ts
    const mediaService = { listFor: vi.fn(), listForMany: vi.fn() };
```

registered as `{ provide: IssueMediaService, useValue: mediaService }`, with
`mediaService.listForMany.mockResolvedValue(new Map());` and
`mediaService.listFor.mockResolvedValue([]);` in `beforeEach`. Add:

```ts
  it('fetches media for a whole page in one query', async () => {
    service.findAll.mockResolvedValue([issueDoc(), issueDoc()]);

    await controller.findAll({});

    expect(mediaService.listForMany).toHaveBeenCalledTimes(1);
    expect(mediaService.listFor).not.toHaveBeenCalled();
  });
```

- [ ] **Step 4: Run the unit suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run format && npm run lint
git add src/issues
git commit -m "Add media deletion and expose media on issue responses"
```

---

### Task 7: End-to-end coverage

Proves the whole path against real GridFS: bytes in, bytes out, byte-identical.

**Files:**
- Create: `test/fixtures/pixel.png`
- Create: `test/issue-media.e2e-spec.ts`

**Interfaces:**
- Consumes: every route from Tasks 4-6.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Create the fixture**

```bash
mkdir -p test/fixtures
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' \
  | base64 -d > test/fixtures/pixel.png
```

Expected: a 68-byte valid PNG.

There is no video fixture. The API never parses a video — it reads the MIME
type multer reports from the multipart part — so a few bytes declared as
`video/mp4` exercises exactly the same code path as a real clip, without
committing a binary.

- [ ] **Step 2: Write the e2e suite**

Create `test/issue-media.e2e-spec.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Connection } from 'mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { IssueCategory, IssueStatus, Role } from './../src/contracts/index.js';

const PASSWORD = 'super-secret';
const PIXEL = readFileSync(join(import.meta.dirname, 'fixtures/pixel.png'));

const ISSUE = {
  title: 'Collapsed culvert',
  description: 'Gave way after Sunday rain.',
  category: IssueCategory.DRAINAGE,
  location: 'School road',
};

describe('IssueMedia (e2e)', () => {
  let app: INestApplication<App>;
  let connection: Connection;
  let citizenToken: string;
  let otherCitizenToken: string;
  let agencyToken: string;
  let issueId: string;

  const login = async (email: string): Promise<string> => {
    const { body } = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return body.token;
  };

  const attach = (token: string, buffer = PIXEL, name = 'pixel.png', type = 'image/png') =>
    request(app.getHttpServer())
      .post(`/issues/${issueId}/media`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', buffer, { filename: name, contentType: type });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    connection = moduleFixture.get<Connection>(getConnectionToken());
    if (!connection.name.endsWith('_test')) {
      throw new Error(
        `Refusing to run destructive e2e tests against database "${connection.name}" ` +
          `— expected a database ending in "_test".`,
      );
    }

    // Actors are built once: each register/login pair is two bcrypt operations
    // at cost factor 12, about 2.5s.
    await connection.collection('users').deleteMany({});
    for (const email of ['citizen@x.test', 'other@x.test', 'agency@x.test']) {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ name: 'Test User', email, password: PASSWORD })
        .expect(201);
    }
    await connection
      .collection('users')
      .updateOne({ email: 'agency@x.test' }, { $set: { roles: [Role.AGENCY] } });

    citizenToken = await login('citizen@x.test');
    otherCitizenToken = await login('other@x.test');
    agencyToken = await login('agency@x.test');
  });

  beforeEach(async () => {
    await connection.collection('issues').deleteMany({});
    await connection.collection('issue_media.files').deleteMany({});
    await connection.collection('issue_media.chunks').deleteMany({});

    const { body } = await request(app.getHttpServer())
      .post('/issues')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send(ISSUE)
      .expect(201);
    issueId = body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('uploading', () => {
    it('stores an image and returns its metadata', async () => {
      const res = await attach(citizenToken).expect(201);

      expect(res.body).toMatchObject({
        filename: 'pixel.png',
        contentType: 'image/png',
        size: PIXEL.length,
      });
      expect(res.body.url).toBe(`/issues/media/${res.body.id}`);
    });

    it('accepts a video type', async () => {
      await attach(citizenToken, Buffer.from('fake mp4 bytes'), 'clip.mp4', 'video/mp4')
        .expect(201);
    });

    it('refuses an anonymous upload', async () => {
      await request(app.getHttpServer())
        .post(`/issues/${issueId}/media`)
        .attach('file', PIXEL, { filename: 'pixel.png', contentType: 'image/png' })
        .expect(401);
    });

    it('refuses a citizen who did not report the issue', async () => {
      await attach(otherCitizenToken).expect(403);
    });

    it('refuses a disallowed type with 415', async () => {
      await attach(citizenToken, Buffer.from('%PDF-1.4'), 'doc.pdf', 'application/pdf')
        .expect(415);
    });

    it('refuses a sixth file with 409', async () => {
      for (let i = 0; i < 5; i++) {
        await attach(citizenToken).expect(201);
      }
      await attach(citizenToken).expect(409);
    });

    it('refuses once the issue has left OPEN', async () => {
      await request(app.getHttpServer())
        .patch(`/issues/${issueId}/status`)
        .set('Authorization', `Bearer ${agencyToken}`)
        .send({ status: IssueStatus.REJECTED, reason: 'Private land' })
        .expect(200);

      await attach(citizenToken).expect(409);
    });

    it('rejects a request carrying no file', async () => {
      await request(app.getHttpServer())
        .post(`/issues/${issueId}/media`)
        .set('Authorization', `Bearer ${citizenToken}`)
        .expect(400);
    });
  });

  describe('serving', () => {
    it('returns the bytes unchanged, with no token', async () => {
      const { body: media } = await attach(citizenToken).expect(201);

      const res = await request(app.getHttpServer())
        .get(`/issues/media/${media.id}`)
        .expect(200)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });

      expect(res.headers['content-type']).toContain('image/png');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(Buffer.compare(res.body as Buffer, PIXEL)).toBe(0);
    });

    it('answers a range request with 206 and the right slice', async () => {
      const { body: media } = await attach(citizenToken).expect(201);

      const res = await request(app.getHttpServer())
        .get(`/issues/media/${media.id}`)
        .set('Range', 'bytes=0-9')
        .expect(206);

      expect(res.headers['content-range']).toBe(`bytes 0-9/${PIXEL.length}`);
      expect(res.headers['content-length']).toBe('10');
    });

    it('answers 416 for an unsatisfiable range', async () => {
      const { body: media } = await attach(citizenToken).expect(201);

      await request(app.getHttpServer())
        .get(`/issues/media/${media.id}`)
        .set('Range', 'bytes=99999-')
        .expect(416);
    });

    it('returns 404 for an unknown media id', async () => {
      await request(app.getHttpServer())
        .get('/issues/media/000000000000000000000000')
        .expect(404);
    });
  });

  describe('listing', () => {
    it('lists metadata publicly', async () => {
      await attach(citizenToken).expect(201);

      const res = await request(app.getHttpServer())
        .get(`/issues/${issueId}/media`)
        .expect(200);

      expect(res.body).toHaveLength(1);
    });

    it('carries media on the issue detail', async () => {
      await attach(citizenToken).expect(201);

      const res = await request(app.getHttpServer())
        .get(`/issues/${issueId}`)
        .expect(200);

      expect(res.body.media).toHaveLength(1);
    });

    it('carries media on the issue listing', async () => {
      await attach(citizenToken).expect(201);

      const res = await request(app.getHttpServer()).get('/issues').expect(200);

      const found = res.body.find((i: { id: string }) => i.id === issueId);
      expect(found.media).toHaveLength(1);
    });

    it('has an index on metadata.issueId, so listing is not a scan', async () => {
      await attach(citizenToken).expect(201);

      const indexes = await connection
        .collection('issue_media.files')
        .indexes();

      expect(
        indexes.some((i) => i.key['metadata.issueId'] === 1),
      ).toBe(true);
    });

    it('reports an empty array for an issue with no media', async () => {
      const res = await request(app.getHttpServer())
        .get(`/issues/${issueId}`)
        .expect(200);

      expect(res.body.media).toEqual([]);
    });
  });

  describe('deleting', () => {
    it('removes the file and its chunks', async () => {
      const { body: media } = await attach(citizenToken).expect(201);

      await request(app.getHttpServer())
        .delete(`/issues/media/${media.id}`)
        .set('Authorization', `Bearer ${citizenToken}`)
        .expect(204);

      await request(app.getHttpServer())
        .get(`/issues/media/${media.id}`)
        .expect(404);

      expect(
        await connection.collection('issue_media.chunks').countDocuments(),
      ).toBe(0);
    });

    it('refuses a citizen who did not report the issue', async () => {
      const { body: media } = await attach(citizenToken).expect(201);

      await request(app.getHttpServer())
        .delete(`/issues/media/${media.id}`)
        .set('Authorization', `Bearer ${otherCitizenToken}`)
        .expect(403);
    });
  });
});
```

- [ ] **Step 3: Run the e2e suite**

```bash
docker compose up -d
npm run test:e2e
```

Expected: PASS, all suites. If the whole run creeps past about two minutes,
check that the actors are still built in `beforeAll` and not per test.

- [ ] **Step 4: Commit**

```bash
npm run format && npm run lint
git add test/fixtures test/issue-media.e2e-spec.ts
git commit -m "Add issue media e2e coverage"
```

---

### Task 8: Postman and documentation

**Files:**
- Modify: `postman/civicon-auth.postman_collection.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: every route from Tasks 4-6.
- Produces: nothing.

- [ ] **Step 1: Document the endpoints**

In `README.md`, inside the existing `## Issues` section and immediately before
its closing code block, add:

````markdown
### Media

A reporter can attach photographs and short video to their own issue while it is
still `OPEN`. Anyone can view them — the bytes are public, so a plain `<img>` or
`<video src>` works with no token.

| Route | Access |
|---|---|
| `POST /issues/:id/media` | the reporter, while `OPEN` — multipart, field `file` |
| `GET /issues/:id/media` | public — metadata only |
| `GET /issues/media/:mediaId` | public — the bytes, with `Range` support |
| `DELETE /issues/media/:mediaId` | the reporter, while `OPEN` |

Limits, all defined in [`src/contracts/issue-media.ts`](src/contracts/issue-media.ts):
5 files per issue; images up to 5MB (`jpeg`, `png`, `webp`); video up to 50MB
(`mp4`, `webm`). A disallowed type is 415, an oversize file 413, a sixth file 409.

Bytes live in a GridFS bucket in the same MongoDB — a 50MB video cannot be a
document field, since that exceeds the 16MB BSON limit. Range requests are
honoured, so a browser can seek in a video rather than download it whole.
`IssueMediaService` is the only file that knows any of this, which is what keeps
a move to object storage a one-file change.

```bash
curl -X POST localhost:9000/issues/$ISSUE_ID/media \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@culvert.jpg;type=image/jpeg"
```
````

- [ ] **Step 2: Add the Postman requests**

Add a folder named `Issue media` to the collection, positioned after
`Issues — guardrails`, containing these requests in order. Each carries a test
script asserting its status code, matching the style of the existing folders.
The upload requests use `"mode": "formdata"` with a `"type": "file"` entry whose
`src` the user points at a local file.

1. **Attach a photo** — `POST {{base_url}}/issues/{{issue_id}}/media`, bearer
   `{{citizen_token}}`, formdata field `file`. Test: 201, and
   `pm.collectionVariables.set('media_id', pm.response.json().id);`
2. **List media — no token needed** — `GET {{base_url}}/issues/{{issue_id}}/media`,
   noauth. Test: 200, array.
3. **Fetch the bytes — no token needed** — `GET {{base_url}}/issues/media/{{media_id}}`,
   noauth. Test: 200, and `Accept-Ranges` is `bytes`.
4. **Fetch a byte range** — same URL with header `Range: bytes=0-9`. Test: 206,
   and `Content-Range` is present.
5. **A stranger cannot attach** — bearer `{{other_citizen_token}}`. Test: 403.
6. **An anonymous upload is refused** — noauth. Test: 401.
7. **Delete the photo** — `DELETE {{base_url}}/issues/media/{{media_id}}`, bearer
   `{{citizen_token}}`. Test: 204.

Add a `media_id` collection variable, described as "Set by 'Attach a photo'."

Note: the two upload requests need a local file selected in the Postman UI, so
they cannot run unattended in `postman collection run`. Give each a description
saying so, and keep requests 2-6 independent of them where possible.

- [ ] **Step 3: Verify the collection still runs**

```bash
docker compose up -d && npm run seed && node dist/main.js &
postman collection run postman/civicon-auth.postman_collection.json \
  -e postman/civicon-local.postman_environment.json
```

Expected: the previously passing requests still pass. The file-upload requests
will fail without a selected file — that is expected and is why their
descriptions say so.

- [ ] **Step 4: Full verification**

```bash
npm run format && npm run lint
npm run build
npm run test
npm run test:e2e
```

Expected: all clean, all passing.

- [ ] **Step 5: Commit**

```bash
git add postman README.md
git commit -m "Document and exercise the issue media endpoints"
```
