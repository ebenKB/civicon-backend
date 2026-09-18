import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { AiOutcome, IssueStatus } from '../contracts/index.js';
import { IssueMediaService } from './issue-media.service.js';
import { IssueVerificationService } from './issue-verification.service.js';

const parse = vi.fn();

// Mocked at the module boundary, so no test can construct a real client or
// reach the network.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { parse };
  },
}));

const VOLUNTEER = '507f1f77bcf86cd799439044';

const issue = () =>
  ({
    _id: new Types.ObjectId(),
    title: 'Blocked drain',
    description: 'Standing water.',
    category: 'DRAINAGE',
    location: 'Market Street',
    status: IssueStatus.RESOLVED,
    volunteerId: new Types.ObjectId(VOLUNTEER),
  }) as never;

const anImage = { base64: 'aW1n', contentType: 'image/png' };

describe('IssueVerificationService', () => {
  let mediaService: { readForAssessment: ReturnType<typeof vi.fn> };

  const serviceWith = async (
    env: Record<string, string | undefined>,
  ): Promise<IssueVerificationService> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IssueVerificationService,
        { provide: IssueMediaService, useValue: mediaService },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => env[key] },
        },
      ],
    }).compile();
    return module.get(IssueVerificationService);
  };

  const enabled = { ANTHROPIC_API_KEY: 'sk-test' };

  beforeEach(() => {
    parse.mockReset();
    mediaService = {
      readForAssessment: vi
        .fn()
        .mockResolvedValue({ before: [anImage], after: [anImage] }),
    };
  });

  const verdict = (fixed: boolean, confidence: number) => ({
    parsed_output: { fixed, confidence, reasoning: 'because' },
    model: 'claude-opus-5',
  });

  describe('the feature switch', () => {
    it('returns undefined with no API key, and never calls the API', async () => {
      const service = await serviceWith({});

      await expect(service.assess(issue())).resolves.toBeUndefined();
      expect(parse).not.toHaveBeenCalled();
    });

    it('respects an explicit AI_VERIFICATION_ENABLED=false', async () => {
      const service = await serviceWith({
        ...enabled,
        AI_VERIFICATION_ENABLED: 'false',
      });

      await expect(service.assess(issue())).resolves.toBeUndefined();
    });
  });

  describe('the threshold', () => {
    it.each([
      [0.69, AiOutcome.BELOW_THRESHOLD],
      [0.7, AiOutcome.APPROVED],
      [0.71, AiOutcome.APPROVED],
    ])('confidence %s yields %s', async (confidence, outcome) => {
      parse.mockResolvedValue(verdict(true, confidence));
      const service = await serviceWith(enabled);

      const result = await service.assess(issue());

      expect(result?.outcome).toBe(outcome);
      expect(result?.confidence).toBe(confidence);
    });

    it('never approves when the model says it is not fixed, however confident', async () => {
      parse.mockResolvedValue(verdict(false, 0.99));
      const service = await serviceWith(enabled);

      const result = await service.assess(issue());

      // Not an approval, and not a rejection either: a human decides.
      expect(result?.outcome).toBe(AiOutcome.BELOW_THRESHOLD);
    });

    it('honours a configured threshold', async () => {
      parse.mockResolvedValue(verdict(true, 0.8));
      const service = await serviceWith({
        ...enabled,
        AI_CONFIDENCE_THRESHOLD: '0.9',
      });

      expect((await service.assess(issue()))?.outcome).toBe(
        AiOutcome.BELOW_THRESHOLD,
      );
    });
  });

  describe('when it cannot judge', () => {
    it('skips without calling the API when there is no before photo', async () => {
      mediaService.readForAssessment.mockResolvedValue({
        before: [],
        after: [anImage],
      });
      const service = await serviceWith(enabled);

      const result = await service.assess(issue());

      expect(result?.outcome).toBe(AiOutcome.SKIPPED_NO_BEFORE);
      expect(parse).not.toHaveBeenCalled();
    });

    // Proof is required to resolve, so an empty after side means the only
    // evidence was a video nothing could read. Asking the model to judge a
    // repair it is shown no picture of costs a paid call to be told "no".
    it('fails without calling the API when no proof image could be read', async () => {
      mediaService.readForAssessment.mockResolvedValue({
        before: [anImage],
        after: [],
      });
      const service = await serviceWith(enabled);

      const result = await service.assess(issue());

      expect(result?.outcome).toBe(AiOutcome.FAILED);
      expect(result?.reasoning).toContain('proof');
      expect(parse).not.toHaveBeenCalled();
    });

    it('records a thrown API error as FAILED rather than propagating', async () => {
      parse.mockRejectedValue(new Error('upstream exploded'));
      const service = await serviceWith(enabled);

      const result = await service.assess(issue());

      expect(result?.outcome).toBe(AiOutcome.FAILED);
      expect(result?.reasoning).toContain('upstream exploded');
    });

    it('records a missing parsed_output as FAILED', async () => {
      parse.mockResolvedValue({ parsed_output: null });
      const service = await serviceWith(enabled);

      expect((await service.assess(issue()))?.outcome).toBe(AiOutcome.FAILED);
    });
  });

  describe('the request', () => {
    it('sends both sides as images and the report as text', async () => {
      parse.mockResolvedValue(verdict(true, 0.9));
      const service = await serviceWith(enabled);

      await service.assess(issue());

      const [params] = parse.mock.calls[0];
      const content = params.messages[0].content;
      expect(
        content.filter((b: { type: string }) => b.type === 'image'),
      ).toHaveLength(2);
      expect(JSON.stringify(content)).toContain('Blocked drain');
      expect(params.model).toBe('claude-opus-5');
    });

    it('asks the media service for the holder proof, not just any proof', async () => {
      parse.mockResolvedValue(verdict(true, 0.9));
      const service = await serviceWith(enabled);

      await service.assess(issue());

      expect(mediaService.readForAssessment).toHaveBeenCalledWith(
        expect.any(String),
        VOLUNTEER,
        2,
      );
    });
  });
});
