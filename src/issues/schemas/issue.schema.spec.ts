import { IssueCategory, IssueStatus } from '../../contracts/index.js';
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
