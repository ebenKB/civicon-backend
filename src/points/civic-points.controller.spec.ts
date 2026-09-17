import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { PointsReason } from '../contracts/index.js';
import { CivicPointsController } from './civic-points.controller.js';
import { CivicPointsService } from './civic-points.service.js';

const USER = '507f1f77bcf86cd799439011';
const caller = { id: USER, email: 'c@x.test', roles: [] } as never;

describe('CivicPointsController', () => {
  let controller: CivicPointsController;
  let service: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    service = { balanceFor: vi.fn(), transactionsFor: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CivicPointsController],
      providers: [{ provide: CivicPointsService, useValue: service }],
    }).compile();

    controller = module.get(CivicPointsController);
  });

  it('returns the caller balance and transactions', async () => {
    service.balanceFor.mockResolvedValue(10);
    service.transactionsFor.mockResolvedValue([
      {
        _id: new Types.ObjectId(),
        issueId: new Types.ObjectId(),
        amount: 10,
        reason: PointsReason.RESOLUTION_VERIFIED,
        createdAt: new Date(),
      },
    ]);

    const result = await controller.myPoints(caller);

    expect(result.balance).toBe(10);
    expect(result.transactions).toHaveLength(1);
    expect(typeof result.transactions[0].id).toBe('string');
  });

  it('reads the caller from the token, never from a parameter', async () => {
    service.balanceFor.mockResolvedValue(0);
    service.transactionsFor.mockResolvedValue([]);

    await controller.myPoints(caller);

    expect(service.balanceFor).toHaveBeenCalledWith(USER);
  });
});
