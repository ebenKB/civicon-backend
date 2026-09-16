import {
  AI_CONFIDENCE_THRESHOLD,
  AiOutcome,
  resolveThreshold,
} from './index.js';

describe('AiOutcome', () => {
  it('has no rejection outcome', () => {
    // The model may approve or defer to a human. A confident "not fixed" is
    // BELOW_THRESHOLD, never a rejection: a false negative would cost a
    // volunteer their credit on the model's say-so.
    expect(Object.values(AiOutcome)).not.toContain('REJECTED');
  });

  it('names the four outcomes', () => {
    expect(Object.values(AiOutcome)).toEqual([
      'APPROVED',
      'BELOW_THRESHOLD',
      'SKIPPED_NO_BEFORE',
      'FAILED',
    ]);
  });
});

describe('resolveThreshold', () => {
  it('defaults when unset', () => {
    expect(resolveThreshold(undefined)).toBe(AI_CONFIDENCE_THRESHOLD);
  });

  it('accepts a value inside the range', () => {
    expect(resolveThreshold('0.85')).toBe(0.85);
  });

  it.each(['-0.1', '1.5', 'not-a-number', ''])(
    'falls back to the default for %s rather than trusting it',
    (raw) => {
      expect(resolveThreshold(raw)).toBe(AI_CONFIDENCE_THRESHOLD);
    },
  );

  it('accepts the boundaries', () => {
    expect(resolveThreshold('0')).toBe(0);
    expect(resolveThreshold('1')).toBe(1);
  });
});
