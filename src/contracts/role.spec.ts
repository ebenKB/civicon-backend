import { applyRoleImplications, PUBLIC_ROLES, Role } from './role.js';

describe('PUBLIC_ROLES', () => {
  it('contains only the self-serve roles', () => {
    expect([...PUBLIC_ROLES]).toEqual([Role.CITIZEN, Role.VOLUNTEER]);
  });

  it.each([Role.AGENCY, Role.SPONSOR, Role.ADMIN])(
    'excludes the privileged role %s',
    (role) => {
      expect(PUBLIC_ROLES).not.toContain(role);
    },
  );
});

describe('applyRoleImplications', () => {
  it('adds CITIZEN when VOLUNTEER is granted', () => {
    expect(applyRoleImplications([Role.VOLUNTEER])).toEqual([
      Role.VOLUNTEER,
      Role.CITIZEN,
    ]);
  });

  it('leaves an existing CITIZEN + VOLUNTEER pair untouched', () => {
    expect(applyRoleImplications([Role.CITIZEN, Role.VOLUNTEER])).toEqual([
      Role.CITIZEN,
      Role.VOLUNTEER,
    ]);
  });

  it('does not add CITIZEN to privileged roles', () => {
    expect(applyRoleImplications([Role.AGENCY])).toEqual([Role.AGENCY]);
    expect(applyRoleImplications([Role.ADMIN])).toEqual([Role.ADMIN]);
  });

  it('de-duplicates repeated roles', () => {
    expect(applyRoleImplications([Role.CITIZEN, Role.CITIZEN])).toEqual([
      Role.CITIZEN,
    ]);
  });
});
