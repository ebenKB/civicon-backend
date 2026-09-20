import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import {
  HAZARD_CONFIDENCE_THRESHOLD,
  HAZARD_MAX_IMAGES,
  HazardAnswer,
  HazardLevel,
  HazardSource,
  IssueCategory,
} from '../contracts/index.js';
import { IssueMediaService } from './issue-media.service.js';
import { IssueHazardService } from './issue-hazard.service.js';
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
    ...overrides,
  }) as unknown as IssueDocument;

describe('IssueHazardService', () => {
  let mediaService: { readReportImages: ReturnType<typeof vi.fn> };

  const serviceWith = async (config: Record<string, string>) => {
    mediaService = { readReportImages: vi.fn().mockResolvedValue([]) };
    const module = await Test.createTestingModule({
      providers: [
        IssueHazardService,
        { provide: IssueMediaService, useValue: mediaService },
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
});
