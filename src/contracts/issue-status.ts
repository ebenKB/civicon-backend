/**
 * The full arc an issue travels, declared in one place. A citizen reports
 * OPEN; a volunteer CLAIMED it, moves it to IN_PROGRESS, and RESOLVED it with
 * proof. From RESOLVED, an agency verifies directly, or the AI's assessment
 * parks it in AI_APPROVED first — a recommendation, not a payout — where an
 * agency still confirms to VERIFIED or sends it back to IN_PROGRESS. Points
 * are awarded only on reaching VERIFIED, and only a human ever puts an issue
 * there. REJECTED and DUPLICATE end the arc from OPEN.
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
