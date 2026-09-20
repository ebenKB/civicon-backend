import { AI_MODEL } from './../src/contracts/index.js';

/**
 * The only test that calls the real API, and so the only one that costs money.
 * Skipped unless AI_E2E=1 and a key are both present:
 *
 *   AI_E2E=1 ANTHROPIC_API_KEY=sk-... npm run test:e2e
 *
 * It asserts the shape of a real response, not a particular verdict — a vision
 * model's judgement is not a stable thing to assert on.
 *
 * Reads LIVE_ANTHROPIC_API_KEY, not ANTHROPIC_API_KEY: vitest.config.e2e.ts
 * always clears the latter so every other suite keeps running with no key,
 * even under AI_E2E=1, and forwards the real value under this other name for
 * this file alone to pick up.
 */
const liveApiKey = process.env.LIVE_ANTHROPIC_API_KEY;
const live = process.env.AI_E2E === '1' && Boolean(liveApiKey);

describe.skipIf(!live)('AI proof verification (live API)', () => {
  it('returns a parseable verdict for a real request', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
    const { z } = await import('zod');

    const client = new Anthropic({ apiKey: liveApiKey });
    const response = await client.messages.parse({
      model: AI_MODEL,
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content:
            'Return fixed=true, confidence=0.5 and a one sentence reasoning.',
        },
      ],
      output_config: {
        format: zodOutputFormat(
          z.object({
            fixed: z.boolean(),
            confidence: z.number().min(0).max(1),
            reasoning: z.string(),
          }),
        ),
      },
    });

    expect(response.parsed_output).toMatchObject({
      fixed: expect.any(Boolean),
      confidence: expect.any(Number),
      reasoning: expect.any(String),
    });
  }, 120_000);
});
