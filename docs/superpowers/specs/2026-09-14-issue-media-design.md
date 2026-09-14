# Issue Media — Design

**Status:** approved, not yet implemented
**Follows:** `docs/superpowers/specs/2026-09-13-issue-reporting-design.md`

## Goal

Let a citizen attach photographs and short video to an issue they reported, and
let anyone view that evidence without an account. A civic report that says "the
culvert collapsed" is an assertion; one with a photograph is evidence.

## Non-goals

- **Thumbnails, transcoding, or any media processing.** Bytes are stored and
  served exactly as uploaded.
- **Captions, ordering, alt text, moderation flags.** These are the fields that
  would justify a separate metadata collection; none exists yet. See §3.
- **Media on anything but an issue.** Proof-of-work attached to a resolution
  belongs to the claim slice, and may want different rules.
- **A CDN, signed URLs, or direct-to-storage upload.** Bytes go through the API.

## Context: what exists today

The reporting slice is complete: `IssuesService` for persistence,
`IssueLifecycleService` as the single writer of `status`, public read, and
reporter-only editing while an issue is `OPEN`.

Available and already proven in this codebase:

- `FileInterceptor` from `@nestjs/platform-express`; multer 2.2.0 is present
  transitively.
- `GridFSBucket` reached through `mongoose.mongo`, so no direct dependency on
  the `mongodb` package — the same route `MongoExceptionFilter` uses for driver
  error classes.
- `@Public()`, `@Roles()`, `@CurrentUser()`, `ParseObjectIdPipe`, the global
  `ValidationPipe` and `MongoExceptionFilter`.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Where bytes live | GridFS, in the existing MongoDB | One `docker compose up` brings up the whole stack; `_test` isolation and backups come for free. A 50MB video cannot be a `BinData` field — it exceeds the 16MB BSON document limit outright — so GridFS is not optional once video is in scope. |
| Why not `BinData` for images | Uniformity | Images at ≤5MB would fit in a document, but splitting storage by media type means two code paths, two retrieval shapes and two sets of tests, for no gain. |
| Metadata home | GridFS `metadata` subdocument | One record per file, so nothing can drift. An embedded `media[]` on the issue would make a half-failed delete leave an entry pointing at bytes that are gone. |
| Upload flow | Two-step: create the issue, then `POST /issues/:id/media` | `CreateIssueDto` is untouched, a failed 50MB upload does not lose the report, and a reporter can add a photo later. |
| Files per issue | 5 | |
| Size caps | Images 5MB, video 50MB | |
| Types | jpeg, png, webp; mp4, webm | An allowlist, not a blocklist. |
| Upload permission | The reporter, only while the issue is `OPEN` | Mirrors the editing rule exactly: evidence freezes when an agency acts on what it read. |
| View permission | `@Public()` | Matches the issue text around it, and lets a plain `<img>` or `<video>` tag load it with no token. |
| Range requests | Supported | What makes a browser able to seek in a video rather than download 50MB first. |

## 1. Contracts

`src/contracts/issue-media.ts`, re-exported from `index.ts`:

```ts
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

export const MEDIA_BUCKET = 'issue_media';
```

One definition, so the interceptor, the service, the tests and the docs cannot
disagree about a number.

## 2. Storage

A single GridFS bucket named `issue_media`, giving `issue_media.files` and
`issue_media.chunks`. Default 255KB chunks.

Each file's `metadata` subdocument carries:

```ts
{ issueId: ObjectId, uploadedBy: ObjectId }
```

`filename`, `contentType`, `length` and `uploadDate` are GridFS's own fields;
none is restated.

Index: `{ 'metadata.issueId': 1 }` on `issue_media.files`, serving both the
per-issue listing and the cap count.

## 3. Why no separate collection

`issue_media.files` already holds every field this slice needs. A parallel
`issue_media` collection would restate them and introduce the possibility of
disagreeing with the bucket.

That calculation changes the moment media gains fields GridFS does not model —
captions, display order, moderation state. When that happens, add the collection
then; it is an additive migration, and the service boundary in §4 means only one
file changes.

## 4. Module layout

Inside the existing `src/issues/`:

```
issue-media.service.ts        the only code that touches GridFS
issue-media.controller.ts     the four routes
issue-media-response.ts       toPublicMedia()
dto/upload-media.dto.ts       (none — the payload is multipart, validated in the service)
```

`IssueMediaService` is the seam. Its public surface is deliberately storage-
agnostic:

```ts
upload(issueId: string, actorId: string, file: UploadedFile): Promise<PublicMedia>
listFor(issueId: string): Promise<PublicMedia[]>
listForMany(issueIds: string[]): Promise<Map<string, PublicMedia[]>>
openDownload(mediaId: string, range?: ByteRange): Promise<MediaStream>
remove(mediaId: string, actorId: string): Promise<void>
```

The three parameter types are declared alongside the service, deliberately
structural rather than storage- or framework-shaped:

```ts
/** The four fields we use from a parsed upload. Declared here rather than
 *  taken from Express.Multer.File so the service does not depend on the HTTP
 *  layer — and so the S3 swap need not re-type its input. */
export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface ByteRange {
  start: number;
  end: number;
}

export interface MediaStream {
  stream: NodeJS.ReadableStream;
  contentType: string;
  size: number;        // total size of the file, not of the slice
  range?: ByteRange;   // present when this is a partial response
}
```

Moving to S3 later replaces the body of this one file. Nothing else in the
codebase mentions GridFS.

`IssueMediaService` depends on `IssuesService.findOne` for the ownership and
`OPEN` checks, exactly as `IssueLifecycleService` does — those rules are stated
once, in the service that owns them, and reused.

## 5. API

| Route | Access | Success | Notes |
|---|---|---|---|
| `POST /issues/:id/media` | reporter, issue `OPEN` | 201 | multipart, one file, field name `file` |
| `GET /issues/:id/media` | `@Public()` | 200 | metadata only |
| `GET /issues/media/:mediaId` | `@Public()` | 200 / 206 | the bytes |
| `DELETE /issues/media/:mediaId` | reporter, issue `OPEN` | 204 | removes file and chunks |

`GET /issues/media/:mediaId` sits outside the `:id` prefix deliberately: a
GridFS id is globally unique, and routing bytes through the parent issue would
invite a mismatched pair that resolves to something the caller did not ask for.

`GET /issues/:id` gains `media: PublicMedia[]`. `GET /issues` populates the same
field using one batched `$in` query across the page of issues, so listing costs
one extra query rather than one per issue.

```ts
interface PublicMedia {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  uploadedAt: Date;
  url: string;        // "/issues/media/<id>", ready to put in a src attribute
}
```

### Dependencies

One devDependency: **`@types/multer`**, for the controller's `@UploadedFile()`
parameter. multer 2.2.0 is already present transitively but ships no types of
its own.

It is confined to the controller. `IssueMediaService` takes the `UploadedFile`
interface above, so the service — the part that survives a storage change — has
no multer dependency at all, typed or otherwise.

## 6. Validation

Three checks, in this order — the order matters, because the first one is what
stops a hostile 2GB upload from being buffered at all:

1. **multer `limits.fileSize`**, set to the *larger* ceiling (50MB). Parsing
   aborts past it. This is a single number and cannot be per-type, which is why
   step 3 exists.
2. **MIME type** against the allowlist. Anything else is rejected.
3. **Per-type byte cap** — 5MB for images, 50MB for video — now that the type is
   known.

Then the ownership and state checks (reporter, issue `OPEN`), and the per-issue
count.

## 7. Error contract

| Condition | Status |
|---|---|
| Malformed `:id` or `:mediaId` | 400 |
| No token on upload or delete | 401 |
| Not the reporter | 403 |
| Unknown issue or media | 404 |
| Issue is not `OPEN` | 409 |
| Sixth file on an issue | 409 |
| Disallowed MIME type | 415 |
| Over the per-type byte cap | 413 |
| Malformed or unsatisfiable `Range` header | 416 |

413 and 415 are the two codes this slice adds to the project's vocabulary; every
other row reuses a rule the reporting slice already established.

## 8. Serving and range requests

`GET /issues/media/:mediaId` sets `Content-Type` from the stored value,
`Content-Length`, and `Accept-Ranges: bytes`.

Given a `Range: bytes=start-end` header it answers **206** with `Content-Range`
and streams only that span, via `openDownloadStream`'s `start`/`end` options. A
malformed or unsatisfiable range is **416**.

Without this a browser cannot seek in a video and must download the whole file
before playing — the single most visible difference in a demo.

## 9. Testing

Unit, no database:

- The limit rules: each allowed type accepted, a disallowed one rejected, an
  image over 5MB rejected, a video under 50MB accepted, a video over 50MB
  rejected.
- `IssueMediaService` against a mocked bucket: metadata is written with the
  issue and actor; a non-reporter is refused; a non-`OPEN` issue is refused; the
  sixth upload is refused.
- Range header parsing, including a malformed one.

e2e, against the `_test` database, using small real fixtures (a few-hundred-byte
PNG and a minimal MP4 committed under `test/fixtures/`):

- Upload, then fetch the bytes back with no token and compare them to the
  fixture.
- The metadata list, and `media[]` appearing on `GET /issues/:id`.
- A `Range` request returning 206 with the right `Content-Range` and body slice.
- Every refusal in §7 that does not require a 50MB payload.
- Delete removes both the file and its chunks.

The oversize cases are asserted against the limit rules in unit tests rather
than by uploading 50MB in e2e; the suite already runs long enough.

## 10. Risks

| Risk | Mitigation |
|---|---|
| multer buffers the upload in memory, so a 50MB video briefly occupies 50MB of RAM | Accepted. Streaming from the parser straight into GridFS avoids it but is materially more code. At five files and demo traffic this is the right trade; revisit if concurrency rises. |
| GridFS serves bytes from the same database and connection pool that serves queries | Documented, not solved. This is the known ceiling of the storage choice: fine for a demo, wrong for volume. The `IssueMediaService` boundary is what makes moving to S3 a one-file change. |
| Five 50MB videos is 250MB for a single issue | The cap is deliberate and lives in one constant. Lower `maxPerIssue` or `video.maxBytes` if the database grows uncomfortably. |
| Deleting an issue would orphan its files | No `DELETE /issues/:id` exists — a civic record is not erasable — so nothing orphans them today. Any future deletion path must delete media first. |
| `@Public()` bytes mean an unauthenticated stranger can pull 50MB repeatedly | Real, and unaddressed here for the same reason login rate limiting is: it is the throttling gap already recorded in the auth spec. Worth pairing when that is picked up. |

## Definition of Done

- A reporter can attach a photo and a video to their own `OPEN` issue; another
  citizen gets 403 and a non-`OPEN` issue gets 409.
- The bytes come back byte-identical with no token, and a `Range` request
  returns 206 with the correct slice.
- A sixth file is 409, a disallowed type is 415, an oversize file is 413.
- `GET /issues/:id` carries `media[]`, and `GET /issues` costs one extra query
  for the whole page rather than one per issue.
- GridFS is named in exactly one file.
- `npm run test`, `npm run test:e2e` and `npm run lint` all pass.
