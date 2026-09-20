import { Types } from 'mongoose';
import {
  AiOutcome,
  HazardLevel,
  IssueCategory,
  IssueStatus,
} from '../contracts/index.js';
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
      volunteer: undefined,
      claimedAt: undefined,
      resolutionNote: undefined,
      resolvedAt: undefined,
      verifiedAt: undefined,
      aiAssessment: undefined,
      hazard: undefined,
      hazardAssessment: undefined,
      observations: [],
      pendingQuestions: undefined,
      answers: undefined,
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

    expect(result.volunteer?.id).toBe(volunteerId.toString());
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

  it('exposes the hazard and what the reporter was asked', () => {
    const result = toPublicIssue(
      issueDoc({
        hazard: HazardLevel.NEEDS_REVIEW,
        observations: ['obs-wires'],
        pendingQuestions: ['elec-1', 'elec-2', 'water-1'],
      }),
    );

    expect(result.hazard).toBe(HazardLevel.NEEDS_REVIEW);
    expect(result.observations).toEqual(['obs-wires']);
    expect(result.pendingQuestions).toEqual(['elec-1', 'elec-2', 'water-1']);
  });
});

describe('toPublicIssue volunteer', () => {
  const volunteerId = new Types.ObjectId();

  it('names the volunteer holding the issue', () => {
    const result = toPublicIssue(
      issueDoc({ volunteerId, status: IssueStatus.CLAIMED }),
      [],
      'Kofi Volunteer',
    );

    expect(result.volunteer).toEqual({
      id: volunteerId.toString(),
      name: 'Kofi Volunteer',
    });
  });

  // An account can be deleted while its work stays on the record, so the id is
  // reported with or without a name to go against it.
  it('keeps the volunteer id when no name is known', () => {
    const result = toPublicIssue(
      issueDoc({ volunteerId, status: IssueStatus.CLAIMED }),
      [],
    );

    expect(result.volunteer).toEqual({ id: volunteerId.toString() });
  });

  // The reporter is deliberately not named: the list endpoint is public, and a
  // name beside every report tells the whole internet who complained.
  it('never names the reporter', () => {
    const result = toPublicIssue(issueDoc(), [], 'Kofi Volunteer');

    expect(result.reportedBy).toBe(reporterId.toString());
    expect(JSON.stringify(result)).not.toContain('Kofi Volunteer');
  });
});
