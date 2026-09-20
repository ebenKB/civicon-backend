import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import {
  AiOutcome,
  HazardLevel,
  HazardSource,
  IssueCategory,
  IssueStatus,
} from '../contracts/index.js';
import { IssuesService } from './issues.service.js';
import { Issue } from './schemas/issue.schema.js';

const execOf = <T>(value: T) => ({ exec: () => Promise.resolve(value) });

/** Mongoose query builders are chainable, so the list mock returns itself. */
const chainOf = <T>(value: T) => {
  const chain = {
    sort: vi.fn(() => chain),
    skip: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    exec: () => Promise.resolve(value),
  };
  return chain;
};

const REPORTER = '507f1f77bcf86cd799439011';

describe('IssuesService', () => {
  let service: IssuesService;
  let model: {
    create: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findOneAndUpdate: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    model = {
      create: vi.fn(),
      find: vi.fn(),
      findById: vi.fn(),
      findOneAndUpdate: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IssuesService,
        { provide: getModelToken(Issue.name), useValue: model },
      ],
    }).compile();

    service = module.get<IssuesService>(IssuesService);
  });

  describe('create', () => {
    const dto = {
      title: 'Blocked drain',
      description: 'Water standing after rain.',
      category: IssueCategory.DRAINAGE,
      location: 'Market Street',
    };

    it('attributes the issue to the caller, not to anything in the body', async () => {
      model.create.mockResolvedValue({});

      await service.create(REPORTER, dto);

      const [input] = model.create.mock.calls[0];
      expect(input.reportedBy.toString()).toBe(REPORTER);
    });

    it('passes no status, leaving the schema default to supply OPEN', async () => {
      model.create.mockResolvedValue({});

      await service.create(REPORTER, dto);

      const [input] = model.create.mock.calls[0];
      expect(input).not.toHaveProperty('status');
    });

    it('stores the reporter observations', async () => {
      model.create.mockResolvedValue({});

      await service.create(REPORTER, {
        title: 'Blocked drain',
        description: 'Standing water.',
        category: IssueCategory.DRAINAGE,
        location: 'Market Street',
        observations: ['obs-wires'],
      });

      const [document] = model.create.mock.calls[0];
      expect(document.observations).toEqual(['obs-wires']);
    });
  });

  describe('findAll', () => {
    it('applies no filter when the query is empty', async () => {
      model.find.mockReturnValue(chainOf([]));

      await service.findAll({});

      expect(model.find).toHaveBeenCalledWith({});
    });

    it('filters by status and category', async () => {
      model.find.mockReturnValue(chainOf([]));

      await service.findAll({
        status: IssueStatus.OPEN,
        category: IssueCategory.ROADS,
      });

      expect(model.find).toHaveBeenCalledWith({
        status: IssueStatus.OPEN,
        category: IssueCategory.ROADS,
      });
    });

    it('filters by reporter as an ObjectId, not a string', async () => {
      model.find.mockReturnValue(chainOf([]));

      await service.findAll({ reportedBy: REPORTER });

      const [filter] = model.find.mock.calls[0];
      expect(filter.reportedBy).toBeInstanceOf(Types.ObjectId);
      expect(filter.reportedBy.toString()).toBe(REPORTER);
    });

    it('filters by volunteer as an ObjectId', async () => {
      model.find.mockReturnValue(chainOf([]));

      await service.findAll({ volunteerId: REPORTER });

      const [filter] = model.find.mock.calls[0];
      expect(filter.volunteerId).toBeInstanceOf(Types.ObjectId);
    });

    it('filters by assessment outcome for the agency queue', async () => {
      model.find.mockReturnValue(chainOf([]));

      await service.findAll({ aiOutcome: AiOutcome.BELOW_THRESHOLD });

      const [filter] = model.find.mock.calls[0];
      expect(filter['aiAssessment.outcome']).toBe(AiOutcome.BELOW_THRESHOLD);
    });

    it('sorts newest first and applies the default paging window', async () => {
      const chain = chainOf([]);
      model.find.mockReturnValue(chain);

      await service.findAll({});

      expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1 });
      expect(chain.skip).toHaveBeenCalledWith(0);
      expect(chain.limit).toHaveBeenCalledWith(20);
    });

    it('honours an explicit limit and offset', async () => {
      const chain = chainOf([]);
      model.find.mockReturnValue(chain);

      await service.findAll({ limit: 5, offset: 10 });

      expect(chain.skip).toHaveBeenCalledWith(10);
      expect(chain.limit).toHaveBeenCalledWith(5);
    });
  });

  describe('findOne', () => {
    it('returns the issue when it exists', async () => {
      model.findById.mockReturnValue(execOf({ title: 'Blocked drain' }));

      await expect(service.findOne('anything')).resolves.toMatchObject({
        title: 'Blocked drain',
      });
    });

    it('throws NotFoundException when it does not', async () => {
      model.findById.mockReturnValue(execOf(null));

      await expect(service.findOne('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
  describe('updateOwn', () => {
    const ownedIssue = () => ({
      reportedBy: new Types.ObjectId(REPORTER),
      status: IssueStatus.OPEN,
      title: 'Blocked drain',
      // The schema defaults this, so a real document always carries it. The
      // fixture used to omit it, which let "does nothing extra" pass while
      // the code was in fact writing the field.
      hazard: HazardLevel.UNCLASSIFIED,
      save: vi.fn().mockImplementation(function (this: unknown) {
        return Promise.resolve(this);
      }),
    });

    it('applies the changes when the caller is the reporter', async () => {
      const issue = ownedIssue();
      model.findById.mockReturnValue(execOf(issue));

      const result = await service.updateOwn(REPORTER, REPORTER, {
        title: 'Blocked drain on Market Street',
      });

      expect(result.title).toBe('Blocked drain on Market Street');
      expect(issue.save).toHaveBeenCalled();
    });

    it('refuses a caller who is not the reporter', async () => {
      model.findById.mockReturnValue(execOf(ownedIssue()));

      await expect(
        service.updateOwn(REPORTER, '507f1f77bcf86cd799439099', {
          title: 'Hijacked',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses once the issue has left OPEN', async () => {
      const issue = ownedIssue();
      issue.status = IssueStatus.REJECTED;
      model.findById.mockReturnValue(execOf(issue));

      await expect(
        service.updateOwn(REPORTER, REPORTER, { title: 'Too late' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('never lets an update change the status', async () => {
      const issue = ownedIssue();
      model.findById.mockReturnValue(execOf(issue));

      await service.updateOwn(REPORTER, REPORTER, {
        title: 'Still open',
      } as never);

      expect(issue.status).toBe(IssueStatus.OPEN);
    });

    // A classified issue's verdict describes the text and photos the
    // classifier actually saw. Editing any of the classifier's inputs makes
    // that verdict stale, so the issue goes back to UNCLASSIFIED and must be
    // classified again — otherwise "the live cable is down and sparking"
    // could be typed in after a confident UNRESTRICTED clearance and the
    // issue would stay claimable.
    describe('when the classifier inputs change', () => {
      const classifiedIssue = () => ({
        ...ownedIssue(),
        hazard: HazardLevel.UNRESTRICTED,
        hazardAssessment: {
          level: HazardLevel.UNRESTRICTED,
          source: HazardSource.AI,
          confidence: 0.92,
          reasoning: 'Routine streetlight repair.',
          assessedAt: new Date(),
        },
        pendingQuestions: ['elec-1'],
        answers: [{ questionId: 'elec-1', answer: 'NO' }],
      });

      it.each([
        ['title', { title: 'A different title entirely' }],
        ['description', { description: 'A live cable is down and sparking.' }],
        ['category', { category: IssueCategory.ELECTRICITY }],
        ['location', { location: 'A different corner' }],
      ])(
        'resets hazard to UNCLASSIFIED when %s changes',
        async (_field, patch) => {
          const issue = classifiedIssue();
          issue.category = IssueCategory.DRAINAGE;
          model.findById.mockReturnValue(execOf(issue));

          const result = await service.updateOwn(REPORTER, REPORTER, patch);

          expect(result.hazard).toBe(HazardLevel.UNCLASSIFIED);
          expect(result.hazardAssessment).toBeUndefined();
          expect(result.pendingQuestions).toBeUndefined();
          expect(result.answers).toBeUndefined();
        },
      );

      it('does not reset when the edit changes nothing', async () => {
        const issue = classifiedIssue();
        issue.category = IssueCategory.DRAINAGE;
        model.findById.mockReturnValue(execOf(issue));

        const result = await service.updateOwn(REPORTER, REPORTER, {
          title: issue.title,
          category: IssueCategory.DRAINAGE,
        });

        expect(result.hazard).toBe(HazardLevel.UNRESTRICTED);
        expect(result.hazardAssessment).toBeDefined();
        expect(result.pendingQuestions).toEqual(['elec-1']);
      });

      it('does nothing extra when the issue was never classified', async () => {
        const issue = ownedIssue();
        model.findById.mockReturnValue(execOf(issue));

        const result = await service.updateOwn(REPORTER, REPORTER, {
          title: 'Blocked drain, worse now',
        });

        expect(result.hazard).toBe(HazardLevel.UNCLASSIFIED);
      });
    });
  });

  describe('updateIfMatches', () => {
    const ISSUE_ID = '507f1f77bcf86cd799439033';

    // A guarded write for callers spanning an async gap (an AI call that can
    // take up to a minute) where a human decision might land first: the
    // filter re-asserts the exact state the caller started from, atomically,
    // so a write that lost the race touches nothing.
    it('merges the expected state into the id filter and returns the updated document', async () => {
      const updated = { hazard: HazardLevel.UNRESTRICTED };
      model.findOneAndUpdate.mockReturnValue(execOf(updated));

      const result = await service.updateIfMatches(
        ISSUE_ID,
        { hazard: HazardLevel.UNCLASSIFIED },
        { hazard: HazardLevel.UNRESTRICTED },
      );

      const [filter, update, options] = model.findOneAndUpdate.mock.calls[0];
      expect(filter._id.toString()).toBe(ISSUE_ID);
      expect(filter.hazard).toBe(HazardLevel.UNCLASSIFIED);
      expect(update).toEqual({ hazard: HazardLevel.UNRESTRICTED });
      expect(options).toMatchObject({ returnDocument: 'after' });
      expect(result).toBe(updated);
    });

    it('returns null when the expected state no longer matches', async () => {
      model.findOneAndUpdate.mockReturnValue(execOf(null));

      const result = await service.updateIfMatches(
        ISSUE_ID,
        { hazard: HazardLevel.UNCLASSIFIED },
        { hazard: HazardLevel.RESTRICTED },
      );

      expect(result).toBeNull();
    });
  });
});

describe('IssuesService editing a classified issue', () => {
  let service: IssuesService;
  let model: { findById: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    model = { findById: vi.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IssuesService,
        { provide: getModelToken(Issue.name), useValue: model },
      ],
    }).compile();
    service = module.get<IssuesService>(IssuesService);
  });

  // Fixtures build a document whose save() returns itself, matching the
  // other editing tests in this file.
  const classified = (hazard, source) =>
    ({
      _id: new Types.ObjectId(),
      title: 'Streetlight cover hanging loose',
      description: 'The cover swings in the wind.',
      category: IssueCategory.ELECTRICITY,
      location: 'Ring Road East',
      status: IssueStatus.OPEN,
      reportedBy: new Types.ObjectId(REPORTER),
      hazard,
      hazardAssessment: {
        level: hazard,
        source,
        reasoning: 'Utility crew only',
        decidedBy: source === HazardSource.AGENCY ? 'agency-id' : undefined,
        assessedAt: new Date(),
      },
      save: vi.fn().mockImplementation(function (this: unknown) {
        return this;
      }),
    }) as never;

  // An edit may take an issue OUT of the claimable state. It must never take
  // one out of a restriction: a reporter who could wipe an agency's
  // RESTRICTED ruling by changing one word could then resubmit and be cleared.
  it('never clears a RESTRICTED ruling made by an agency', async () => {
    const issue = classified(HazardLevel.RESTRICTED, HazardSource.AGENCY);
    model.findById.mockReturnValue(execOf(issue));

    const result = await service.updateOwn(issue._id.toString(), REPORTER, {
      description: 'Actually the live cable is down and sparking.',
    });

    expect(result.hazard).toBe(HazardLevel.RESTRICTED);
    expect(result.hazardAssessment?.source).toBe(HazardSource.AGENCY);
  });

  it('never clears a RESTRICTED verdict the model reached either', async () => {
    const issue = classified(HazardLevel.RESTRICTED, HazardSource.AI);
    model.findById.mockReturnValue(execOf(issue));

    const result = await service.updateOwn(issue._id.toString(), REPORTER, {
      description: 'Rewritten.',
    });

    expect(result.hazard).toBe(HazardLevel.RESTRICTED);
  });

  // NEEDS_REVIEW sits in an agency queue. Resetting it would silently drop it
  // out of that queue; the agency reads the current text when it gets there.
  it('leaves an issue waiting on an agency in that queue', async () => {
    const issue = classified(HazardLevel.NEEDS_REVIEW, HazardSource.AI);
    model.findById.mockReturnValue(execOf(issue));

    const result = await service.updateOwn(issue._id.toString(), REPORTER, {
      description: 'Rewritten.',
    });

    expect(result.hazard).toBe(HazardLevel.NEEDS_REVIEW);
  });

  it('still clears a clearance, which is the only claimable state', async () => {
    const issue = classified(HazardLevel.UNRESTRICTED, HazardSource.AI);
    model.findById.mockReturnValue(execOf(issue));

    const result = await service.updateOwn(issue._id.toString(), REPORTER, {
      description: 'Actually the live cable is down and sparking.',
    });

    expect(result.hazard).toBe(HazardLevel.UNCLASSIFIED);
    expect(result.hazardAssessment).toBeUndefined();
  });
});

describe('IssuesService.registerNewReportEvidence', () => {
  let service: IssuesService;
  let model: { updateOne: ReturnType<typeof vi.fn> };
  const ISSUE_ID = '507f1f77bcf86cd799439022';

  beforeEach(async () => {
    model = {
      updateOne: vi.fn().mockReturnValue(execOf({ modifiedCount: 1 })),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IssuesService,
        { provide: getModelToken(Issue.name), useValue: model },
      ],
    }).compile();
    service = module.get<IssuesService>(IssuesService);
  });

  // Filtered on UNRESTRICTED so the write can only ever remove a clearance.
  // A human RESTRICTED landing during the upload simply stands.
  it('clears a clearance and everything that justified it', async () => {
    await service.registerNewReportEvidence(ISSUE_ID);

    const [filter, update] = model.updateOne.mock.calls[0];
    expect(filter.hazard).toBe(HazardLevel.UNRESTRICTED);
    expect(update.$set.hazard).toBe(HazardLevel.UNCLASSIFIED);
    expect(Object.keys(update.$unset)).toEqual([
      'hazardAssessment',
      'pendingQuestions',
      'answers',
    ]);
    expect(update.$set.updatedAt).toBeInstanceOf(Date);
  });

  it('is one conditional write, not a read then a write', async () => {
    await service.registerNewReportEvidence(ISSUE_ID);

    expect(model.updateOne).toHaveBeenCalledTimes(1);
  });

  // Nothing to clear still has to move updatedAt: an issue mid-classification
  // is UNCLASSIFIED throughout, and submit()'s guard watches that field to
  // catch a photo the classifier never saw.
  it('still touches updatedAt when there was no clearance to clear', async () => {
    model.updateOne.mockReturnValue(execOf({ modifiedCount: 0 }));

    await service.registerNewReportEvidence(ISSUE_ID);

    expect(model.updateOne).toHaveBeenCalledTimes(2);
    const [filter, update] = model.updateOne.mock.calls[1];
    expect(filter.hazard).toBeUndefined();
    expect(update.$set.updatedAt).toBeInstanceOf(Date);
  });
});
