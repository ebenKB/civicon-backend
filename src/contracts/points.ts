export enum PointsReason {
  RESOLUTION_VERIFIED = 'RESOLUTION_VERIFIED',
  VERIFICATION_REVERSED = 'VERIFICATION_REVERSED',
}

/**
 * Flat, for every issue. Nothing to tune and nothing to dispute — and no
 * incentive to cherry-pick categories. The ledger records the issue, so a
 * weighted scheme later needs no migration.
 */
export const POINTS_PER_VERIFIED_RESOLUTION = 10;
