/**
 * The platform's actor types: the public, the authority, the funder, the
 * operator. Single source of truth — never redefine these strings locally.
 *
 * There is deliberately no VOLUNTEER role, diverging from execution guide §4.1.
 * Volunteering is an action a citizen takes, not an identity they hold: a claim
 * is refused because of the ISSUE's eligibility, lock and assignment state, and
 * anti-self-dealing compares reportedBy against volunteerId. Neither reads a
 * role, so a VOLUNTEER role would gate nothing.
 *
 * See docs/superpowers/specs/2026-09-13-auth-identity-design.md §1 for the full
 * argument and for what should be built instead when RESTRICTED eligibility
 * arrives (a per-category credential, not a role).
 */
export enum Role {
  CITIZEN = 'CITIZEN',
  AGENCY = 'AGENCY',
  SPONSOR = 'SPONSOR',
  ADMIN = 'ADMIN',
}
