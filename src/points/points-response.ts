import { PointsReason } from '../contracts/index.js';
import type { PointTransactionDocument } from './schemas/point-transaction.schema.js';

/** Explicit, like every other response shape in this codebase. */
export interface PublicPointTransaction {
  id: string;
  issueId: string;
  amount: number;
  reason: PointsReason;
  createdAt: Date;
}

export interface PublicPointsBalance {
  balance: number;
  transactions: PublicPointTransaction[];
}

export function toPublicTransaction(
  transaction: PointTransactionDocument,
): PublicPointTransaction {
  return {
    id: transaction._id.toString(),
    issueId: transaction.issueId.toString(),
    amount: transaction.amount,
    reason: transaction.reason,
    createdAt: transaction.createdAt,
  };
}
