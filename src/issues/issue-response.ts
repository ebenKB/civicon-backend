import {
  AiAssessment,
  HazardAnswer,
  HazardAssessment,
  HazardLevel,
  IssueCategory,
  IssueStatus,
} from '../contracts/index.js';
import { PublicMedia } from './issue-media-response.js';
import { IssueDocument } from './schemas/issue.schema.js';

/**
 * The issue shape the API returns. Deliberately explicit: adding a field to the
 * schema must not silently widen what the API exposes.
 */
export interface PublicIssue {
  id: string;
  title: string;
  description: string;
  category: IssueCategory;
  location: string;
  status: IssueStatus;
  reportedBy: string;
  statusReason?: string;
  duplicateOf?: string;
  /**
   * Who holds the issue, named. The reporter is deliberately only an id: this
   * shape is served by a public, token-free endpoint, and a name beside every
   * report tells anyone who complained about what. A volunteer is a public
   * actor by choice — the points they earn are credit for exactly this work.
   *
   * `name` is absent when the account has since been deleted; the id stays, so
   * "is this mine?" keeps working either way.
   */
  volunteer?: { id: string; name?: string };
  claimedAt?: Date;
  resolutionNote?: string;
  resolvedAt?: Date;
  verifiedAt?: Date;
  aiAssessment?: AiAssessment;
  /** Whether a volunteer may take this on. The only claimable value is UNRESTRICTED. */
  hazard: HazardLevel;
  hazardAssessment?: HazardAssessment;
  /** Question ids the reporter ticked when reporting. */
  observations: string[];
  /** Question ids sent to the reporter and not yet answered or superseded. */
  pendingQuestions?: string[];
  answers?: { questionId: string; answer: HazardAnswer }[];
  media: PublicMedia[];
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicIssue(
  issue: IssueDocument,
  media: PublicMedia[] = [],
  volunteerName?: string,
): PublicIssue {
  return {
    id: issue._id.toString(),
    title: issue.title,
    description: issue.description,
    category: issue.category,
    location: issue.location,
    status: issue.status,
    reportedBy: issue.reportedBy.toString(),
    statusReason: issue.statusReason,
    duplicateOf: issue.duplicateOf?.toString(),
    volunteer: issue.volunteerId
      ? {
          id: issue.volunteerId.toString(),
          // Spread so the key is absent rather than explicitly undefined: this
          // shape goes straight out as JSON.
          ...(volunteerName === undefined ? {} : { name: volunteerName }),
        }
      : undefined,
    claimedAt: issue.claimedAt,
    resolutionNote: issue.resolutionNote,
    resolvedAt: issue.resolvedAt,
    verifiedAt: issue.verifiedAt,
    aiAssessment: issue.aiAssessment,
    hazard: issue.hazard,
    hazardAssessment: issue.hazardAssessment,
    observations: issue.observations ?? [],
    pendingQuestions: issue.pendingQuestions,
    answers: issue.answers,
    media,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}
