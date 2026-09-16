export enum AiOutcome {
  /** At or above the threshold, and the model judged the problem fixed. */
  APPROVED = 'APPROVED',
  /** Assessed, but not confidently enough to approve. An agency decides. */
  BELOW_THRESHOLD = 'BELOW_THRESHOLD',
  /** No REPORT photo to compare against, so no assessment was attempted. */
  SKIPPED_NO_BEFORE = 'SKIPPED_NO_BEFORE',
  /** The API errored or timed out. The resolution still stands. */
  FAILED = 'FAILED',
}

export interface AiAssessment {
  outcome: AiOutcome;
  /** 0-1. Absent for SKIPPED_NO_BEFORE and FAILED. */
  confidence?: number;
  /** The model's explanation, or the failure, shown to the agency. */
  reasoning?: string;
  model?: string;
  assessedAt: Date;
}

export const AI_CONFIDENCE_THRESHOLD = 0.7;
export const AI_MAX_IMAGES_PER_SIDE = 2;
export const AI_MODEL = 'claude-opus-5';

/**
 * A volunteer is waiting on this call, so it must fail fast rather than
 * correctly-but-eventually. The SDK defaults to a 10 minute timeout and two
 * retries — on a synchronous path that is up to half an hour of a held request
 * before FAILED is ever recorded.
 */
export const AI_TIMEOUT_MS = 60_000;
export const AI_MAX_RETRIES = 1;

/**
 * A misconfigured threshold must not silently make approval easier, so anything
 * unparseable or outside 0-1 falls back to the default rather than being used.
 */
export function resolveThreshold(raw: string | undefined): number {
  const parsed = Number(raw);
  if (raw === undefined || raw === '' || Number.isNaN(parsed)) {
    return AI_CONFIDENCE_THRESHOLD;
  }
  if (parsed < 0 || parsed > 1) {
    return AI_CONFIDENCE_THRESHOLD;
  }
  return parsed;
}
