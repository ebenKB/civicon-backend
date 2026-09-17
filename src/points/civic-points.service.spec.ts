import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
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

  /** What the ledger currently nets for this (user, issue) pair. */
  const ledgerNets = (total: number) =>
    model.aggregate.mockResolvedValue(total === 0 ? [] : [{ total }]);

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

    it('does nothing when already reversed', async () => {
      ledgerNets(0);

      await service.reverseForVerification(issue(VOLUNTEER));
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
