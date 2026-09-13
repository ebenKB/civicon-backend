import { IssueCategory, IssueStatus } from './index.js';

describe('IssueStatus', () => {
  it('names the whole lifecycle, including states slice A cannot reach', () => {
    expect(Object.values(IssueStatus)).toEqual([
      'OPEN',
      'CLAIMED',
      'IN_PROGRESS',
      'RESOLVED',
      'VERIFIED',
      'REJECTED',
      'DUPLICATE',
    ]);
  });

  it('uses identical keys and values, so stored data reads as the enum', () => {
    for (const [key, value] of Object.entries(IssueStatus)) {
      expect(key).toBe(value);
    }
  });
});

describe('IssueCategory', () => {
  it('lists the reportable categories', () => {
    expect(Object.values(IssueCategory)).toEqual([
      'SANITATION',
      'ROADS',
      'WATER',
      'ELECTRICITY',
      'DRAINAGE',
      'PUBLIC_SAFETY',
      'OTHER',
    ]);
  });

  it('uses identical keys and values', () => {
    for (const [key, value] of Object.entries(IssueCategory)) {
      expect(key).toBe(value);
    }
  });
});
