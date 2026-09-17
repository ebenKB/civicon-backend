import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import mongoose, { Types } from 'mongoose';
import { PointsReason } from '../contracts/index.js';
import { UsersService } from '../users/users.service.js';
import { CivicPointsService } from './civic-points.service.js';
import { PointTransaction } from './schemas/point-transaction.schema.js';

const VOLUNTEER = '507f1f77bcf86cd799439044';
const ISSUE = '507f1f77bcf86cd799439022';

const issue = (volunteerId?: string) =>
  ({
    _id: new Types.ObjectId(ISSUE),
    volunteerId: volunteerId ? new Types.ObjectId(volunteerId) : undefined,
  }) as never;

describe('CivicPointsService', () => {
  let service: CivicPointsService;
  let model: {
    create: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
  };
  let usersService: { setPointsCache: ReturnType<typeof vi.fn> };

  const execOf = <T>(value: T) => ({ exec: () => Promise.resolve(value) });
  const chainOf = <T>(value: T) => {
    const chain = {
      sort: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      exec: () => Promise.resolve(value),
    };
    return chain;
  };

  /**
   * What the ledger currently nets for this (user, issue) pair, and how many
   * rows already exist for it (the next row's `sequence`).
   */
  const ledgerNets = (total: number, count = total === 0 ? 0 : 1) =>
    model.aggregate.mockResolvedValue(
      total === 0 && count === 0 ? [] : [{ total, count }],
    );

  beforeEach(async () => {
    model = { create: vi.fn(), find: vi.fn(), aggregate: vi.fn() };
    usersService = { setPointsCache: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CivicPointsService,
        { provide: getModelToken(PointTransaction.name), useValue: model },
        { provide: UsersService, useValue: usersService },
      ],
    }).compile();

    service = module.get(CivicPointsService);
  });

  describe('awarding', () => {
    it('writes a positive entry and refreshes the cache', async () => {
      ledgerNets(0);

      await service.awardForVerification(issue(VOLUNTEER));

      const [entry] = model.create.mock.calls[0];
      expect(entry.amount).toBe(10);
      expect(entry.reason).toBe(PointsReason.RESOLUTION_VERIFIED);
      expect(entry.userId.toString()).toBe(VOLUNTEER);
      expect(usersService.setPointsCache).toHaveBeenCalled();
    });

    // VERIFIED -> IN_PROGRESS -> RESOLVED -> VERIFIED is a legal cycle, and a
    // client can double-submit anything. The ledger is the idempotency key.
    it('does nothing when this issue has already paid', async () => {
      ledgerNets(10);

      await service.awardForVerification(issue(VOLUNTEER));

      expect(model.create).not.toHaveBeenCalled();
    });

    it('awards nothing when no one holds the issue', async () => {
      await service.awardForVerification(issue(undefined));

      expect(model.create).not.toHaveBeenCalled();
      expect(model.aggregate).not.toHaveBeenCalled();
    });
  });

  describe('reversing', () => {
    it('writes a negative entry rather than deleting the award', async () => {
      ledgerNets(10);

      await service.reverseForVerification(issue(VOLUNTEER));

      const [entry] = model.create.mock.calls[0];
      expect(entry.amount).toBe(-10);
      expect(entry.reason).toBe(PointsReason.VERIFICATION_REVERSED);
    });

    it('does nothing when there is nothing to claw back', async () => {
      ledgerNets(0);

      await service.reverseForVerification(issue(VOLUNTEER));

      expect(model.create).not.toHaveBeenCalled();
    });

    // The ledger already holds an award (+10) and its reversal (-10): net
    // zero, but from two real rows, not an untouched pair. A further
    // reversal must still no-op.
    it('does nothing when already reversed', async () => {
      ledgerNets(0, 2);

      await service.reverseForVerification(issue(VOLUNTEER));

      expect(model.create).not.toHaveBeenCalled();
    });
  });

  describe('the cache', () => {
    it('recomputes from the whole ledger rather than incrementing', async () => {
      ledgerNets(0);
      model.aggregate
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 30 }]);

      await service.awardForVerification(issue(VOLUNTEER));

      expect(usersService.setPointsCache).toHaveBeenCalledWith(VOLUNTEER, 30);
    });
  });

  describe('concurrency', () => {
    // netFor() and create() are two round trips with no transaction across
    // them: two concurrent calls for the same pair can both read net=0 and
    // both attempt to write. The unique (userId, issueId, sequence) index is
    // the only thing standing between that and a double-pay.
    it("stamps the entry with the pair's existing row count as its sequence", async () => {
      ledgerNets(10, 3);

      await service.reverseForVerification(issue(VOLUNTEER));

      const [entry] = model.create.mock.calls[0];
      expect(entry.sequence).toBe(3);
    });

    it('treats a lost race (duplicate-key error on create) as a no-op', async () => {
      ledgerNets(0);
      model.create.mockRejectedValue(
        new mongoose.mongo.MongoServerError({
          message: 'E11000 duplicate key error',
          code: 11000,
        }),
      );

      await expect(
        service.awardForVerification(issue(VOLUNTEER)),
      ).resolves.toBeUndefined();

      // The loser must not recompute or push a cache update: the winner's
      // write already did that.
      expect(usersService.setPointsCache).not.toHaveBeenCalled();
    });

    it('still throws on a create failure that is not a duplicate key', async () => {
      ledgerNets(0);
      model.create.mockRejectedValue(new Error('connection reset'));

      await expect(
        service.awardForVerification(issue(VOLUNTEER)),
      ).rejects.toThrow('connection reset');
    });
  });

  describe('reading', () => {
    it('returns a balance of zero for an empty ledger', async () => {
      model.aggregate.mockResolvedValue([]);

      await expect(service.balanceFor(VOLUNTEER)).resolves.toBe(0);
    });

    it('lists transactions newest first', async () => {
      const chain = chainOf([{ amount: 10 }]);
      model.find.mockReturnValue(chain);

      await service.transactionsFor(VOLUNTEER, 20);

      expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1 });
      expect(chain.limit).toHaveBeenCalledWith(20);
    });
  });
});
