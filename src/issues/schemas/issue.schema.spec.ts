import mongoose from 'mongoose';
import {
  IssueCategory,
  IssueStatus,
  HazardLevel,
} from '../../contracts/index.js';
import { IssueSchema } from './issue.schema.js';

// This spec imports IssueSchema as a VALUE on purpose. A spec that imports only
// the IssueDocument type is erased at transpile time and never executes the
// module, so it cannot catch a schema that fails to build.
describe('IssueSchema', () => {
  it('builds', () => {
    expect(IssueSchema.path('title')).toBeDefined();
  });

  it('stores the enums as strings', () => {
    expect(IssueSchema.path('status').instance).toBe('String');
    expect(IssueSchema.path('category').instance).toBe('String');
  });

  it('constrains status and category to their enums', () => {
    expect(IssueSchema.path('status').options.enum).toEqual(
      Object.values(IssueStatus),
    );
    expect(IssueSchema.path('category').options.enum).toEqual(
      Object.values(IssueCategory),
    );
  });

  it('defaults status to OPEN so creation need not pass one', () => {
    expect(IssueSchema.path('status').options.default).toBe(IssueStatus.OPEN);
  });

  it('references the reporter as an ObjectId', () => {
    expect(IssueSchema.path('reportedBy').instance).toBe('ObjectId');
    expect(IssueSchema.path('reportedBy').options.ref).toBe('User');
  });

  it('requires the fields a report cannot omit', () => {
    for (const field of ['title', 'description', 'category', 'location']) {
      expect(IssueSchema.path(field).isRequired).toBe(true);
    }
  });
});

describe('Issue hazard fields', () => {
  const Model =
    mongoose.models.IssueHazardSpec ??
    mongoose.model('IssueHazardSpec', IssueSchema);

  // An issue is unclaimable the moment it exists. Claimable is something it
  // has to earn, never the state it starts in.
  it('starts UNCLASSIFIED', () => {
    const issue = new Model({
      title: 'Blocked drain',
      description: 'Standing water.',
      category: 'DRAINAGE',
      location: 'Market Street',
      reportedBy: new mongoose.Types.ObjectId(),
    });

    expect(issue.hazard).toBe(HazardLevel.UNCLASSIFIED);
    expect(issue.observations).toEqual([]);
  });

  it('rejects a hazard outside the enum', () => {
    const issue = new Model({
      title: 'Blocked drain',
      description: 'Standing water.',
      category: 'DRAINAGE',
      location: 'Market Street',
      reportedBy: new mongoose.Types.ObjectId(),
      hazard: 'PROBABLY_FINE',
    });

    expect(issue.validateSync()?.errors.hazard).toBeDefined();
  });

  it('indexes hazard exactly once, because it is a queue', () => {
    const hazardIndexCount = IssueSchema.indexes().filter(
      ([fields]) => 'hazard' in fields,
    ).length;
    expect(hazardIndexCount).toBe(1);
  });
});
