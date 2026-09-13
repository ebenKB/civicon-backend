import { Role } from './role.js';

describe('Role', () => {
  // Pins the contract the user schema validates against and that @Roles()
  // guards are written in terms of. It fails if a role is added without a
  // deliberate decision — notably VOLUNTEER, which was removed on purpose:
  // see the doc comment on the enum.
  it('is exactly the four actor types', () => {
    expect(Object.values(Role)).toEqual([
      'CITIZEN',
      'AGENCY',
      'SPONSOR',
      'ADMIN',
    ]);
  });

  it('does not carry a VOLUNTEER role', () => {
    expect(Object.values(Role)).not.toContain('VOLUNTEER');
  });
});
