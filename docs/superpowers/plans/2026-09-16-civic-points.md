# Civic Points Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Award a volunteer 10 civic points when their work is verified, back it with an append-only ledger, and stop the AI being able to award anything on its own.

**Architecture:** A `point_transactions` collection is the source of truth; `civicPointsCached` is recomputed from it after every write, never incremented, so it cannot drift. `CivicPointsService` owns both. `IssueLifecycleService` calls it on entering `VERIFIED` and on reversing out of it. An `APPROVED` assessment now reaches a new `AI_APPROVED` state instead of `VERIFIED`, so every payout has a human behind it.

**Tech Stack:** NestJS 12 (ESM), Mongoose 9, Vitest, MongoDB 8.

**Spec:** `docs/superpowers/specs/2026-09-16-civic-points-design.md`

## Global Constraints

- **ESM codebase.** Every relative import carries a `.js` extension.
- **`import type` for any type in a decorated signature** and for mongoose's `Connection`. A value used at runtime (`Object.values(SomeEnum)`) must stay a value import — a `@Prop` needing both takes two import lines.
- **`@Prop` on an enum property needs an explicit `type: String`.**
- **Mongoose 9 exports `QueryFilter`, not `FilterQuery`.**
- **`status` may be assigned only in `issue-lifecycle.service.ts`.** `CivicPointsService` never touches an issue.
- **The ledger is append-only.** Nothing updates or deletes a transaction, ever. A reversal is a new negative row.
- **`civicPointsCached` is recomputed, never incremented.**
- **This plan revises shipped behaviour.** Tests, README and the Postman collection currently say the AI verifies. Changing them is part of the work, not collateral damage — a test that asserts the old behaviour is now wrong, not failing.
- **No new dependencies.**
- Run `npm run format` and `npm run lint` before each commit.

---

### Task 1: The AI_APPROVED state

Removes the AI's ability to reach `VERIFIED`. Do this first: every later task assumes a payout has a human behind it.

**Files:**
- Modify: `src/contracts/issue-status.ts`
- Modify: `src/contracts/issue-status.spec.ts`
- Modify: `src/issues/issue-lifecycle.service.ts`
- Modify: `src/issues/issue-lifecycle.service.spec.ts`

**Interfaces:**
- Consumes: `AiOutcome` (B2).
- Produces: `IssueStatus.AI_APPROVED`; transitions `RESOLVED → AI_APPROVED`, `AI_APPROVED → VERIFIED`, `AI_APPROVED → IN_PROGRESS`.

- [ ] **Step 1: Update the enum and its order test**

In `src/contracts/issue-status.ts`, insert between `RESOLVED` and `VERIFIED`:

```ts
  /**
   * The AI judged the work done, and nothing else has. Awards nothing: an
   * agency confirms before any points move. Only the system puts an issue
   * here — see AGENCY_TARGETS.
   */
  AI_APPROVED = 'AI_APPROVED',
```

In `src/contracts/issue-status.spec.ts`, add `'AI_APPROVED'` to the expected
array in the same position. The order is the documented arc, so it changes with
the arc.

- [ ] **Step 2: Write the failing lifecycle test**

In `src/issues/issue-lifecycle.service.spec.ts`, change the auto-approval test
to expect the new state, and add the confirmation pair:

```ts
    it('parks an AI approval in AI_APPROVED rather than verifying it', async () => {
      issuesService.findOne.mockResolvedValue(inProgress());
      verificationService.assess.mockResolvedValue({
        outcome: AiOutcome.APPROVED,
        confidence: 0.9,
        assessedAt: new Date(),
      });

      const result = await service.resolve(ISSUE_ID, VOLUNTEER, { note: 'x' });

      // The model may recommend. It may not pay.
      expect(result.status).toBe(IssueStatus.AI_APPROVED);
      expect(result.verifiedAt).toBeUndefined();
    });
```

and, in the agency verdict block:

```ts
    it('confirms an AI approval without needing a reason', async () => {
      issuesService.findOne.mockResolvedValue({
        ...resolved(),
        status: IssueStatus.AI_APPROVED,
      });

      const result = await service.changeStatus(ISSUE_ID, {
        status: IssueStatus.VERIFIED,
      });

      expect(result.status).toBe(IssueStatus.VERIFIED);
      expect(result.verifiedAt).toBeInstanceOf(Date);
    });

    it('rejects an AI approval back to IN_PROGRESS, with a reason', async () => {
      issuesService.findOne.mockResolvedValue({
        ...resolved(),
        status: IssueStatus.AI_APPROVED,
      });

      const result = await service.changeStatus(ISSUE_ID, {
        status: IssueStatus.IN_PROGRESS,
        reason: 'The model was fooled; the grate is still blocked',
      });

      expect(result.status).toBe(IssueStatus.IN_PROGRESS);
    });

    it('refuses an agency setting AI_APPROVED by hand', async () => {
      issuesService.findOne.mockResolvedValue(resolved());

      // Claiming the model said something it did not.
      await expect(
        service.changeStatus(ISSUE_ID, { status: IssueStatus.AI_APPROVED }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/issues/issue-lifecycle.service.spec.ts`
Expected: FAIL — `resolve()` still sets `VERIFIED`.

- [ ] **Step 4: Implement**

In the transition map, add `AI_APPROVED` as a target of `RESOLVED` and give it
its own row:

```ts
    [
      IssueStatus.RESOLVED,
      [
        IssueStatus.VERIFIED,
        IssueStatus.IN_PROGRESS,
        IssueStatus.AI_APPROVED,
      ],
    ],
    [
      IssueStatus.AI_APPROVED,
      [IssueStatus.VERIFIED, IssueStatus.IN_PROGRESS],
    ],
```

In `resolve()`, change the approval branch:

```ts
      if (assessment.outcome === AiOutcome.APPROVED) {
        // The model recommends; it does not pay. An agency confirms before
        // anything reaches VERIFIED, which is where points are awarded.
        issue.status = IssueStatus.AI_APPROVED;
      }
```

Leave `AI_APPROVED` out of `AGENCY_TARGETS`. It is already absent, so an agency
setting it gets the existing 403 — add nothing.

- [ ] **Step 5: Run the full unit suite**

Run: `npm run test`
Expected: PASS. Any other failure is a test asserting the old behaviour — read
it and update it deliberately rather than making it pass.

- [ ] **Step 6: Commit**

```bash
npm run format && npm run lint
git add src/contracts src/issues
git commit -m "Park AI approvals in AI_APPROVED instead of verifying them"
```

---

### Task 2: The ledger

**Files:**
- Create: `src/points/schemas/point-transaction.schema.ts`
- Create: `src/points/schemas/point-transaction.schema.spec.ts`
- Create: `src/contracts/points.ts`
- Modify: `src/contracts/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PointsReason` enum; `POINTS_PER_VERIFIED_RESOLUTION`; `PointTransaction`, `PointTransactionDocument`, `PointTransactionSchema`.

- [ ] **Step 1: Write the contract**

Create `src/contracts/points.ts`:

```ts
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
```

Append `export * from './points.js';` to `src/contracts/index.ts`.

- [ ] **Step 2: Write the failing schema test**

Create `src/points/schemas/point-transaction.schema.spec.ts`:

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/points/schemas/point-transaction.schema.spec.ts`
Expected: FAIL — cannot resolve `./point-transaction.schema.js`.

- [ ] **Step 4: Write the schema**

Create `src/points/schemas/point-transaction.schema.ts`:

```ts
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

  createdAt: Date;
  updatedAt: Date;
}

export const PointTransactionSchema =
  SchemaFactory.createForClass(PointTransaction);

// Serves both the balance and the idempotency check.
PointTransactionSchema.index({ userId: 1, issueId: 1 });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/points/schemas/point-transaction.schema.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
npm run format && npm run lint
git add src/contracts src/points
git commit -m "Add the point transaction ledger schema"
```

---

### Task 3: CivicPointsService

**Files:**
- Create: `src/points/civic-points.service.ts`
- Create: `src/points/civic-points.service.spec.ts`
- Create: `src/points/points.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `PointTransaction` (Task 2); `UsersService` — extended below.
- Produces: `CivicPointsService.awardForVerification(issue)`, `.reverseForVerification(issue)`, `.balanceFor(userId)`, `.transactionsFor(userId, limit)`; `PointsModule` exporting the service.

- [ ] **Step 1: Write the failing test**

Create `src/points/civic-points.service.spec.ts`:

```ts
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
      model.aggregate.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { total: 30 },
      ]);

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/points/civic-points.service.spec.ts`
Expected: FAIL — cannot resolve `./civic-points.service.js`.

- [ ] **Step 3: Give UsersService a cache setter**

`CivicPointsService` must not write the user document directly — `UsersService`
owns that. In `src/users/users.service.ts`:

```ts
  /**
   * Written only by CivicPointsService, from a recomputed ledger sum. Not a
   * general-purpose setter: nothing else should ever set a balance.
   */
  async setPointsCache(userId: string, total: number): Promise<void> {
    await this.userModel
      .updateOne({ _id: userId }, { $set: { civicPointsCached: total } })
      .exec();
  }
```

In `src/users/users.service.spec.ts`, add `updateOne: vi.fn()` to the model
double and:

```ts
  it('sets the points cache to an absolute value, never an increment', async () => {
    model.updateOne.mockReturnValue(execOf({}));

    await service.setPointsCache('507f1f77bcf86cd799439011', 30);

    const [, update] = model.updateOne.mock.calls[0];
    expect(update).toEqual({ $set: { civicPointsCached: 30 } });
  });
```

- [ ] **Step 4: Write the service**

Create `src/points/civic-points.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
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
    // must not pay twice.
    if ((await this.netFor(userId, issue._id.toString())) !== 0) {
      return;
    }

    await this.record(
      userId,
      issue._id.toString(),
      POINTS_PER_VERIFIED_RESOLUTION,
      PointsReason.RESOLUTION_VERIFIED,
    );
  }

  async reverseForVerification(issue: IssueDocument): Promise<void> {
    const userId = issue.volunteerId?.toString();
    if (!userId) {
      return;
    }

    const net = await this.netFor(userId, issue._id.toString());
    if (net <= 0) {
      // Nothing was paid, or it has already been clawed back.
      return;
    }

    await this.record(
      userId,
      issue._id.toString(),
      -net,
      PointsReason.VERIFICATION_REVERSED,
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
  ): Promise<void> {
    await this.transactionModel.create({
      userId: new Types.ObjectId(userId),
      issueId: new Types.ObjectId(issueId),
      amount,
      reason,
    });

    // Recomputed, never incremented: an increment that fires twice would
    // corrupt the balance permanently and silently.
    await this.usersService.setPointsCache(
      userId,
      await this.balanceFor(userId),
    );
  }

  private async netFor(userId: string, issueId: string): Promise<number> {
    const [result] = await this.transactionModel.aggregate<{ total: number }>([
      {
        $match: {
          userId: new Types.ObjectId(userId),
          issueId: new Types.ObjectId(issueId),
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    return result?.total ?? 0;
  }
}
```

- [ ] **Step 5: Write the module**

Create `src/points/points.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UsersModule } from '../users/users.module.js';
import { CivicPointsService } from './civic-points.service.js';
import {
  PointTransaction,
  PointTransactionSchema,
} from './schemas/point-transaction.schema.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PointTransaction.name, schema: PointTransactionSchema },
    ]),
    UsersModule,
  ],
  providers: [CivicPointsService],
  exports: [CivicPointsService],
})
export class PointsModule {}
```

Register `PointsModule` in `src/app.module.ts`, after `IssuesModule`.

- [ ] **Step 6: Run the tests**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npm run format && npm run lint
git add src/points src/users src/app.module.ts
git commit -m "Add CivicPointsService over an append-only ledger"
```

---

### Task 4: Awarding on verification

**Files:**
- Modify: `src/issues/issue-lifecycle.service.ts`
- Modify: `src/issues/issue-lifecycle.service.spec.ts`
- Modify: `src/issues/issues.module.ts`

**Interfaces:**
- Consumes: `CivicPointsService` (Task 3).
- Produces: an award on entering `VERIFIED`; a reversal on leaving it.

- [ ] **Step 1: Write the failing test**

Add `{ provide: CivicPointsService, useValue: pointsService }` to the lifecycle
spec's providers, with
`pointsService = { awardForVerification: vi.fn(), reverseForVerification: vi.fn() };`
in `beforeEach`, then:

```ts
  describe('points', () => {
    const VOLUNTEER = '507f1f77bcf86cd799439044';

    const at = (status: IssueStatus) => ({
      status,
      reportedBy: new Types.ObjectId('507f1f77bcf86cd799439011'),
      volunteerId: new Types.ObjectId(VOLUNTEER),
      save: vi.fn().mockImplementation(function (this: unknown) {
        return Promise.resolve(this);
      }),
    });

    it('awards when an agency verifies a resolved issue', async () => {
      issuesService.findOne.mockResolvedValue(at(IssueStatus.RESOLVED));

      await service.changeStatus(ISSUE_ID, { status: IssueStatus.VERIFIED });

      expect(pointsService.awardForVerification).toHaveBeenCalled();
    });

    it('awards when an agency confirms an AI approval', async () => {
      issuesService.findOne.mockResolvedValue(at(IssueStatus.AI_APPROVED));

      await service.changeStatus(ISSUE_ID, { status: IssueStatus.VERIFIED });

      expect(pointsService.awardForVerification).toHaveBeenCalled();
    });

    it('awards nothing when the AI parks an issue in AI_APPROVED', async () => {
      issuesService.findOne.mockResolvedValue(at(IssueStatus.IN_PROGRESS));
      verificationService.assess.mockResolvedValue({
        outcome: AiOutcome.APPROVED,
        confidence: 0.9,
        assessedAt: new Date(),
      });

      await service.resolve(ISSUE_ID, VOLUNTEER, { note: 'x' });

      expect(pointsService.awardForVerification).not.toHaveBeenCalled();
    });

    it('reverses when a verification is undone', async () => {
      issuesService.findOne.mockResolvedValue(at(IssueStatus.VERIFIED));

      await service.changeStatus(ISSUE_ID, {
        status: IssueStatus.IN_PROGRESS,
        reason: 'wrong',
      });

      expect(pointsService.reverseForVerification).toHaveBeenCalled();
    });

    it('does not reverse when sending back work that was never verified', async () => {
      issuesService.findOne.mockResolvedValue(at(IssueStatus.RESOLVED));

      await service.changeStatus(ISSUE_ID, {
        status: IssueStatus.IN_PROGRESS,
        reason: 'more work needed',
      });

      expect(pointsService.reverseForVerification).not.toHaveBeenCalled();
    });

    it('still changes the status when the points service throws', async () => {
      issuesService.findOne.mockResolvedValue(at(IssueStatus.RESOLVED));
      pointsService.awardForVerification.mockRejectedValue(new Error('down'));

      const result = await service.changeStatus(ISSUE_ID, {
        status: IssueStatus.VERIFIED,
      });

      // The status change is the decision; the ledger catches up.
      expect(result.status).toBe(IssueStatus.VERIFIED);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/issues/issue-lifecycle.service.spec.ts`
Expected: FAIL — the provider is unknown.

- [ ] **Step 3: Implement**

Inject `CivicPointsService`.

In `changeStatus`, capture the prior status **immediately after
`const issue = await this.issuesService.findOne(id);`**, before anything
reassigns it:

```ts
    // Captured before the reassignment below: by the time points are settled,
    // issue.status is already the new value.
    const wasVerified = issue.status === IssueStatus.VERIFIED;
```

Then **replace the method's final two lines** — currently:

```ts
    issue.status = dto.status;
    issue.statusReason = dto.reason;
    return issue.save();
```

with:

```ts
    issue.status = dto.status;
    issue.statusReason = dto.reason;
    const saved = await issue.save();

    // Points follow the status, and never block it: a ledger failure must not
    // undo a decision an agency has already made.
    if (dto.status === IssueStatus.VERIFIED) {
      await this.settlePoints(() =>
        this.civicPointsService.awardForVerification(saved),
      );
    }

    if (dto.status === IssueStatus.IN_PROGRESS && wasVerified) {
      await this.settlePoints(() =>
        this.civicPointsService.reverseForVerification(saved),
      );
    }

    return saved;
```

Note the early `return this.returnToOpen(issue)` branch above is untouched: a
force-release never awards or reverses, because the issue was not verified.

And add the helper:

```ts
  private async settlePoints(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.logger.error(
        `Points settlement failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
```

Add a `Logger` to the class. Note `resolve()` needs no change: the AI reaches
`AI_APPROVED`, which pays nothing.

In `src/issues/issues.module.ts`, import `PointsModule`.

- [ ] **Step 4: Run the tests and check for a cycle**

Run: `npm run test` — expected PASS. Then:

```bash
npm run build && node dist/main.js
```

Expected: boots cleanly. `PointsModule` imports `UsersModule`, and
`IssuesModule` imports `PointsModule` — a chain, not a cycle. If Nest reports a
circular dependency, re-read which module actually needs which before reaching
for `forwardRef`.

- [ ] **Step 5: Commit**

```bash
npm run format && npm run lint
git add src/issues
git commit -m "Award points on verification and reverse them on undo"
```

---

### Task 5: The balance endpoint

**Files:**
- Create: `src/points/civic-points.controller.ts`
- Create: `src/points/civic-points.controller.spec.ts`
- Create: `src/points/points-response.ts`
- Modify: `src/points/points.module.ts`

**Interfaces:**
- Consumes: `CivicPointsService` (Task 3); `@CurrentUser()`.
- Produces: `GET /users/me/points`.

- [ ] **Step 1: Write the response shaper**

Create `src/points/points-response.ts`:

```ts
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
```

- [ ] **Step 2: Write the failing controller test**

Create `src/points/civic-points.controller.spec.ts`:

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/points/civic-points.controller.spec.ts`
Expected: FAIL — cannot resolve `./civic-points.controller.js`.

- [ ] **Step 4: Write the controller**

Create `src/points/civic-points.controller.ts`:

```ts
import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.js';
import { CivicPointsService } from './civic-points.service.js';
import {
  PublicPointsBalance,
  toPublicTransaction,
} from './points-response.js';

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
```

Add it to `PointsModule`'s `controllers`.

- [ ] **Step 5: Run the tests**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run format && npm run lint
git add src/points
git commit -m "Add the caller points balance endpoint"
```

---

### Task 6: End-to-end

**Files:**
- Create: `test/civic-points.e2e-spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the suite**

Create `test/civic-points.e2e-spec.ts`. It runs with the AI off, so the path is
the one an agency uses today:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Connection } from 'mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import {
  IssueCategory,
  IssueStatus,
  PointsReason,
  Role,
} from './../src/contracts/index.js';

const PASSWORD = 'super-secret';
const PIXEL = readFileSync(join(import.meta.dirname, 'fixtures/pixel.png'));

describe('Civic points (e2e)', () => {
  let app: INestApplication<App>;
  let connection: Connection;
  let reporterToken: string;
  let volunteerToken: string;
  let agencyToken: string;
  let issueId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const login = async (email: string): Promise<string> => {
    const { body } = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return body.token;
  };

  const points = () =>
    request(app.getHttpServer())
      .get('/users/me/points')
      .set(auth(volunteerToken));

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    connection = moduleFixture.get<Connection>(getConnectionToken());
    if (!connection.name.includes('_test')) {
      throw new Error(`Refusing to run against "${connection.name}".`);
    }

    await connection.collection('users').deleteMany({});
    for (const email of ['r@x.test', 'v@x.test', 'a@x.test']) {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ name: 'T', email, password: PASSWORD })
        .expect(201);
    }
    await connection
      .collection('users')
      .updateOne({ email: 'a@x.test' }, { $set: { roles: [Role.AGENCY] } });

    reporterToken = await login('r@x.test');
    volunteerToken = await login('v@x.test');
    agencyToken = await login('a@x.test');
  });

  beforeEach(async () => {
    await connection.collection('issues').deleteMany({});
    await connection.collection('point_transactions').deleteMany({});
    await connection.collection('issue_media.files').deleteMany({});
    await connection.collection('issue_media.chunks').deleteMany({});

    const { body } = await request(app.getHttpServer())
      .post('/issues')
      .set(auth(reporterToken))
      .send({
        title: 'Blocked drain',
        description: 'Standing water.',
        category: IssueCategory.DRAINAGE,
        location: 'Market Street',
      })
      .expect(201);
    issueId = body.id;

    await request(app.getHttpServer())
      .post(`/issues/${issueId}/claim`)
      .set(auth(volunteerToken))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/issues/${issueId}/media`)
      .set(auth(volunteerToken))
      .attach('file', PIXEL, { filename: 'a.png', contentType: 'image/png' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/issues/${issueId}/resolution`)
      .set(auth(volunteerToken))
      .send({ note: 'Cleared it' })
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
  });

  const verify = () =>
    request(app.getHttpServer())
      .patch(`/issues/${issueId}/status`)
      .set(auth(agencyToken))
      .send({ status: IssueStatus.VERIFIED })
      .expect(200);

  const reverse = () =>
    request(app.getHttpServer())
      .patch(`/issues/${issueId}/status`)
      .set(auth(agencyToken))
      .send({ status: IssueStatus.IN_PROGRESS, reason: 'Still blocked' })
      .expect(200);

  it('starts at zero', async () => {
    const res = await points().expect(200);

    expect(res.body.balance).toBe(0);
    expect(res.body.transactions).toHaveLength(0);
  });

  it('awards ten on verification, and reflects it on the user', async () => {
    await verify();

    const res = await points().expect(200);
    expect(res.body.balance).toBe(10);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0].reason).toBe(
      PointsReason.RESOLUTION_VERIFIED,
    );

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set(auth(volunteerToken))
      .expect(200);
    expect(me.body.civicPointsCached).toBe(10);
  });

  // The record of an award and its undoing is what a volunteer needs when
  // their balance drops.
  it('reverses to zero, leaving two rows rather than erasing one', async () => {
    await verify();
    await reverse();

    const res = await points().expect(200);
    expect(res.body.balance).toBe(0);
    expect(res.body.transactions).toHaveLength(2);
    expect(res.body.transactions.map((t: { amount: number }) => t.amount).sort())
      .toEqual([-10, 10]);
  });

  it('pays once for a verify cycle', async () => {
    await verify();
    await reverse();

    await request(app.getHttpServer())
      .post(`/issues/${issueId}/resolution`)
      .set(auth(volunteerToken))
      .send({ note: 'Fixed properly this time' })
      .expect(200);
    await verify();

    const res = await points().expect(200);
    expect(res.body.balance).toBe(10);
    expect(res.body.transactions).toHaveLength(3);
  });

  it('leaves reputation alone', async () => {
    await verify();

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set(auth(volunteerToken))
      .expect(200);

    expect(me.body.reputation).toBe(100);
  });

  it('refuses an anonymous balance request', async () => {
    await request(app.getHttpServer()).get('/users/me/points').expect(401);
  });
});
```

- [ ] **Step 2: Run everything**

```bash
docker compose up -d
npm run test && npm run test:e2e
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
npm run format && npm run lint
git add test/civic-points.e2e-spec.ts
git commit -m "Add civic points e2e coverage"
```

---

### Task 7: Documentation and the collection

**Files:**
- Modify: `README.md`
- Modify: `postman/civicon-auth.postman_collection.json`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Correct the AI documentation**

The README currently says an approval verifies automatically. In the
`### AI proof verification` section, replace the outcome table and the sentences
around it:

````markdown
| Confidence | Result |
|---|---|
| `fixed` and at or above 0.7 | `AI_APPROVED` — an agency confirms before anything is awarded |
| anything else | stays `RESOLVED`, with the model's reasoning attached |

**The model recommends; it does not pay.** An approval parks the issue in
`AI_APPROVED`, where it awards nothing until an agency moves it to `VERIFIED`.
The threshold decides which queue an issue lands in — "ready to confirm" against
"needs real review" — not whether someone is paid.
````

- [ ] **Step 2: Document points**

After `### AI proof verification`, add:

````markdown
### Civic points

A verified resolution awards the volunteer **10 points**.

| Route | Access |
|---|---|
| `GET /users/me/points` | any authenticated user — balance and recent transactions |

Points are backed by an append-only `point_transactions` ledger.
`civicPointsCached` on the user is **recomputed** from that ledger after every
write, never incremented, so the cache cannot drift from the truth.

A reversal writes a **negative entry**; the award is never deleted. After
verifying and reversing, a volunteer sees two rows and a balance of zero — which
is what makes a dropped balance explicable.

Awarding is idempotent against the ledger, so the legal
`VERIFIED → IN_PROGRESS → RESOLVED → VERIFIED` cycle pays once per verification
rather than once per attempt.

`reputation` is deliberately untouched — points measure output, and nothing yet
reads reputation to gate anything.
````

- [ ] **Step 3: Add a Postman folder**

Add `Civic points`, after `Issue lifecycle`, running against a seeded database:

1. **Sign in as the volunteer** — store `volunteer_token`. Test: 200.
2. **My balance** — `GET {{base_url}}/users/me/points`, bearer
   `{{volunteer_token}}`. Test: 200, `balance` is a number, `transactions` is an
   array.
3. **A balance needs a token** — same route, noauth. Test: 401.

Keep it to reads: awarding requires an agency to verify a resolution the
collection cannot complete unattended, because attaching proof needs a file
selected in the UI.

- [ ] **Step 4: Full verification**

```bash
npm run format && npm run lint
npm run build
npm run test
npm run test:e2e
npm run seed -- --fresh
postman collection run postman/civicon-auth.postman_collection.json \
  -e postman/civicon-local.postman_environment.json
```

Expected: all clean, all passing, 0 failed assertions.

- [ ] **Step 5: Commit**

```bash
git add README.md postman
git commit -m "Document civic points and correct the AI approval docs"
```
