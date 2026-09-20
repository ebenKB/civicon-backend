/**
 * Whether an issue is work a member of the public may take on. Orthogonal to
 * IssueStatus: an issue can be restricted at any point in its life, and
 * folding this into the status machine would multiply its eight values.
 */
export enum HazardLevel {
  /** Created, not yet submitted for classification. Never claimable. */
  UNCLASSIFIED = 'UNCLASSIFIED',
  /** Ordinary volunteer work. The ONLY claimable value. */
  UNRESTRICTED = 'UNRESTRICTED',
  /** Needs a specialist. Volunteers are refused; an agency resolves it. */
  RESTRICTED = 'RESTRICTED',
  /** Nobody is confident enough yet. Waiting on an agency. */
  NEEDS_REVIEW = 'NEEDS_REVIEW',
}

export enum HazardSource {
  /** An observation was ticked at report time. */
  REPORTER = 'REPORTER',
  AI = 'AI',
  AGENCY = 'AGENCY',
  ADMIN = 'ADMIN',
}

/** Closed answers only: free text could not be validated, tested, or trusted. */
export enum HazardAnswer {
  YES = 'YES',
  NO = 'NO',
  UNSURE = 'UNSURE',
}

export interface HazardAssessment {
  level: HazardLevel;
  source: HazardSource;
  /** 0-1. Absent when a human decided. */
  confidence?: number;
  /** The model's reasoning, or the human's mandatory reason. */
  reasoning?: string;
  model?: string;
  /**
   * The deciding user's id, when a human decided. Stored as a string rather
   * than a ref: this is an audit record, never a join target.
   */
  decidedBy?: string;
  assessedAt: Date;
}

/** Below this, in either direction, a human decides. */
export const HAZARD_CONFIDENCE_THRESHOLD = 0.7;

export const HAZARD_MIN_QUESTIONS = 3;
export const HAZARD_MAX_QUESTIONS = 5;

/** Report photographs sent to the classifier. Base64 inflates by a third. */
export const HAZARD_MAX_IMAGES = 2;
