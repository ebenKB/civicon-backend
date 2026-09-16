import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { IssueStatus } from '../contracts/index.js';
import { IssueLifecycleService } from './issue-lifecycle.service.js';
import { IssuesService } from './issues.service.js';

const ISSUE_ID = '507f1f77bcf86cd799439011';
const OTHER_ID = '507f1f77bcf86cd799439022';

describe('IssueLifecycleService', () => {
  let service: IssueLifecycleService;
  let issuesService: { findOne: ReturnType<typeof vi.fn> };

  const issueAt = (status: IssueStatus) => ({
    status,
    save: vi.fn().mockImplementation(function (this: unknown) {
      return Promise.resolve(this);
    }),
  });

  beforeEach(async () => {
    issuesService = { findOne: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IssueLifecycleService,
        { provide: IssuesService, useValue: issuesService },
      ],
    }).compile();

    service = module.get<IssueLifecycleService>(IssueLifecycleService);
  });

  describe('allowed transitions', () => {
    it('rejects an OPEN issue when a reason is given', async () => {
      const issue = issueAt(IssueStatus.OPEN);
      issuesService.findOne.mockResolvedValue(issue);

      const result = await service.changeStatus(ISSUE_ID, {
        status: IssueStatus.REJECTED,
        reason: 'Not a municipal responsibility',
      });

      expect(result.status).toBe(IssueStatus.REJECTED);
      expect(result.statusReason).toBe('Not a municipal responsibility');
      expect(issue.save).toHaveBeenCalled();
    });

    it('marks an OPEN issue a duplicate of an existing issue', async () => {
      const issue = issueAt(IssueStatus.OPEN);
      issuesService.findOne
        .mockResolvedValueOnce(issue)
        .mockResolvedValueOnce(issueAt(IssueStatus.OPEN));

      const result = await service.changeStatus(ISSUE_ID, {
        status: IssueStatus.DUPLICATE,
        duplicateOf: OTHER_ID,
      });

      expect(result.status).toBe(IssueStatus.DUPLICATE);
      expect(result.duplicateOf?.toString()).toBe(OTHER_ID);
    });
  });

  describe('refused transitions', () => {
    // CLAIMED left this list when claiming shipped; the rest still have no
    // path out of OPEN, and reaching them requires going through a claim.
    it.each([
      IssueStatus.IN_PROGRESS,
      IssueStatus.RESOLVED,
      IssueStatus.VERIFIED,
    ])('refuses OPEN -> %s, which needs a claim first', async (target) => {
      issuesService.findOne.mockResolvedValue(issueAt(IssueStatus.OPEN));

      await expect(
        service.changeStatus(ISSUE_ID, { status: target }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses any move out of a terminal state', async () => {
      issuesService.findOne.mockResolvedValue(issueAt(IssueStatus.REJECTED));

      await expect(
        service.changeStatus(ISSUE_ID, { status: IssueStatus.OPEN }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses a transition to the current status rather than treating it as a no-op', async () => {
      issuesService.findOne.mockResolvedValue(issueAt(IssueStatus.OPEN));

      await expect(
        service.changeStatus(ISSUE_ID, { status: IssueStatus.OPEN }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('names both states in the refusal', async () => {
      issuesService.findOne.mockResolvedValue(issueAt(IssueStatus.OPEN));

      await expect(
        service.changeStatus(ISSUE_ID, { status: IssueStatus.VERIFIED }),
      ).rejects.toThrow(/OPEN.*VERIFIED/);
    });
  });

  describe('required companions', () => {
    it('requires a reason when rejecting', async () => {
      issuesService.findOne.mockResolvedValue(issueAt(IssueStatus.OPEN));

      await expect(
        service.changeStatus(ISSUE_ID, { status: IssueStatus.REJECTED }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requires duplicateOf when marking a duplicate', async () => {
      issuesService.findOne.mockResolvedValue(issueAt(IssueStatus.OPEN));

      await expect(
        service.changeStatus(ISSUE_ID, { status: IssueStatus.DUPLICATE }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses an issue that is a duplicate of itself', async () => {
      issuesService.findOne.mockResolvedValue(issueAt(IssueStatus.OPEN));

      await expect(
        service.changeStatus(ISSUE_ID, {
          status: IssueStatus.DUPLICATE,
          duplicateOf: ISSUE_ID,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('propagates the 404 when duplicateOf names an unknown issue', async () => {
      issuesService.findOne
        .mockResolvedValueOnce(issueAt(IssueStatus.OPEN))
        .mockRejectedValueOnce(new Error('Issue with id not found'));

      await expect(
        service.changeStatus(ISSUE_ID, {
          status: IssueStatus.DUPLICATE,
          duplicateOf: OTHER_ID,
        }),
      ).rejects.toThrow();
    });
  });
  describe('claim', () => {
    const REPORTER = '507f1f77bcf86cd799439011';
    const VOLUNTEER = '507f1f77bcf86cd799439044';

    const openIssue = (overrides: Record<string, unknown> = {}) => ({
      status: IssueStatus.OPEN,
      reportedBy: new Types.ObjectId(REPORTER),
      save: vi.fn().mockImplementation(function (this: unknown) {
        return Promise.resolve(this);
      }),
      ...overrides,
    });

    it('lets a citizen who is not the reporter take it', async () => {
      issuesService.findOne.mockResolvedValue(openIssue());

      const result = await service.claim(ISSUE_ID, VOLUNTEER);

      expect(result.status).toBe(IssueStatus.CLAIMED);
      expect(result.volunteerId?.toString()).toBe(VOLUNTEER);
      expect(result.claimedAt).toBeInstanceOf(Date);
    });

    // The rule the Role contract exists to express: a reporter who could also
    // claim could approve their own work once points are on the line.
    it('refuses the reporter, naming the rule', async () => {
      issuesService.findOne.mockResolvedValue(openIssue());

      await expect(service.claim(ISSUE_ID, REPORTER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.claim(ISSUE_ID, REPORTER)).rejects.toThrow(
        /report/i,
      );
    });

    it('refuses an issue someone else already holds', async () => {
      issuesService.findOne.mockResolvedValue(
        openIssue({
          status: IssueStatus.CLAIMED,
          volunteerId: new Types.ObjectId(VOLUNTEER),
        }),
      );

      await expect(
        service.claim(ISSUE_ID, '507f1f77bcf86cd799439055'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('release', () => {
    const REPORTER = '507f1f77bcf86cd799439011';
    const VOLUNTEER = '507f1f77bcf86cd799439044';

    const heldIssue = (status = IssueStatus.CLAIMED) => ({
      status,
      reportedBy: new Types.ObjectId(REPORTER),
      volunteerId: new Types.ObjectId(VOLUNTEER),
      claimedAt: new Date(),
      save: vi.fn().mockImplementation(function (this: unknown) {
        return Promise.resolve(this);
      }),
    });

    it('returns the issue to OPEN and clears the holder', async () => {
      issuesService.findOne.mockResolvedValue(heldIssue());

      const result = await service.release(ISSUE_ID, VOLUNTEER);

      expect(result.status).toBe(IssueStatus.OPEN);
      expect(result.volunteerId).toBeUndefined();
      expect(result.claimedAt).toBeUndefined();
    });

    it('works from IN_PROGRESS too', async () => {
      issuesService.findOne.mockResolvedValue(
        heldIssue(IssueStatus.IN_PROGRESS),
      );

      const result = await service.release(ISSUE_ID, VOLUNTEER);

      expect(result.status).toBe(IssueStatus.OPEN);
    });

    it('refuses anyone but the holder', async () => {
      issuesService.findOne.mockResolvedValue(heldIssue());

      await expect(service.release(ISSUE_ID, REPORTER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('start', () => {
    const VOLUNTEER = '507f1f77bcf86cd799439044';

    const claimed = () => ({
      status: IssueStatus.CLAIMED,
      reportedBy: new Types.ObjectId('507f1f77bcf86cd799439011'),
      volunteerId: new Types.ObjectId(VOLUNTEER),
      save: vi.fn().mockImplementation(function (this: unknown) {
        return Promise.resolve(this);
      }),
    });

    it('moves a claimed issue to IN_PROGRESS', async () => {
      issuesService.findOne.mockResolvedValue(claimed());

      const result = await service.start(ISSUE_ID, VOLUNTEER);

      expect(result.status).toBe(IssueStatus.IN_PROGRESS);
    });

    it('refuses anyone but the holder', async () => {
      issuesService.findOne.mockResolvedValue(claimed());

      await expect(
        service.start(ISSUE_ID, '507f1f77bcf86cd799439055'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
