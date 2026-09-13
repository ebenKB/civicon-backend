/**
 * The platform's actor types. Verbatim from the execution guide §4.1 — this is
 * the single source of truth; never redefine these strings locally.
 */
export enum Role {
  CITIZEN = 'CITIZEN',
  VOLUNTEER = 'VOLUNTEER',
  AGENCY = 'AGENCY',
  SPONSOR = 'SPONSOR',
  ADMIN = 'ADMIN',
}

/**
 * Roles a user may grant themselves at registration. AGENCY, SPONSOR and ADMIN
 * are deliberately absent: agencies are the authoritative owners of issues, so
 * that authority cannot be self-assigned by anyone who can reach the signup
 * form. They are created by the seed or by an admin.
 */
export const PUBLIC_ROLES: readonly Role[] = [Role.CITIZEN, Role.VOLUNTEER];

/**
 * A volunteer is a citizen who also does the work — there is no coherent actor
 * who can fix a problem but not report one. Granting VOLUNTEER therefore grants
 * CITIZEN too. The privileged roles are orthogonal to citizenship and imply
 * nothing.
 */
export function applyRoleImplications(roles: Role[]): Role[] {
  const result = new Set<Role>(roles);
  if (result.has(Role.VOLUNTEER)) {
    result.add(Role.CITIZEN);
  }
  return [...result];
}
