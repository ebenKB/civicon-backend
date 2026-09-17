import { PointsReason } from '../../contracts/index.js';
import { PointTransactionSchema } from './point-transaction.schema.js';

describe('PointTransactionSchema', () => {
  it('requires a user, an issue, an amount and a reason', () => {
    for (const field of ['userId', 'issueId', 'amount', 'reason']) {
      expect(PointTransactionSchema.path(field).isRequired).toBe(true);
    }
  });

  it('references users and issues as ObjectIds', () => {
    expect(PointTransactionSchema.path('userId').options.ref).toBe('User');
    expect(PointTransactionSchema.path('issueId').options.ref).toBe('Issue');
  });

  it('constrains the reason to the enum', () => {
    expect(PointTransactionSchema.path('reason').options.enum).toEqual(
      Object.values(PointsReason),
    );
  });

  it('indexes user and issue together, for balances and the idempotency check', () => {
    const indexes = PointTransactionSchema.indexes();

    expect(
      indexes.some(([spec]) => 'userId' in spec && 'issueId' in spec),
    ).toBe(true);
  });
});
