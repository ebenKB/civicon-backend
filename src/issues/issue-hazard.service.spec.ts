import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import {
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
});
