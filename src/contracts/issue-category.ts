/**
 * What a citizen is reporting. A fixed enum rather than a collection, following
 * the Role precedent — an admin-managed category table is a later slice if it
 * is ever wanted.
 */
export enum IssueCategory {
  SANITATION = 'SANITATION',
  ROADS = 'ROADS',
  WATER = 'WATER',
  ELECTRICITY = 'ELECTRICITY',
  DRAINAGE = 'DRAINAGE',
  PUBLIC_SAFETY = 'PUBLIC_SAFETY',
  OTHER = 'OTHER',
}
