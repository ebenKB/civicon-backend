import { Types } from 'mongoose';
import { AiOutcome, IssueCategory, IssueStatus } from '../contracts/index.js';
import { IssueDocument } from './schemas/issue.schema.js';
import { toPublicIssue } from './issue-response.js';

const reporterId = new Types.ObjectId();
const issueId = new Types.ObjectId();

const issueDoc = (overrides: Record<string, unknown> = {}) =>
  ({
    _id: issueId,
    title: 'Broken streetlight',
    description: 'Dark since Tuesday.',
    category: IssueCategory.ELECTRICITY,
    location: 'Ring Road East, near the bank',
    status: IssueStatus.OPEN,
    reportedBy: reporterId,
    createdAt: new Date('2026-09-13T10:00:00Z'),
    updatedAt: new Date('2026-09-13T10:00:00Z'),
    ...overrides,
  }) as unknown as IssueDocument;

describe('toPublicIssue', () => {
  it('maps the document onto the public shape', () => {
    expect(toPublicIssue(issueDoc())).toEqual({
      id: issueId.toString(),
      title: 'Broken streetlight',
      description: 'Dark since Tuesday.',
      category: IssueCategory.ELECTRICITY,
      location: 'Ring Road East, near the bank',
      status: IssueStatus.OPEN,
      reportedBy: reporterId.toString(),
      statusReason: undefined,
      duplicateOf: undefined,
      volunteerId: undefined,
      claimedAt: undefined,
      resolutionNote: undefined,
      resolvedAt: undefined,
      verifiedAt: undefined,
      aiAssessment: undefined,
      media: [],
      createdAt: new Date('2026-09-13T10:00:00Z'),
      updatedAt: new Date('2026-09-13T10:00:00Z'),
    });
  });

  it('renders ids as strings, not ObjectIds', () => {
    const result = toPublicIssue(issueDoc());

    expect(typeof result.id).toBe('string');
    expect(typeof result.reportedBy).toBe('string');
  });

  it('includes the triage fields when they are set', () => {
    const duplicateOf = new Types.ObjectId();
    const result = toPublicIssue(
      issueDoc({
        status: IssueStatus.DUPLICATE,
        statusReason: 'Already reported',
        duplicateOf,
      }),
    );

    expect(result.status).toBe(IssueStatus.DUPLICATE);
    expect(result.statusReason).toBe('Already reported');
    expect(result.duplicateOf).toBe(duplicateOf.toString());
  });

  it('does not leak fields that are not in the public shape', () => {
    const result = toPublicIssue(issueDoc({ internalNote: 'secret' }));

    expect(result).not.toHaveProperty('internalNote');
  });
  it('carries the media it is given', () => {
    const media = [
      {
        id: 'abc',
        filename: 'culvert.png',
        contentType: 'image/png',
        size: 10,
        uploadedAt: new Date(),
        url: '/issues/media/abc',
      },
    ];

    expect(toPublicIssue(issueDoc(), media).media).toEqual(media);
  });

  it('defaults to an empty array rather than omitting the field', () => {
    expect(toPublicIssue(issueDoc()).media).toEqual([]);
  });
  it('renders the volunteer id as a string', () => {
    const volunteerId = new Types.ObjectId();

    const result = toPublicIssue(issueDoc({ volunteerId }));

    expect(result.volunteerId).toBe(volunteerId.toString());
  });
  it('carries an assessment when one exists', () => {
    const assessment = {
      outcome: AiOutcome.BELOW_THRESHOLD,
      confidence: 0.4,
      reasoning: 'The grate is still partly obstructed.',
      model: 'claude-opus-5',
      assessedAt: new Date(),
    };

    expect(
      toPublicIssue(issueDoc({ aiAssessment: assessment })).aiAssessment,
    ).toEqual(assessment);
  });
});
