import {
  AiAssessment,
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
  volunteerId?: string;
  claimedAt?: Date;
  resolutionNote?: string;
  resolvedAt?: Date;
  verifiedAt?: Date;
  aiAssessment?: AiAssessment;
  media: PublicMedia[];
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicIssue(
  issue: IssueDocument,
  media: PublicMedia[] = [],
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
    volunteerId: issue.volunteerId?.toString(),
    claimedAt: issue.claimedAt,
    resolutionNote: issue.resolutionNote,
    resolvedAt: issue.resolvedAt,
    verifiedAt: issue.verifiedAt,
    aiAssessment: issue.aiAssessment,
    media,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}
