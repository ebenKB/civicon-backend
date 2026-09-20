import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import {
  AiOutcome,
  IssueStatus,
  HazardLevel,
  Role,
} from '../contracts/index.js';
import { CivicPointsService } from '../points/civic-points.service.js';
import { IssueLifecycleService } from './issue-lifecycle.service.js';
import { IssueMediaService } from './issue-media.service.js';
import { IssueVerificationService } from './issue-verification.service.js';
import { IssuesService } from './issues.service.js';

const ISSUE_ID = '507f1f77bcf86cd799439011';
const OTHER_ID = '507f1f77bcf86cd799439022';
// The agency actor for changeStatus calls below. Distinct from every
// volunteer id used in this file, so the self-verification check never
// fires for behaviour these tests are not about.
const ACTOR_ID = '507f1f77bcf86cd799439099';

describe('IssueLifecycleService', () => {
  let service: IssueLifecycleService;
  let issuesService: { findOne: ReturnType<typeof vi.fn> };
  let mediaService: { countProofBy: ReturnType<typeof vi.fn> };
  let verificationService: { assess: ReturnType<typeof vi.fn> };
  let pointsService: {
    awardForVerification: ReturnType<typeof vi.fn>;
    reverseForVerification: ReturnType<typeof vi.fn>;
  };

  const issueAt = (status: IssueStatus) => ({
    status,
    save: vi.fn().mockImplementation(function (this: unknown) {
      return Promise.resolve(this);
    }),
  });

  beforeEach(async () => {
    issuesService = { findOne: vi.fn() };
    mediaService = { countProofBy: vi.fn().mockResolvedValue(1) };
    verificationService = { assess: vi.fn().mockResolvedValue(undefined) };
    pointsService = {
      awardForVerification: vi.fn(),
      reverseForVerification: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IssueLifecycleService,
        { provide: IssuesService, useValue: issuesService },
        { provide: IssueMediaService, useValue: mediaService },
        {
          provide: IssueVerificationService,
          useValue: verificationService,
        },
        { provide: CivicPointsService, useValue: pointsService },
      ],
    }).compile();

    service = module.get<IssueLifecycleService>(IssueLifecycleService);
  });

  describe('allowed transitions', () => {
    it('rejects an OPEN issue when a reason is given', async () => {
      const issue = issueAt(IssueStatus.OPEN);
      issuesService.findOne.mockResolvedValue(issue);

      const result = await service.changeStatus(
        ISSUE_ID,
        {
          status: IssueStatus.REJECTED,
          reason: 'Not a municipal responsibility',
        },
        ACTOR_ID,
      );

      expect(result.status).toBe(IssueStatus.REJECTED);
      expect(result.statusReason).toBe('Not a municipal responsibility');
      expect(issue.save).toHaveBeenCalled();
    });

    it('marks an OPEN issue a duplicate of an existing issue', async () => {
      const issue = issueAt(IssueStatus.OPEN);
      issuesService.findOne
        .mockResolvedValueOnce(issue)
        .mockResolvedValueOnce(issueAt(IssueStatus.OPEN));

      const result = await service.changeStatus(
        ISSUE_ID,
        {
          status: IssueStatus.DUPLICATE,
          duplicateOf: OTHER_ID,
        },
        ACTOR_ID,
      );

      expect(result.status).toBe(IssueStatus.DUPLICATE);
      expect(result.duplicateOf?.toString()).toBe(OTHER_ID);
    });
  });

  describe('refused transitions', () => {
    // CLAIMED left this list when claiming shipped. RESOLVED left it too, but
    // for a different reason: it is refused as 403 because no agency may set it
    // at all (see 'the agency verdict'), never reaching the transition check.
    it.each([IssueStatus.IN_PROGRESS, IssueStatus.VERIFIED])(
      'refuses OPEN -> %s, which needs a claim first',
      async (target) => {
        issuesService.findOne.mockResolvedValue(issueAt(IssueStatus.OPEN));

        await expect(
          service.changeStatus(ISSUE_ID, { status: target }, ACTOR_ID),
        ).rejects.toBeInstanceOf(ConflictException);
      },
    );

    it('refuses any move out of a terminal state', async () => {
      issuesService.findOne.mockResolvedValue(issueAt(IssueStatus.REJECTED));

      await expect(
        service.changeStatus(ISSUE_ID, { status: IssueStatus.OPEN }, ACTOR_ID),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses a transition to the current status rather than treating it as a no-op', async () => {
      issuesService.findOne.mockResolvedValue(issueAt(IssueStatus.OPEN));

      await expect(
        service.changeStatus(ISSUE_ID, { status: IssueStatus.OPEN }, ACTOR_ID),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('names both states in the refusal', async () => {
      issuesService.findOne.mockResolvedValue(issueAt(IssueStatus.OPEN));

      await expect(
        service.changeStatus(
          ISSUE_ID,
          { status: IssueStatus.VERIFIED },
          ACTOR_ID,
        ),
      ).rejects.toThrow(/OPEN.*VERIFIED/);
    });
  });

  describe('required companions', () => {
    it('requires a reason when rejecting', async () => {
      issuesService.findOne.mockResolvedValue(issueAt(IssueStatus.OPEN));

      await expect(
        service.changeStatus(
          ISSUE_ID,
          { status: IssueStatus.REJECTED },
          ACTOR_ID,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requires duplicateOf when marking a duplicate', async () => {
      issuesService.findOne.mockResolvedValue(issueAt(IssueStatus.OPEN));

      await expect(
        service.changeStatus(
          ISSUE_ID,
          { status: IssueStatus.DUPLICATE },
          ACTOR_ID,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses an issue that is a duplicate of itself', async () => {
      issuesService.findOne.mockResolvedValue(issueAt(IssueStatus.OPEN));

      await expect(
        service.changeStatus(
          ISSUE_ID,
          {
            status: IssueStatus.DUPLICATE,
            duplicateOf: ISSUE_ID,
          },
          ACTOR_ID,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('propagates the 404 when duplicateOf names an unknown issue', async () => {
      issuesService.findOne
        .mockResolvedValueOnce(issueAt(IssueStatus.OPEN))
        .mockRejectedValueOnce(new Error('Issue with id not found'));

      await expect(
        service.changeStatus(
          ISSUE_ID,
          {
            status: IssueStatus.DUPLICATE,
            duplicateOf: OTHER_ID,
          },
          ACTOR_ID,
        ),
      ).rejects.toThrow();
    });
  });
  describe('claim', () => {
    const REPORTER = '507f1f77bcf86cd799439011';
    const VOLUNTEER = '507f1f77bcf86cd799439044';

    const openIssue = (overrides: Record<string, unknown> = {}) => ({
      status: IssueStatus.OPEN,
      reportedBy: new Types.ObjectId(REPORTER),
      hazard: HazardLevel.UNRESTRICTED,
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

    describe('the hazard gate', () => {
      // The gate runs before everything else, so a restricted issue never
      // answers "already claimed" and send someone to look at it.
      it.each([
        [HazardLevel.UNCLASSIFIED, 'has not been classified'],
        [HazardLevel.NEEDS_REVIEW, 'waiting for an agency'],
        [HazardLevel.RESTRICTED, 'specialist handling'],
      ])('refuses a claim when hazard is %s', async (hazard, fragment) => {
        issuesService.findOne.mockResolvedValue(
          openIssue({ status: IssueStatus.OPEN, hazard }),
        );

        await expect(service.claim(ISSUE_ID, VOLUNTEER)).rejects.toThrow(
          fragment,
        );
      });

      it('allows a claim on an unrestricted issue', async () => {
        const issue = openIssue({
          status: IssueStatus.OPEN,
          hazard: HazardLevel.UNRESTRICTED,
        });
        issuesService.findOne.mockResolvedValue(issue);

        const result = await service.claim(ISSUE_ID, VOLUNTEER);

        expect(result.status).toBe(IssueStatus.CLAIMED);
      });
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
  describe('resolve', () => {
    const VOLUNTEER = '507f1f77bcf86cd799439044';

    const inProgress = () => ({
      status: IssueStatus.IN_PROGRESS,
      reportedBy: new Types.ObjectId('507f1f77bcf86cd799439011'),
      volunteerId: new Types.ObjectId(VOLUNTEER),
      save: vi.fn().mockImplementation(function (this: unknown) {
        return Promise.resolve(this);
      }),
    });

    it('records the note and moves to RESOLVED', async () => {
      issuesService.findOne.mockResolvedValue(inProgress());

      const result = await service.resolve(
        ISSUE_ID,
        VOLUNTEER,
        { note: 'Cleared the silt and reset the grate.' },
        [Role.CITIZEN],
      );

      expect(result.status).toBe(IssueStatus.RESOLVED);
      expect(result.resolutionNote).toContain('silt');
      expect(result.resolvedAt).toBeInstanceOf(Date);
    });

    it('refuses without a proof photo from this volunteer', async () => {
      issuesService.findOne.mockResolvedValue(inProgress());
      mediaService.countProofBy.mockResolvedValue(0);

      await expect(
        service.resolve(ISSUE_ID, VOLUNTEER, { note: 'Done' }, [Role.CITIZEN]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('counts proof by the current holder, not by anyone', async () => {
      issuesService.findOne.mockResolvedValue(inProgress());

      await service.resolve(ISSUE_ID, VOLUNTEER, { note: 'Done' }, [
        Role.CITIZEN,
      ]);

      expect(mediaService.countProofBy).toHaveBeenCalledWith(
        ISSUE_ID,
        VOLUNTEER,
      );
    });

    it('refuses anyone but the holder', async () => {
      issuesService.findOne.mockResolvedValue(inProgress());

      await expect(
        service.resolve(ISSUE_ID, '507f1f77bcf86cd799439055', { note: 'x' }, [
          Role.CITIZEN,
        ]),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('an agency resolving a restricted issue', () => {
    const AGENCY_USER = '507f1f77bcf86cd799439066';
    const OTHER_AGENCY = '507f1f77bcf86cd799439077';
    const VOLUNTEER = '507f1f77bcf86cd799439044';

    const issueDoc = (overrides: Record<string, unknown> = {}) => ({
      _id: new Types.ObjectId(ISSUE_ID),
      reportedBy: new Types.ObjectId('507f1f77bcf86cd799439011'),
      save: vi.fn().mockImplementation(function (this: unknown) {
        return Promise.resolve(this);
      }),
      ...overrides,
    });

    it('records the agency as the resolver, not as a volunteer', async () => {
      const issue = issueDoc({
        status: IssueStatus.OPEN,
        hazard: HazardLevel.RESTRICTED,
      });
      issuesService.findOne.mockResolvedValue(issue);
      mediaService.countProofBy.mockResolvedValue(1);

      const result = await service.resolve(
        ISSUE_ID,
        AGENCY_USER,
        { note: 'Crew attended' },
        [Role.AGENCY],
      );

      expect(result.status).toBe(IssueStatus.RESOLVED);
      expect(result.agencyResolverId?.toString()).toBe(AGENCY_USER);
      expect(result.volunteerId).toBeUndefined();
    });

    it('still demands evidence', async () => {
      issuesService.findOne.mockResolvedValue(
        issueDoc({ status: IssueStatus.OPEN, hazard: HazardLevel.RESTRICTED }),
      );
      mediaService.countProofBy.mockResolvedValue(0);

      await expect(
        service.resolve(ISSUE_ID, AGENCY_USER, { note: 'Done' }, [Role.AGENCY]),
      ).rejects.toThrow('proof of work');
    });

    it('refuses a citizen on the same route', async () => {
      issuesService.findOne.mockResolvedValue(
        issueDoc({ status: IssueStatus.OPEN, hazard: HazardLevel.RESTRICTED }),
      );

      await expect(
        service.resolve(ISSUE_ID, VOLUNTEER, { note: 'Done' }, [Role.CITIZEN]),
      ).rejects.toThrow(ForbiddenException);
    });

    it('pays nobody when there is no volunteer', async () => {
      const issue = issueDoc({
        status: IssueStatus.RESOLVED,
        hazard: HazardLevel.RESTRICTED,
        agencyResolverId: new Types.ObjectId(AGENCY_USER),
        volunteerId: undefined,
      });
      issuesService.findOne.mockResolvedValue(issue);

      await service.changeStatus(
        ISSUE_ID,
        { status: IssueStatus.VERIFIED },
        OTHER_AGENCY,
      );

      expect(pointsService.awardForVerification).not.toHaveBeenCalled();
    });

    // A CLAIMED/IN_PROGRESS issue reclassified RESTRICTED keeps its stale
    // volunteerId when the agency resolves it — the agency branch never
    // clears it. The volunteerId guard alone would pay that volunteer for
    // work they did not do and evidence that was never counted.
    it('pays nobody when a stale volunteerId survives an agency resolution', async () => {
      const issue = issueDoc({
        status: IssueStatus.RESOLVED,
        hazard: HazardLevel.RESTRICTED,
        agencyResolverId: new Types.ObjectId(AGENCY_USER),
        volunteerId: new Types.ObjectId(VOLUNTEER),
      });
      issuesService.findOne.mockResolvedValue(issue);

      await service.changeStatus(
        ISSUE_ID,
        { status: IssueStatus.VERIFIED },
        OTHER_AGENCY,
      );

      expect(pointsService.awardForVerification).not.toHaveBeenCalled();
    });

    it('reverses nothing for that same shape', async () => {
      const issue = issueDoc({
        status: IssueStatus.VERIFIED,
        hazard: HazardLevel.RESTRICTED,
        agencyResolverId: new Types.ObjectId(AGENCY_USER),
        volunteerId: new Types.ObjectId(VOLUNTEER),
        verifiedAt: new Date(),
      });
      issuesService.findOne.mockResolvedValue(issue);

      await service.changeStatus(
        ISSUE_ID,
        { status: IssueStatus.IN_PROGRESS, reason: 'wrong' },
        OTHER_AGENCY,
      );

      expect(pointsService.reverseForVerification).not.toHaveBeenCalled();
    });

    // The same rule volunteers live under: you do not sign off your own work.
    it('refuses the resolving agency user confirming their own fix', async () => {
      issuesService.findOne.mockResolvedValue(
        issueDoc({
          status: IssueStatus.RESOLVED,
          hazard: HazardLevel.RESTRICTED,
          agencyResolverId: new Types.ObjectId(AGENCY_USER),
        }),
      );

      await expect(
        service.changeStatus(
          ISSUE_ID,
          { status: IssueStatus.VERIFIED },
          AGENCY_USER,
        ),
      ).rejects.toThrow('work you did yourself');
    });

    // agencyResolverId is assigned in resolve() and, before this fix, was
    // never cleared anywhere — not even by returnToOpen, which already
    // clears volunteerId, claimedAt, resolvedAt and resolutionNote for
    // exactly this reason. A stale id would silently block payment for a
    // genuine volunteer who does the work after the issue is reopened and
    // reclassified.
    it('pays a volunteer who resolves the issue after it is reopened from a prior agency resolution', async () => {
      const issue = issueDoc({
        status: IssueStatus.RESOLVED,
        hazard: HazardLevel.RESTRICTED,
        agencyResolverId: new Types.ObjectId(AGENCY_USER),
      });
      // The same mutable document is returned on every findOne call, so
      // mutations from one step in the pipeline are visible to the next —
      // exactly as the real repository behaves across a sequence of calls.
      issuesService.findOne.mockResolvedValue(issue);

      // The agency sends it back for more work, then force-releases it.
      await service.changeStatus(
        ISSUE_ID,
        { status: IssueStatus.IN_PROGRESS, reason: 'needs more work' },
        OTHER_AGENCY,
      );
      await service.changeStatus(
        ISSUE_ID,
        { status: IssueStatus.OPEN, reason: 'reassigning' },
        OTHER_AGENCY,
      );

      expect(issue.agencyResolverId).toBeUndefined();

      // Reclassified UNRESTRICTED by the hazard service, out of scope here.
      issue.hazard = HazardLevel.UNRESTRICTED;

      // A genuine volunteer claims it and does the work.
      await service.claim(ISSUE_ID, VOLUNTEER);
      await service.resolve(ISSUE_ID, VOLUNTEER, { note: 'Fixed it' }, [
        Role.CITIZEN,
      ]);
      await service.changeStatus(
        ISSUE_ID,
        { status: IssueStatus.VERIFIED },
        OTHER_AGENCY,
      );

      expect(pointsService.awardForVerification).toHaveBeenCalled();
    });
  });

  describe('the agency verdict', () => {
    const VOLUNTEER = '507f1f77bcf86cd799439044';

    const resolved = () => ({
      status: IssueStatus.RESOLVED,
      reportedBy: new Types.ObjectId('507f1f77bcf86cd799439011'),
      volunteerId: new Types.ObjectId(VOLUNTEER),
      resolvedAt: new Date(),
      resolutionNote: 'Done',
      save: vi.fn().mockImplementation(function (this: unknown) {
        return Promise.resolve(this);
      }),
    });

    it('verifies a resolved issue', async () => {
      issuesService.findOne.mockResolvedValue(resolved());

      const result = await service.changeStatus(
        ISSUE_ID,
        {
          status: IssueStatus.VERIFIED,
        },
        ACTOR_ID,
      );

      expect(result.status).toBe(IssueStatus.VERIFIED);
      expect(result.verifiedAt).toBeInstanceOf(Date);
      // The holder is kept: slice C awards points to this person.
      expect(result.volunteerId?.toString()).toBe(VOLUNTEER);
    });

    it('sends work back to IN_PROGRESS with a reason, keeping the holder', async () => {
      issuesService.findOne.mockResolvedValue(resolved());

      const result = await service.changeStatus(
        ISSUE_ID,
        {
          status: IssueStatus.IN_PROGRESS,
          reason: 'The grate is still blocked',
        },
        ACTOR_ID,
      );

      expect(result.status).toBe(IssueStatus.IN_PROGRESS);
      expect(result.volunteerId?.toString()).toBe(VOLUNTEER);
      expect(result.resolvedAt).toBeUndefined();
    });

    it('refuses a send-back with no reason', async () => {
      issuesService.findOne.mockResolvedValue(resolved());

      await expect(
        service.changeStatus(
          ISSUE_ID,
          { status: IssueStatus.IN_PROGRESS },
          ACTOR_ID,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('force-releases a claimed issue, clearing the holder', async () => {
      issuesService.findOne.mockResolvedValue({
        ...resolved(),
        status: IssueStatus.CLAIMED,
      });

      const result = await service.changeStatus(
        ISSUE_ID,
        {
          status: IssueStatus.OPEN,
          reason: 'No progress for a fortnight',
        },
        ACTOR_ID,
      );

      expect(result.status).toBe(IssueStatus.OPEN);
      expect(result.volunteerId).toBeUndefined();
    });

    it('refuses a force-release with no reason', async () => {
      issuesService.findOne.mockResolvedValue({
        ...resolved(),
        status: IssueStatus.CLAIMED,
      });

      await expect(
        service.changeStatus(ISSUE_ID, { status: IssueStatus.OPEN }, ACTOR_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    // An agency must not be able to skip the evidence requirement by setting
    // RESOLVED directly, nor hand the issue to someone by setting CLAIMED.
    it.each([IssueStatus.RESOLVED, IssueStatus.CLAIMED])(
      'refuses %s through the agency path',
      async (target) => {
        issuesService.findOne.mockResolvedValue({
          ...resolved(),
          status: IssueStatus.IN_PROGRESS,
        });

        await expect(
          service.changeStatus(ISSUE_ID, { status: target }, ACTOR_ID),
        ).rejects.toBeInstanceOf(ForbiddenException);
      },
    );

    it('confirms an AI approval without needing a reason', async () => {
      issuesService.findOne.mockResolvedValue({
        ...resolved(),
        status: IssueStatus.AI_APPROVED,
      });

      const result = await service.changeStatus(
        ISSUE_ID,
        {
          status: IssueStatus.VERIFIED,
        },
        ACTOR_ID,
      );

      expect(result.status).toBe(IssueStatus.VERIFIED);
      expect(result.verifiedAt).toBeInstanceOf(Date);
    });

    it('rejects an AI approval back to IN_PROGRESS, with a reason', async () => {
      issuesService.findOne.mockResolvedValue({
        ...resolved(),
        status: IssueStatus.AI_APPROVED,
      });

      const result = await service.changeStatus(
        ISSUE_ID,
        {
          status: IssueStatus.IN_PROGRESS,
          reason: 'The model was fooled; the grate is still blocked',
        },
        ACTOR_ID,
      );

      expect(result.status).toBe(IssueStatus.IN_PROGRESS);
    });

    it('refuses an agency setting AI_APPROVED by hand', async () => {
      issuesService.findOne.mockResolvedValue(resolved());

      // Claiming the model said something it did not.
      await expect(
        service.changeStatus(
          ISSUE_ID,
          { status: IssueStatus.AI_APPROVED },
          ACTOR_ID,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // No one may verify their own work, even a volunteer who also holds the
  // AGENCY role — the controller passes the caller's id regardless of role.
  describe('anti-self-verification', () => {
    const VOLUNTEER = '507f1f77bcf86cd799439044';

    const resolvedAt = (status: IssueStatus) => ({
      status,
      reportedBy: new Types.ObjectId('507f1f77bcf86cd799439011'),
      volunteerId: new Types.ObjectId(VOLUNTEER),
      resolvedAt: new Date(),
      resolutionNote: 'Done',
      save: vi.fn().mockImplementation(function (this: unknown) {
        return Promise.resolve(this);
      }),
    });

    it.each([IssueStatus.RESOLVED, IssueStatus.AI_APPROVED])(
      'refuses a volunteer verifying their own %s issue, saving and awarding nothing',
      async (status) => {
        const issue = resolvedAt(status);
        issuesService.findOne.mockResolvedValue(issue);

        await expect(
          service.changeStatus(
            ISSUE_ID,
            { status: IssueStatus.VERIFIED },
            VOLUNTEER,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(issue.save).not.toHaveBeenCalled();
        expect(pointsService.awardForVerification).not.toHaveBeenCalled();
      },
    );

    it('still lets a different actor verify, and awards', async () => {
      issuesService.findOne.mockResolvedValue(resolvedAt(IssueStatus.RESOLVED));

      const result = await service.changeStatus(
        ISSUE_ID,
        { status: IssueStatus.VERIFIED },
        ACTOR_ID,
      );

      expect(result.status).toBe(IssueStatus.VERIFIED);
      expect(pointsService.awardForVerification).toHaveBeenCalled();
    });
  });

  describe('auto-approval', () => {
    const VOLUNTEER = '507f1f77bcf86cd799439044';

    const inProgress = () => ({
      status: IssueStatus.IN_PROGRESS,
      reportedBy: new Types.ObjectId('507f1f77bcf86cd799439011'),
      volunteerId: new Types.ObjectId(VOLUNTEER),
      save: vi.fn().mockImplementation(function (this: unknown) {
        return Promise.resolve(this);
      }),
    });

    it('stops at RESOLVED when the feature is off', async () => {
      issuesService.findOne.mockResolvedValue(inProgress());

      const result = await service.resolve(ISSUE_ID, VOLUNTEER, { note: 'x' }, [
        Role.CITIZEN,
      ]);

      expect(result.status).toBe(IssueStatus.RESOLVED);
      expect(result.aiAssessment).toBeUndefined();
    });

    it('parks an AI approval in AI_APPROVED rather than verifying it', async () => {
      issuesService.findOne.mockResolvedValue(inProgress());
      verificationService.assess.mockResolvedValue({
        outcome: AiOutcome.APPROVED,
        confidence: 0.9,
        assessedAt: new Date(),
      });

      const result = await service.resolve(ISSUE_ID, VOLUNTEER, { note: 'x' }, [
        Role.CITIZEN,
      ]);

      // The model may recommend. It may not pay.
      expect(result.status).toBe(IssueStatus.AI_APPROVED);
      expect(result.verifiedAt).toBeUndefined();
    });

    it.each([
      AiOutcome.BELOW_THRESHOLD,
      AiOutcome.SKIPPED_NO_BEFORE,
      AiOutcome.FAILED,
    ])(
      'stays RESOLVED on %s, with the assessment attached',
      async (outcome) => {
        issuesService.findOne.mockResolvedValue(inProgress());
        verificationService.assess.mockResolvedValue({
          outcome,
          assessedAt: new Date(),
        });

        const result = await service.resolve(
          ISSUE_ID,
          VOLUNTEER,
          { note: 'x' },
          [Role.CITIZEN],
        );

        expect(result.status).toBe(IssueStatus.RESOLVED);
        expect(result.aiAssessment?.outcome).toBe(outcome);
      },
    );
  });

  describe('reversal', () => {
    const VOLUNTEER = '507f1f77bcf86cd799439044';

    const verified = () => ({
      status: IssueStatus.VERIFIED,
      reportedBy: new Types.ObjectId('507f1f77bcf86cd799439011'),
      volunteerId: new Types.ObjectId(VOLUNTEER),
      verifiedAt: new Date(),
      aiAssessment: { outcome: AiOutcome.APPROVED, assessedAt: new Date() },
      save: vi.fn().mockImplementation(function (this: unknown) {
        return Promise.resolve(this);
      }),
    });

    it('lets an agency undo an approval, with a reason', async () => {
      issuesService.findOne.mockResolvedValue(verified());

      const result = await service.changeStatus(
        ISSUE_ID,
        {
          status: IssueStatus.IN_PROGRESS,
          reason: 'The culvert is still blocked',
        },
        ACTOR_ID,
      );

      expect(result.status).toBe(IssueStatus.IN_PROGRESS);
      expect(result.verifiedAt).toBeUndefined();
      expect(result.volunteerId?.toString()).toBe(VOLUNTEER);
      // What the model said, and got wrong, is worth keeping.
      expect(result.aiAssessment).toBeDefined();
    });

    it('refuses a reversal with no reason', async () => {
      issuesService.findOne.mockResolvedValue(verified());

      await expect(
        service.changeStatus(
          ISSUE_ID,
          { status: IssueStatus.IN_PROGRESS },
          ACTOR_ID,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('points', () => {
    const VOLUNTEER = '507f1f77bcf86cd799439044';

    const at = (status: IssueStatus) => ({
      _id: new Types.ObjectId(ISSUE_ID),
      status,
      reportedBy: new Types.ObjectId('507f1f77bcf86cd799439011'),
      volunteerId: new Types.ObjectId(VOLUNTEER),
      save: vi.fn().mockImplementation(function (this: unknown) {
        return Promise.resolve(this);
      }),
    });

    it('awards when an agency verifies a resolved issue', async () => {
      issuesService.findOne.mockResolvedValue(at(IssueStatus.RESOLVED));

      await service.changeStatus(
        ISSUE_ID,
        { status: IssueStatus.VERIFIED },
        ACTOR_ID,
      );

      expect(pointsService.awardForVerification).toHaveBeenCalled();
    });

    it('awards when an agency confirms an AI approval', async () => {
      issuesService.findOne.mockResolvedValue(at(IssueStatus.AI_APPROVED));

      await service.changeStatus(
        ISSUE_ID,
        { status: IssueStatus.VERIFIED },
        ACTOR_ID,
      );

      expect(pointsService.awardForVerification).toHaveBeenCalled();
    });

    it('awards nothing when the AI parks an issue in AI_APPROVED', async () => {
      issuesService.findOne.mockResolvedValue(at(IssueStatus.IN_PROGRESS));
      verificationService.assess.mockResolvedValue({
        outcome: AiOutcome.APPROVED,
        confidence: 0.9,
        assessedAt: new Date(),
      });

      await service.resolve(ISSUE_ID, VOLUNTEER, { note: 'x' }, [Role.CITIZEN]);

      expect(pointsService.awardForVerification).not.toHaveBeenCalled();
    });

    it('reverses when a verification is undone', async () => {
      issuesService.findOne.mockResolvedValue(at(IssueStatus.VERIFIED));

      await service.changeStatus(
        ISSUE_ID,
        {
          status: IssueStatus.IN_PROGRESS,
          reason: 'wrong',
        },
        ACTOR_ID,
      );

      expect(pointsService.reverseForVerification).toHaveBeenCalled();
    });

    it('does not reverse when sending back work that was never verified', async () => {
      issuesService.findOne.mockResolvedValue(at(IssueStatus.RESOLVED));

      await service.changeStatus(
        ISSUE_ID,
        {
          status: IssueStatus.IN_PROGRESS,
          reason: 'more work needed',
        },
        ACTOR_ID,
      );

      expect(pointsService.reverseForVerification).not.toHaveBeenCalled();
    });

    it('still changes the status when the points service throws, logging the issue for manual repair', async () => {
      const issue = at(IssueStatus.RESOLVED);
      issuesService.findOne.mockResolvedValue(issue);
      pointsService.awardForVerification.mockRejectedValue(new Error('down'));
      const errorSpy = vi.spyOn(
        (service as unknown as { logger: { error: typeof vi.fn } }).logger,
        'error',
      );

      const result = await service.changeStatus(
        ISSUE_ID,
        { status: IssueStatus.VERIFIED },
        ACTOR_ID,
      );

      // The status change is the decision; the ledger catches up.
      expect(result.status).toBe(IssueStatus.VERIFIED);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `Points award failed for issue ${issue._id} (volunteer ${issue.volunteerId})`,
        ),
        expect.stringContaining('Error: down'),
      );
    });
  });
});
