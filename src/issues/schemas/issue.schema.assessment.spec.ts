import { AiOutcome } from '../../contracts/index.js';
import { IssueSchema } from './issue.schema.js';

describe('IssueSchema assessment field', () => {
  it('stores the outcome as a string constrained to the enum', () => {
    const path = IssueSchema.path('aiAssessment.outcome');

    expect(path.instance).toBe('String');
    expect(path.options.enum).toEqual(Object.values(AiOutcome));
  });

  it('is optional, so an unassessed issue carries nothing', () => {
    expect(IssueSchema.path('aiAssessment.outcome').isRequired).toBeFalsy();
  });

  it('indexes the outcome, so the agency queue is not a scan', () => {
    const indexes = IssueSchema.indexes();

    expect(indexes.some(([spec]) => 'aiAssessment.outcome' in spec)).toBe(true);
  });
});
