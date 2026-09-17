import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { PointsReason } from '../../contracts/index.js';

export type PointTransactionDocument = HydratedDocument<PointTransaction>;

/**
 * Append-only. Nothing updates or deletes a row: a reversal is a new negative
 * entry, so the history shows both the award and its undoing. That is what a
 * volunteer needs when their balance drops, and what an auditor needs when
 * asking how often the model was wrong.
 */
@Schema({
  timestamps: true,
  collection: 'point_transactions',
  toJSON: {
    virtuals: true,
    versionKey: false,
    transform: (_doc, ret: Record<string, unknown>) => {
      ret.id = ret._id;
      delete ret._id;
      return ret;
    },
  },
})
export class PointTransaction {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  })
  userId: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Issue',
    required: true,
    index: true,
  })
  issueId: Types.ObjectId;

  /** Positive for an award, negative for a reversal. */
  @Prop({ required: true })
  amount: number;

  @Prop({ type: String, required: true, enum: Object.values(PointsReason) })
  reason: PointsReason;

  /**
   * This row's zero-based position within its (userId, issueId) pair's
   * history. Set from the same read that computes the pair's net, so two
   * concurrent writers racing to record the same event compute the same
   * sequence and collide.
   */
  @Prop({ required: true })
  sequence: number;

  createdAt: Date;
  updatedAt: Date;
}

export const PointTransactionSchema =
  SchemaFactory.createForClass(PointTransaction);

// The idempotency guard: a unique index, not just an application-level
// check-then-act. Two concurrent writers computing the same sequence for the
// same pair can both attempt to insert, but only one insert can succeed —
// the loser's duplicate-key error is caught and treated as a no-op. A plain
// (userId, issueId) unique index would be wrong here: a legal
// verify -> reverse -> verify cycle legitimately writes more than one row for
// the same pair.
PointTransactionSchema.index(
  { userId: 1, issueId: 1, sequence: 1 },
  { unique: true },
);
