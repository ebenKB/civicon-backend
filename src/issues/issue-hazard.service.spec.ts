import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import {
  HAZARD_CONFIDENCE_THRESHOLD,
  HAZARD_MAX_IMAGES,
  HazardAnswer,
  HazardLevel,
  HazardSource,
  IssueCategory,
  Role,
} from '../contracts/index.js';
import { IssueMediaService } from './issue-media.service.js';
import { IssueHazardService } from './issue-hazard.service.js';
import { IssuesService } from './issues.service.js';
import type { IssueDocument } from './schemas/issue.schema.js';

const parse = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { parse };
  },
}));

const enabled = { ANTHROPIC_API_KEY: 'sk-test' };

const anImage = { base64: 'aW1n', contentType: 'image/png' };

const issue = (overrides: Record<string, unknown> = {}) =>
  ({
    _id: new Types.ObjectId(),
    title: 'Streetlight out',
    description: 'Dark since Tuesday.',
    category: IssueCategory.ELECTRICITY,
    location: 'Ring Road East',
    observations: [],
    updatedAt: new Date('2026-09-20T10:00:00Z'),
    ...overrides,
  }) as unknown as IssueDocument;

describe('IssueHazardService', () => {
  let mediaService: { readReportImages: ReturnType<typeof vi.fn> };
  let issuesService: {
    findOne: ReturnType<typeof vi.fn>;
    updateIfMatches: ReturnType<typeof vi.fn>;
  };

  const serviceWith = async (config: Record<string, string>) => {
    mediaService = { readReportImages: vi.fn().mockResolvedValue([]) };
    const module = await Test.createTestingModule({
      providers: [
        IssueHazardService,
        { provide: IssueMediaService, useValue: mediaService },
        { provide: IssuesService, useValue: issuesService },
        { provide: ConfigService, useValue: { get: (k: string) => config[k] } },
      ],
    }).compile();
    return module.get(IssueHazardService);
  };

  // Block body, not `() => parse.mockReset()`: an expression body would
  // implicitly return mockReset()'s own return value (the mock function
  // itself), which Vitest then treats as a post-test cleanup callback and
  // invokes — rejecting, once a test sets mockRejectedValue, and failing the
  // test that already passed.
  beforeEach(() => {
    parse.mockReset();
    issuesService = { findOne: vi.fn(), updateIfMatches: vi.fn() };
  });

  // The reporter saw it in person. A tick is believed without asking a model.
  it('restricts outright when an observation was ticked, with no API call', async () => {
    const service = await serviceWith(enabled);

    const { assessment } = await service.classify(
      issue({ observations: ['obs-wires'] }),
    );

    expect(assessment.level).toBe(HazardLevel.RESTRICTED);
    expect(assessment.source).toBe(HazardSource.REPORTER);
    expect(parse).not.toHaveBeenCalled();
  });

  it('clears an issue the model is confident is ordinary work', async () => {
    parse.mockResolvedValue({
      parsed_output: { dangerous: false, confidence: 0.9, reasoning: 'Routine.', questionIds: [] },
      model: 'claude-opus-5',
    });
    const service = await serviceWith(enabled);

    const { assessment } = await service.classify(issue());

    expect(assessment.level).toBe(HazardLevel.UNRESTRICTED);
    expect(assessment.source).toBe(HazardSource.AI);
    expect(assessment.confidence).toBe(0.9);
  });

  it('restricts an issue the model is confident is dangerous', async () => {
    parse.mockResolvedValue({
      parsed_output: { dangerous: true, confidence: 0.95, reasoning: 'Live cable.', questionIds: [] },
      model: 'claude-opus-5',
    });
    const service = await serviceWith(enabled);

    expect((await service.classify(issue())).assessment.level).toBe(
      HazardLevel.RESTRICTED,
    );
  });

  // Unsure queues it AND asks: the questions are an opportunity, not a gate.
  it('queues for review and returns questions when unsure', async () => {
    parse.mockResolvedValue({
      parsed_output: {
        dangerous: true,
        confidence: 0.4,
        reasoning: 'Cannot tell.',
        questionIds: ['elec-1', 'elec-2', 'water-1'],
      },
      model: 'claude-opus-5',
    });
    const service = await serviceWith(enabled);

    const { assessment, questionIds } = await service.classify(issue());

    expect(assessment.level).toBe(HazardLevel.NEEDS_REVIEW);
    expect(questionIds).toEqual(['elec-1', 'elec-2', 'water-1']);
  });

  it('discards question ids that are not in the bank', async () => {
    parse.mockResolvedValue({
      parsed_output: {
        dangerous: true,
        confidence: 0.4,
        reasoning: 'Cannot tell.',
        questionIds: ['elec-1', 'made-up', 'water-1', 'gen-1'],
      },
      model: 'claude-opus-5',
    });
    const service = await serviceWith(enabled);

    expect((await service.classify(issue())).questionIds).toEqual([
      'elec-1',
      'water-1',
      'gen-1',
    ]);
  });

  // An OBSERVATION id is escalated by the reporter's own tick, not selected
  // by the model as a follow-up question worth asking. findQuestion() would
  // resolve it, so the filter must check FOLLOW_UP specifically.
  it('discards an observation id, even though it exists in the bank', async () => {
    parse.mockResolvedValue({
      parsed_output: {
        dangerous: true,
        confidence: 0.4,
        reasoning: 'Cannot tell.',
        questionIds: ['obs-wires', 'elec-1', 'water-1', 'gen-1'],
      },
      model: 'claude-opus-5',
    });
    const service = await serviceWith(enabled);

    expect((await service.classify(issue())).questionIds).toEqual([
      'elec-1',
      'water-1',
      'gen-1',
    ]);
  });

  // Asking one or two questions is worse than asking none: it looks like a
  // process that decided something, when nothing was decided.
  it('asks nothing when fewer than three valid ids survive', async () => {
    parse.mockResolvedValue({
      parsed_output: {
        dangerous: true,
        confidence: 0.4,
        reasoning: 'Cannot tell.',
        questionIds: ['elec-1', 'made-up'],
      },
      model: 'claude-opus-5',
    });
    const service = await serviceWith(enabled);

    const { assessment, questionIds } = await service.classify(issue());

    expect(assessment.level).toBe(HazardLevel.NEEDS_REVIEW);
    expect(questionIds).toEqual([]);
  });

  it('fails closed when the API throws', async () => {
    parse.mockRejectedValue(new Error('upstream exploded'));
    const service = await serviceWith(enabled);

    const { assessment } = await service.classify(issue());

    expect(assessment.level).toBe(HazardLevel.NEEDS_REVIEW);
    expect(assessment.reasoning).toContain('upstream exploded');
  });

  // readReportImages and issue._id.toString() must sit inside the try: a
  // GridFS outage is exactly the kind of failure this method promises never
  // to let escape as a throw.
  it('fails closed, without throwing, when reading report images rejects', async () => {
    mediaService = {
      readReportImages: vi.fn().mockRejectedValue(new Error('gridfs is down')),
    };
    const module = await Test.createTestingModule({
      providers: [
        IssueHazardService,
        { provide: IssueMediaService, useValue: mediaService },
        { provide: IssuesService, useValue: { findOne: vi.fn() } },
        { provide: ConfigService, useValue: { get: (k: string) => enabled[k as keyof typeof enabled] } },
      ],
    }).compile();
    const service = module.get(IssueHazardService);

    await expect(service.classify(issue())).resolves.toMatchObject({
      assessment: { level: HazardLevel.NEEDS_REVIEW },
    });
  });

  it('records a missing parsed_output as NEEDS_REVIEW', async () => {
    parse.mockResolvedValue({ parsed_output: null, model: 'claude-opus-5' });
    const service = await serviceWith(enabled);

    const { assessment } = await service.classify(issue());

    expect(assessment.level).toBe(HazardLevel.NEEDS_REVIEW);
    expect(assessment.source).toBe(HazardSource.AI);
  });

  it('fails closed when there is no API key', async () => {
    const service = await serviceWith({});

    const { assessment } = await service.classify(issue());

    expect(assessment.level).toBe(HazardLevel.NEEDS_REVIEW);
    expect(parse).not.toHaveBeenCalled();
  });

  it('sends the answers back to the model on a second pass', async () => {
    parse.mockResolvedValue({
      parsed_output: { dangerous: false, confidence: 0.85, reasoning: 'Cleared.', questionIds: [] },
      model: 'claude-opus-5',
    });
    const service = await serviceWith(enabled);

    const { assessment } = await service.classify(issue(), [
      { questionId: 'elec-1', answer: HazardAnswer.NO },
    ]);

    expect(assessment.level).toBe(HazardLevel.UNRESTRICTED);
    const [request] = parse.mock.calls[0];
    expect(JSON.stringify(request)).toContain('elec-1');
  });

  describe('the threshold', () => {
    // Below the configured hazard threshold, even a verdict that would have
    // cleared the AI_CONFIDENCE_THRESHOLD default is sent to NEEDS_REVIEW —
    // proof the hazard gate reads its own env key, not the borrowed default.
    it('uses HAZARD_CONFIDENCE_THRESHOLD from the environment when set', async () => {
      parse.mockResolvedValue({
        parsed_output: { dangerous: false, confidence: 0.9, reasoning: 'Routine.', questionIds: [] },
        model: 'claude-opus-5',
      });
      const service = await serviceWith({
        ...enabled,
        HAZARD_CONFIDENCE_THRESHOLD: '0.95',
      });

      const { assessment } = await service.classify(issue());

      expect(assessment.level).toBe(HazardLevel.NEEDS_REVIEW);
    });

    // An out-of-range override must fall back to the hazard constant, not to
    // whatever the unrelated verification threshold happens to be.
    it('falls back to HAZARD_CONFIDENCE_THRESHOLD for an out-of-range override', async () => {
      parse.mockResolvedValue({
        parsed_output: {
          dangerous: false,
          confidence: HAZARD_CONFIDENCE_THRESHOLD,
          reasoning: 'Routine.',
          questionIds: [],
        },
        model: 'claude-opus-5',
      });
      const service = await serviceWith({
        ...enabled,
        HAZARD_CONFIDENCE_THRESHOLD: '1.5',
      });

      const { assessment } = await service.classify(issue());

      expect(assessment.level).toBe(HazardLevel.UNRESTRICTED);
    });

    // 0 would make `confidence >= threshold` true unconditionally — a
    // 0.02-confidence not-dangerous reading would clear the issue outright.
    // Zero must fall back to the real default exactly like any other
    // out-of-range value, not be honoured verbatim.
    it('falls back to HAZARD_CONFIDENCE_THRESHOLD when the override is zero', async () => {
      parse.mockResolvedValue({
        parsed_output: {
          dangerous: false,
          confidence: 0.02,
          reasoning: 'Barely looked at it.',
          questionIds: ['elec-1', 'elec-2', 'water-1'],
        },
        model: 'claude-opus-5',
      });
      const service = await serviceWith({
        ...enabled,
        HAZARD_CONFIDENCE_THRESHOLD: '0',
      });

      const { assessment } = await service.classify(issue());

      expect(assessment.level).toBe(HazardLevel.NEEDS_REVIEW);
    });

    it('falls back to HAZARD_CONFIDENCE_THRESHOLD for a negative override', async () => {
      parse.mockResolvedValue({
        parsed_output: {
          dangerous: false,
          confidence: 0.02,
          reasoning: 'Barely looked at it.',
          questionIds: ['elec-1', 'elec-2', 'water-1'],
        },
        model: 'claude-opus-5',
      });
      const service = await serviceWith({
        ...enabled,
        HAZARD_CONFIDENCE_THRESHOLD: '-0.5',
      });

      const { assessment } = await service.classify(issue());

      expect(assessment.level).toBe(HazardLevel.NEEDS_REVIEW);
    });
  });

  // Every other test stubs readReportImages to resolve []; this is the one
  // that exercises the path where photographs actually reach the request.
  it('sends the report photographs to the model, capped at HAZARD_MAX_IMAGES', async () => {
    parse.mockResolvedValue({
      parsed_output: { dangerous: false, confidence: 0.9, reasoning: 'Routine.', questionIds: [] },
      model: 'claude-opus-5',
    });
    mediaService = {
      readReportImages: vi.fn().mockResolvedValue([anImage, anImage]),
    };
    const module = await Test.createTestingModule({
      providers: [
        IssueHazardService,
        { provide: IssueMediaService, useValue: mediaService },
        { provide: IssuesService, useValue: { findOne: vi.fn() } },
        { provide: ConfigService, useValue: { get: (k: string) => enabled[k as keyof typeof enabled] } },
      ],
    }).compile();
    const service = module.get(IssueHazardService);

    await service.classify(issue());

    expect(mediaService.readReportImages).toHaveBeenCalledWith(
      expect.any(String),
      HAZARD_MAX_IMAGES,
    );
    const [request] = parse.mock.calls[0];
    const content = request.messages[0].content;
    expect(content.filter((b: { type: string }) => b.type === 'image')).toHaveLength(2);
  });

  describe('submit', () => {
    const REPORTER = new Types.ObjectId();
    const STRANGER = new Types.ObjectId();

    // Standing in for a real conditional `findOneAndUpdate`: applies the
    // update onto the same document object and returns it, exactly as if the
    // guard had matched. Individual tests override `issuesService
    // .updateIfMatches` to return null instead, simulating a lost race.
    const saved = () => {
      const document = issue({
        reportedBy: REPORTER,
        hazard: HazardLevel.UNCLASSIFIED,
      });
      issuesService.updateIfMatches = vi.fn(
        (_id: string, _expected: unknown, update: Record<string, unknown>) => {
          Object.assign(document, update);
          return Promise.resolve(document);
        },
      );
      return document;
    };

    it('refuses anyone but the reporter', async () => {
      const document = saved();
      issuesService.findOne.mockResolvedValue(document);
      const service = await serviceWith(enabled);

      await expect(
        service.submit(document._id.toString(), STRANGER.toString(), {}),
      ).rejects.toThrow(ForbiddenException);
    });

    // Otherwise a reporter could keep submitting until they liked the verdict.
    it('refuses a second submission once a level is set', async () => {
      const document = saved();
      document.hazard = HazardLevel.RESTRICTED;
      issuesService.findOne.mockResolvedValue(document);
      const service = await serviceWith(enabled);

      await expect(
        service.submit(document._id.toString(), REPORTER.toString(), {}),
      ).rejects.toThrow(ConflictException);
    });

    it('queues for review and records the questions when unsure', async () => {
      parse.mockResolvedValue({
        parsed_output: {
          dangerous: true, confidence: 0.4, reasoning: 'Cannot tell.',
          questionIds: ['elec-1', 'elec-2', 'water-1'],
        },
        model: 'claude-opus-5',
      });
      const document = saved();
      issuesService.findOne.mockResolvedValue(document);
      const service = await serviceWith(enabled);

      const result = await service.submit(
        document._id.toString(), REPORTER.toString(), {},
      );

      expect(result.hazard).toBe(HazardLevel.NEEDS_REVIEW);
      expect(result.pendingQuestions).toEqual(['elec-1', 'elec-2', 'water-1']);
    });

    it('rejects answers that do not match what was asked', async () => {
      const document = saved();
      document.hazard = HazardLevel.NEEDS_REVIEW;
      document.pendingQuestions = ['elec-1', 'elec-2', 'water-1'];
      issuesService.findOne.mockResolvedValue(document);
      const service = await serviceWith(enabled);

      await expect(
        service.submit(document._id.toString(), REPORTER.toString(), {
          answers: [{ questionId: 'elec-1', answer: HazardAnswer.NO }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('settles the issue when the answers make the model confident', async () => {
      parse.mockResolvedValue({
        parsed_output: { dangerous: false, confidence: 0.9, reasoning: 'Cleared.', questionIds: [] },
        model: 'claude-opus-5',
      });
      const document = saved();
      document.hazard = HazardLevel.NEEDS_REVIEW;
      document.pendingQuestions = ['elec-1'];
      issuesService.findOne.mockResolvedValue(document);
      const service = await serviceWith(enabled);

      const result = await service.submit(
        document._id.toString(), REPORTER.toString(),
        { answers: [{ questionId: 'elec-1', answer: HazardAnswer.NO }] },
      );

      expect(result.hazard).toBe(HazardLevel.UNRESTRICTED);
      expect(result.pendingQuestions).toEqual([]);
    });

    // Once a person has ruled, the reporter's answers are moot.
    it('refuses answers after a human has decided', async () => {
      const document = saved();
      document.hazard = HazardLevel.NEEDS_REVIEW;
      document.pendingQuestions = [];
      issuesService.findOne.mockResolvedValue(document);
      const service = await serviceWith(enabled);

      await expect(
        service.submit(document._id.toString(), REPORTER.toString(), {
          answers: [{ questionId: 'elec-1', answer: HazardAnswer.NO }],
        }),
      ).rejects.toThrow(ConflictException);
    });

    describe('the guarded write', () => {
      // classify() can take up to a minute. If an agency's PATCH
      // /issues/:id/hazard lands a RESTRICTED decision while it is running,
      // the save below must not be the one that gets the last word.
      it('guards the first-call save on the issue still being UNCLASSIFIED', async () => {
        parse.mockResolvedValue({
          parsed_output: { dangerous: false, confidence: 0.9, reasoning: 'Routine.', questionIds: [] },
          model: 'claude-opus-5',
        });
        const document = saved();
        issuesService.findOne.mockResolvedValue(document);
        const service = await serviceWith(enabled);

        await service.submit(document._id.toString(), REPORTER.toString(), {});

        const [, expected] = issuesService.updateIfMatches.mock.calls[0];
        expect(expected).toEqual({
          hazard: HazardLevel.UNCLASSIFIED,
          updatedAt: document.updatedAt,
        });
      });

      it('guards the answers-call save on pendingQuestions still matching what was asked', async () => {
        parse.mockResolvedValue({
          parsed_output: { dangerous: false, confidence: 0.9, reasoning: 'Cleared.', questionIds: [] },
          model: 'claude-opus-5',
        });
        const document = saved();
        document.hazard = HazardLevel.NEEDS_REVIEW;
        document.pendingQuestions = ['elec-1'];
        issuesService.findOne.mockResolvedValue(document);
        const service = await serviceWith(enabled);

        await service.submit(document._id.toString(), REPORTER.toString(), {
          answers: [{ questionId: 'elec-1', answer: HazardAnswer.NO }],
        });

        const [, expected] = issuesService.updateIfMatches.mock.calls[0];
        expect(expected).toEqual({
          pendingQuestions: ['elec-1'],
          updatedAt: document.updatedAt,
        });
      });

      // The interleaving this exists for: a human's RESTRICTED lands first,
      // so the guard no longer matches, and the late AI verdict must not
      // overwrite it.
      it('leaves a human decision standing when a late confident verdict loses the race', async () => {
        parse.mockResolvedValue({
          parsed_output: { dangerous: false, confidence: 0.9, reasoning: 'Routine.', questionIds: [] },
          model: 'claude-opus-5',
        });
        const document = saved();
        issuesService.findOne.mockResolvedValue(document);
        // An agency's PATCH .../hazard already moved this issue to
        // RESTRICTED while classify() was in flight, so the conditional
        // update's filter (hazard still UNCLASSIFIED) no longer matches.
        issuesService.updateIfMatches = vi.fn().mockResolvedValue(null);
        const service = await serviceWith(enabled);

        await expect(
          service.submit(document._id.toString(), REPORTER.toString(), {}),
        ).rejects.toThrow(ConflictException);
      });

      it('leaves a human decision standing when a late answers-call loses the race', async () => {
        parse.mockResolvedValue({
          parsed_output: { dangerous: false, confidence: 0.9, reasoning: 'Cleared.', questionIds: [] },
          model: 'claude-opus-5',
        });
        const document = saved();
        document.hazard = HazardLevel.NEEDS_REVIEW;
        document.pendingQuestions = ['elec-1'];
        issuesService.findOne.mockResolvedValue(document);
        issuesService.updateIfMatches = vi.fn().mockResolvedValue(null);
        const service = await serviceWith(enabled);

        await expect(
          service.submit(document._id.toString(), REPORTER.toString(), {
            answers: [{ questionId: 'elec-1', answer: HazardAnswer.NO }],
          }),
        ).rejects.toThrow(ConflictException);
      });

      // The race the hazard-only guard used to miss entirely: the reporter,
      // not an agency, edits the issue mid-flight. hazard stays UNCLASSIFIED
      // throughout (there is nothing to reset yet), so only updatedAt
      // changes — exactly what IssuesService.updateOwn's unconditional save
      // does on every edit. `updateIfMatches` here is a small in-memory
      // stand-in for a real conditional `findOneAndUpdate`: it only "writes"
      // when every key submit() asked for still matches the current record,
      // so this test proves the production filter (not a canned null) is
      // what catches the interleaving.
      it('conflicts, rather than writing UNRESTRICTED, when the reporter edits a classifier input mid-flight', async () => {
        parse.mockResolvedValue({
          parsed_output: { dangerous: false, confidence: 0.9, reasoning: 'Routine.', questionIds: [] },
          model: 'claude-opus-5',
        });
        const document = saved();
        issuesService.findOne.mockResolvedValue(document);

        const database: Record<string, unknown> = { ...document };
        issuesService.updateIfMatches = vi.fn(
          (
            _id: string,
            expected: Record<string, unknown>,
            update: Record<string, unknown>,
          ) => {
            const matches = Object.entries(expected).every(
              ([key, value]) => database[key]?.valueOf() === value?.valueOf(),
            );
            if (!matches) {
              return Promise.resolve(null);
            }
            Object.assign(database, update);
            return Promise.resolve(database);
          },
        );
        const service = await serviceWith(enabled);

        // The reporter's PATCH /issues/:id landing while classify() is
        // still awaiting the model: the description the AI judged no longer
        // matches, and IssuesService.updateOwn bumped updatedAt on the way.
        database.description = 'Live cable down on the pavement, sparking.';
        database.updatedAt = new Date(
          (document.updatedAt as Date).getTime() + 1000,
        );

        await expect(
          service.submit(document._id.toString(), REPORTER.toString(), {}),
        ).rejects.toThrow(ConflictException);
        expect(database.hazard).toBe(HazardLevel.UNCLASSIFIED);
      });
    });
  });

  describe('setLevel', () => {
    const AGENCY_ID = new Types.ObjectId().toString();
    const ADMIN_ID = new Types.ObjectId().toString();

    const saved = () => {
      const document = issue({
        hazard: HazardLevel.UNCLASSIFIED,
        save: vi.fn().mockImplementation(function (this: unknown) { return this; }),
      });
      return document;
    };

    it('records who decided and why', async () => {
      const document = saved();
      document.hazard = HazardLevel.NEEDS_REVIEW;
      document.pendingQuestions = ['elec-1'];
      issuesService.findOne.mockResolvedValue(document);
      const service = await serviceWith(enabled);

      const result = await service.setLevel(
        document._id.toString(), AGENCY_ID, [Role.AGENCY],
        { level: HazardLevel.RESTRICTED, reason: 'Live cable, utility only' },
      );

      expect(result.hazard).toBe(HazardLevel.RESTRICTED);
      expect(result.hazardAssessment?.source).toBe(HazardSource.AGENCY);
      expect(result.hazardAssessment?.decidedBy).toBe(AGENCY_ID);
      expect(result.hazardAssessment?.reasoning).toBe('Live cable, utility only');
    });

    it('marks an admin decision as an admin decision', async () => {
      const document = saved();
      issuesService.findOne.mockResolvedValue(document);
      const service = await serviceWith(enabled);

      const result = await service.setLevel(
        document._id.toString(), ADMIN_ID, [Role.ADMIN],
        { level: HazardLevel.UNRESTRICTED, reason: 'Ordinary streetlight' },
      );

      expect(result.hazardAssessment?.source).toBe(HazardSource.ADMIN);
    });

    // A decided issue must not be re-opened by a late answer.
    it('clears any pending questions', async () => {
      const document = saved();
      document.pendingQuestions = ['elec-1', 'elec-2', 'water-1'];
      issuesService.findOne.mockResolvedValue(document);
      const service = await serviceWith(enabled);

      const result = await service.setLevel(
        document._id.toString(), AGENCY_ID, [Role.AGENCY],
        { level: HazardLevel.UNRESTRICTED, reason: 'Checked on site' },
      );

      expect(result.pendingQuestions).toEqual([]);
    });
  });
});
