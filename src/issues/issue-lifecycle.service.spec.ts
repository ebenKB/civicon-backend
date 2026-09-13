import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
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
    it.each([
      IssueStatus.CLAIMED,
      IssueStatus.IN_PROGRESS,
      IssueStatus.RESOLVED,
      IssueStatus.VERIFIED,
    ])('refuses OPEN -> %s, which belongs to a later slice', async (target) => {
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
});
