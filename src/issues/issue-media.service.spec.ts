import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { HazardLevel, IssueStatus, MediaPurpose, Role } from '../contracts/index.js';
import { IssueMediaService } from './issue-media.service.js';
import { IssuesService } from './issues.service.js';
import { extractFrames } from './video-frames.js';

// Decoding is exercised against a real clip in video-frames.spec.ts. What this
// file tests is which files reach the decoder, so the decoder itself is a stub.
vi.mock('./video-frames.js', () => ({ extractFrames: vi.fn() }));

const extractFramesMock = vi.mocked(extractFrames);

const REPORTER = '507f1f77bcf86cd799439011';
const STRANGER = '507f1f77bcf86cd799439099';
const AGENCY_USER = '507f1f77bcf86cd799439077';
const ISSUE_ID = '507f1f77bcf86cd799439022';

const fileDoc = (overrides: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  filename: 'culvert.png',
  length: 1234,
  uploadDate: new Date('2026-09-14T10:00:00Z'),
  metadata: {
    issueId: new Types.ObjectId(ISSUE_ID),
    uploadedBy: new Types.ObjectId(REPORTER),
    contentType: 'image/png',
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
  const cursorOf = (docs: unknown[]) => ({
    toArray: () => Promise.resolve(docs),
  });

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
        service.upload(ISSUE_ID, STRANGER, anImage(), [Role.CITIZEN]),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses an issue that has left OPEN', async () => {
      issuesService.findOne.mockResolvedValue({
        ...openIssue(),
        status: IssueStatus.REJECTED,
      });

      await expect(
        service.upload(ISSUE_ID, REPORTER, anImage(), [Role.CITIZEN]),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses a disallowed type with 415', async () => {
      issuesService.findOne.mockResolvedValue(openIssue());
      bucket.find.mockReturnValue(cursorOf([]));

      await expect(
        service.upload(
          ISSUE_ID,
          REPORTER,
          {
            ...anImage(),
            mimetype: 'application/pdf',
          },
          [Role.CITIZEN],
        ),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    });

    it('refuses an oversize image with 413', async () => {
      issuesService.findOne.mockResolvedValue(openIssue());
      bucket.find.mockReturnValue(cursorOf([]));

      await expect(
        service.upload(ISSUE_ID, REPORTER, anImage(6 * 1024 * 1024), [
          Role.CITIZEN,
        ]),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
    });

    it('refuses the sixth file on an issue', async () => {
      issuesService.findOne.mockResolvedValue(openIssue());
      bucket.find.mockReturnValue(
        cursorOf([1, 2, 3, 4, 5].map(() => fileDoc())),
      );

      await expect(
        service.upload(ISSUE_ID, REPORTER, anImage(), [Role.CITIZEN]),
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
        service.remove(new Types.ObjectId().toString(), STRANGER, [
          Role.CITIZEN,
        ]),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(bucket.delete).not.toHaveBeenCalled();
    });

    it('deletes the file and its chunks for the reporter', async () => {
      const doc = fileDoc();
      bucket.find.mockReturnValue(cursorOf([doc]));
      issuesService.findOne.mockResolvedValue(openIssue());

      await service.remove(doc._id.toString(), REPORTER, [Role.CITIZEN]);

      expect(bucket.delete).toHaveBeenCalledWith(doc._id);
    });

    it('throws NotFoundException for an unknown media id', async () => {
      bucket.find.mockReturnValue(cursorOf([]));

      await expect(
        service.remove(new Types.ObjectId().toString(), REPORTER, [
          Role.CITIZEN,
        ]),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    // The RESTRICTED gate added for attaching new evidence must not also
    // block a reporter from removing a report photo they attached before the
    // issue was ever classified — that worked before this slice.
    it('lets the reporter remove their own report photo on a restricted issue', async () => {
      const doc = fileDoc();
      bucket.find.mockReturnValue(cursorOf([doc]));
      issuesService.findOne.mockResolvedValue({
        _id: new Types.ObjectId(ISSUE_ID),
        status: IssueStatus.OPEN,
        hazard: HazardLevel.RESTRICTED,
        reportedBy: new Types.ObjectId(REPORTER),
      });

      await service.remove(doc._id.toString(), REPORTER, [Role.CITIZEN]);

      expect(bucket.delete).toHaveBeenCalledWith(doc._id);
    });

    it('lets an agency remove proof it attached to a restricted issue', async () => {
      const doc = fileDoc();
      bucket.find.mockReturnValue(cursorOf([doc]));
      issuesService.findOne.mockResolvedValue({
        _id: new Types.ObjectId(ISSUE_ID),
        status: IssueStatus.OPEN,
        hazard: HazardLevel.RESTRICTED,
        reportedBy: new Types.ObjectId(REPORTER),
      });

      await service.remove(doc._id.toString(), AGENCY_USER, [Role.AGENCY]);

      expect(bucket.delete).toHaveBeenCalledWith(doc._id);
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
  describe('purpose', () => {
    const claimedIssue = (volunteerId: string) => ({
      _id: new Types.ObjectId(ISSUE_ID),
      reportedBy: new Types.ObjectId(REPORTER),
      volunteerId: new Types.ObjectId(volunteerId),
      status: IssueStatus.CLAIMED,
    });

    it('refuses a non-holder while the issue is claimed', async () => {
      issuesService.findOne.mockResolvedValue(claimedIssue(STRANGER));

      await expect(
        service.upload(ISSUE_ID, REPORTER, anImage(), [Role.CITIZEN]),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses anyone once the issue is resolved', async () => {
      issuesService.findOne.mockResolvedValue({
        ...claimedIssue(STRANGER),
        status: IssueStatus.RESOLVED,
      });

      await expect(
        service.upload(ISSUE_ID, STRANGER, anImage(), [Role.CITIZEN]),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    // A restricted issue has no volunteer and never will, so the agency doing
    // the work is the one attaching the evidence.
    it('lets an agency attach proof to a restricted issue', async () => {
      issuesService.findOne.mockResolvedValue({
        _id: new Types.ObjectId(ISSUE_ID),
        status: IssueStatus.OPEN,
        hazard: HazardLevel.RESTRICTED,
        reportedBy: new Types.ObjectId(REPORTER),
      });

      const stream = new EventEmitter() as EventEmitter & {
        id: Types.ObjectId;
        end: (buf: Buffer) => void;
      };
      stream.id = new Types.ObjectId();
      stream.end = () => stream.emit('finish');
      bucket.openUploadStream.mockReturnValue(stream);

      // First find() is the existing-count check, the second is the
      // post-upload lookup keyed by the new file's _id.
      bucket.find.mockImplementation((filter: Record<string, unknown>) =>
        filter._id
          ? cursorOf([
              fileDoc({
                _id: stream.id,
                metadata: {
                  issueId: new Types.ObjectId(ISSUE_ID),
                  uploadedBy: new Types.ObjectId(AGENCY_USER),
                  contentType: 'image/png',
                  purpose: MediaPurpose.PROOF,
                },
              }),
            ])
          : cursorOf([]),
      );

      await service.upload(ISSUE_ID, AGENCY_USER, anImage(), [Role.AGENCY]);

      // Asserted on what assertMayAttach actually decided — the metadata
      // written to the new file — rather than on the mocked post-upload
      // lookup, which would pass even if the wrong purpose were returned.
      const [, options] = bucket.openUploadStream.mock.calls[0];
      expect(options.metadata.purpose).toBe(MediaPurpose.PROOF);
    });

    it('still refuses a citizen on a restricted issue', async () => {
      issuesService.findOne.mockResolvedValue({
        _id: new Types.ObjectId(ISSUE_ID),
        status: IssueStatus.OPEN,
        hazard: HazardLevel.RESTRICTED,
        reportedBy: new Types.ObjectId(REPORTER),
      });

      await expect(
        service.upload(ISSUE_ID, REPORTER, anImage(), [Role.CITIZEN]),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('countProofBy', () => {
    it("counts only the named volunteer's proof", async () => {
      bucket.find.mockReturnValue(cursorOf([fileDoc(), fileDoc()]));

      await service.countProofBy(ISSUE_ID, REPORTER);

      const [filter] = bucket.find.mock.calls[0];
      expect(filter['metadata.purpose']).toBe(MediaPurpose.PROOF);
      expect(filter['metadata.uploadedBy'].toString()).toBe(REPORTER);
      expect(filter['metadata.issueId'].toString()).toBe(ISSUE_ID);
    });
  });
  describe('readForAssessment', () => {
    const asStream = () => Readable.from([Buffer.from('bytes')]);

    const withPurpose = (
      purpose: MediaPurpose,
      uploader: string,
      type = 'image/png',
    ) =>
      fileDoc({
        metadata: {
          issueId: new Types.ObjectId(ISSUE_ID),
          uploadedBy: new Types.ObjectId(uploader),
          contentType: type,
          purpose,
        },
      });

    beforeEach(() => {
      bucket.openDownloadStream = vi.fn(() => asStream());
      extractFramesMock.mockReset();
    });

    it('splits the reporter photos from the current holder proof', async () => {
      bucket.find.mockReturnValue(
        cursorOf([
          withPurpose(MediaPurpose.REPORT, REPORTER),
          withPurpose(MediaPurpose.PROOF, STRANGER),
        ]),
      );

      const result = await service.readForAssessment(ISSUE_ID, STRANGER, 2);

      expect(result.before).toHaveLength(1);
      expect(result.after).toHaveLength(1);
      expect(result.before[0].base64).toBe(
        Buffer.from('bytes').toString('base64'),
      );
    });

    // Proof is read by author, so a previous volunteer's photo is not evidence
    // for this one.
    it('ignores proof uploaded by someone other than the holder', async () => {
      bucket.find.mockReturnValue(
        cursorOf([withPurpose(MediaPurpose.PROOF, REPORTER)]),
      );

      const result = await service.readForAssessment(ISSUE_ID, STRANGER, 2);

      expect(result.after).toHaveLength(0);
    });

    it('caps each side, because base64 inflates by a third', async () => {
      bucket.find.mockReturnValue(
        cursorOf(
          Array.from({ length: 5 }, () =>
            withPurpose(MediaPurpose.REPORT, REPORTER),
          ),
        ),
      );

      const result = await service.readForAssessment(ISSUE_ID, STRANGER, 2);

      expect(result.before).toHaveLength(2);
    });

    // A side proved only by video used to yield nothing, which meant an
    // assessment against no evidence at all.
    it('falls back to frames from a video when a side has no photographs', async () => {
      extractFramesMock.mockResolvedValue([
        Buffer.from('frame-one'),
        Buffer.from('frame-two'),
      ]);
      bucket.find.mockReturnValue(
        cursorOf([withPurpose(MediaPurpose.REPORT, REPORTER, 'video/mp4')]),
      );

      const result = await service.readForAssessment(ISSUE_ID, STRANGER, 2);

      expect(result.before).toHaveLength(2);
      expect(result.before[0]).toEqual({
        base64: Buffer.from('frame-one').toString('base64'),
        contentType: 'image/jpeg',
      });
    });

    it('prefers photographs and leaves the video undecoded', async () => {
      bucket.find.mockReturnValue(
        cursorOf([
          withPurpose(MediaPurpose.REPORT, REPORTER),
          withPurpose(MediaPurpose.REPORT, REPORTER, 'video/mp4'),
        ]),
      );

      const result = await service.readForAssessment(ISSUE_ID, STRANGER, 2);

      expect(result.before).toHaveLength(1);
      expect(extractFramesMock).not.toHaveBeenCalled();
    });

    it('yields nothing for a side whose video cannot be decoded', async () => {
      extractFramesMock.mockResolvedValue([]);
      bucket.find.mockReturnValue(
        cursorOf([withPurpose(MediaPurpose.PROOF, STRANGER, 'video/webm')]),
      );

      const result = await service.readForAssessment(ISSUE_ID, STRANGER, 2);

      expect(result.after).toHaveLength(0);
    });
  });

  describe('readReportImages', () => {
    it('returns the reporter photographs and nothing else', async () => {
      bucket.openDownloadStream = vi.fn(() => Readable.from([Buffer.from('bytes')]));
      bucket.find.mockReturnValue(
        cursorOf([
          fileDoc({
            metadata: {
              issueId: new Types.ObjectId(ISSUE_ID),
              uploadedBy: new Types.ObjectId(REPORTER),
              contentType: 'image/png',
              purpose: MediaPurpose.REPORT,
            },
          }),
          fileDoc({
            metadata: {
              issueId: new Types.ObjectId(ISSUE_ID),
              uploadedBy: new Types.ObjectId(STRANGER),
              contentType: 'image/png',
              purpose: MediaPurpose.PROOF,
            },
          }),
        ]),
      );

      const images = await service.readReportImages(ISSUE_ID, 2);

      expect(images).toHaveLength(1);
      expect(images[0].contentType).toBe('image/png');
    });
  });
});
