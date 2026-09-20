import { HazardLevel, HazardSource, HazardAnswer } from './hazard.js';

describe('HazardLevel', () => {
  // UNRESTRICTED is the only claimable value, and the gate is written as an
  // equality check against it. A new level is therefore safe by default.
  it('is exactly these four values', () => {
    expect(Object.values(HazardLevel)).toEqual([
      'UNCLASSIFIED',
      'UNRESTRICTED',
      'RESTRICTED',
      'NEEDS_REVIEW',
    ]);
  });

  it('names who can decide', () => {
    expect(Object.values(HazardSource)).toEqual([
      'REPORTER',
      'AI',
      'AGENCY',
      'ADMIN',
    ]);
  });

  it('offers only closed answers', () => {
    expect(Object.values(HazardAnswer)).toEqual(['YES', 'NO', 'UNSURE']);
  });
});
