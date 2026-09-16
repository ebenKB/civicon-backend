import { IssueSchema } from './issue.schema.js';

// Imports IssueSchema as a VALUE so the module actually executes — a spec that
// imports only a type is erased and cannot catch a schema that fails to build.
describe('IssueSchema claim fields', () => {
  it('references the volunteer as an ObjectId', () => {
    expect(IssueSchema.path('volunteerId').instance).toBe('ObjectId');
    expect(IssueSchema.path('volunteerId').options.ref).toBe('User');
  });

  it('indexes volunteerId, so "what am I working on" is not a scan', () => {
    expect(IssueSchema.path('volunteerId').options.index).toBe(true);
  });

  it('leaves every claim field optional, so no migration is needed', () => {
    for (const field of [
      'volunteerId',
      'claimedAt',
      'resolutionNote',
      'resolvedAt',
      'verifiedAt',
    ]) {
      expect(IssueSchema.path(field).isRequired).toBeFalsy();
    }
  });

  it('caps the resolution note', () => {
    expect(IssueSchema.path('resolutionNote').options.maxlength).toBe(2000);
  });
});
