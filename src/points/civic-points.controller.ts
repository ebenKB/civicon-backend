import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.js';
import { CivicPointsService } from './civic-points.service.js';
import { PublicPointsBalance, toPublicTransaction } from './points-response.js';

const RECENT_TRANSACTIONS = 20;

@Controller('users/me/points')
export class CivicPointsController {
  constructor(private readonly civicPointsService: CivicPointsService) {}

  /**
   * The caller's own balance. No :id variant — a route that lets one user read
   * another's ledger is a different decision, and nothing needs it.
   */
  @Get()
  async myPoints(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PublicPointsBalance> {
    const [balance, transactions] = await Promise.all([
      this.civicPointsService.balanceFor(user.id),
      this.civicPointsService.transactionsFor(user.id, RECENT_TRANSACTIONS),
    ]);

    return { balance, transactions: transactions.map(toPublicTransaction) };
  }
}
