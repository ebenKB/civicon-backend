/**
 * The full arc an issue travels, declared in one place.
 *
 * CLAIMED, IN_PROGRESS, RESOLVED and VERIFIED are unreachable in the reporting
 * slice: nothing transitions into them yet. They are declared anyway so the
 * claim-and-resolution slice implements transitions rather than widening the
 * contract, and so stored data never needs an enum migration.
 */
export enum IssueStatus {
  OPEN = 'OPEN',
  CLAIMED = 'CLAIMED',
  IN_PROGRESS = 'IN_PROGRESS',
  RESOLVED = 'RESOLVED',
  /**
   * The AI judged the work done, and nothing else has. Awards nothing: an
   * agency confirms before any points move. Only the system puts an issue
   * here — see AGENCY_TARGETS.
   */
  AI_APPROVED = 'AI_APPROVED',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
  DUPLICATE = 'DUPLICATE',
}
