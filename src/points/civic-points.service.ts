import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model, Types } from 'mongoose';
import {
  POINTS_PER_VERIFIED_RESOLUTION,
  PointsReason,
} from '../contracts/index.js';
import type { IssueDocument } from '../issues/schemas/issue.schema.js';
import { UsersService } from '../users/users.service.js';
import {
  PointTransaction,
  PointTransactionDocument,
} from './schemas/point-transaction.schema.js';

const DUPLICATE_KEY = 11000;

/**
 * Owns the ledger and the cache. Never touches an issue: the lifecycle service
 * decides what happened, this decides what it is worth.
 */
@Injectable()
export class CivicPointsService {
  private readonly logger = new Logger(CivicPointsService.name);

  constructor(
    @InjectModel(PointTransaction.name)
    private readonly transactionModel: Model<PointTransactionDocument>,
    private readonly usersService: UsersService,
  ) {}

  async awardForVerification(issue: IssueDocument): Promise<void> {
    const userId = issue.volunteerId?.toString();
    if (!userId) {
      // Verified without ever being claimed. There is no one to pay.
      return;
    }

    // The ledger is the idempotency key: a verify cycle or a double submit
    // must not pay twice. The unique (userId, issueId, sequence) index below
    // is what makes this hold under concurrency, not just serially.
    const { total, count } = await this.netFor(userId, issue._id.toString());
    if (total !== 0) {
      return;
    }

    await this.record(
      userId,
      issue._id.toString(),
      POINTS_PER_VERIFIED_RESOLUTION,
      PointsReason.RESOLUTION_VERIFIED,
      count,
    );
  }

  async reverseForVerification(issue: IssueDocument): Promise<void> {
    const userId = issue.volunteerId?.toString();
    if (!userId) {
      return;
    }

    const { total, count } = await this.netFor(userId, issue._id.toString());
    if (total <= 0) {
      // Nothing was paid, or it has already been clawed back.
      return;
    }

    await this.record(
      userId,
      issue._id.toString(),
      -total,
      PointsReason.VERIFICATION_REVERSED,
      count,
    );
  }

  async balanceFor(userId: string): Promise<number> {
    const [result] = await this.transactionModel.aggregate<{ total: number }>([
      { $match: { userId: new Types.ObjectId(userId) } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    return result?.total ?? 0;
  }

  transactionsFor(
    userId: string,
    limit: number,
  ): Promise<PointTransactionDocument[]> {
    return this.transactionModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
  }

  private async record(
    userId: string,
    issueId: string,
    amount: number,
    reason: PointsReason,
    sequence: number,
  ): Promise<void> {
    try {
      await this.transactionModel.create({
        userId: new Types.ObjectId(userId),
        issueId: new Types.ObjectId(issueId),
        amount,
        reason,
        sequence,
      });
    } catch (error) {
      if (
        error instanceof mongoose.mongo.MongoServerError &&
        error.code === DUPLICATE_KEY
      ) {
        // Lost the race: another writer already recorded this pair's
        // sequence between our read and our write. Treat it as a no-op
        // rather than double-paying or clawing back twice.
        return;
      }
      throw error;
    }

    // Recomputed, never incremented: an increment that fires twice would
    // corrupt the balance permanently and silently.
    await this.usersService.setPointsCache(
      userId,
      await this.balanceFor(userId),
    );
  }

  private async netFor(
    userId: string,
    issueId: string,
  ): Promise<{ total: number; count: number }> {
    const [result] = await this.transactionModel.aggregate<{
      total: number;
      count: number;
    }>([
      {
        $match: {
          userId: new Types.ObjectId(userId),
          issueId: new Types.ObjectId(issueId),
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
    ]);
    return { total: result?.total ?? 0, count: result?.count ?? 0 };
  }
}
