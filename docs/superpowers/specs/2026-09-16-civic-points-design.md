# Civic Points — Design

**Status:** approved, not yet implemented
**Slice:** C, the last of the original decomposition.
**Revises:** `2026-09-16-ai-proof-verification-design.md` — see §1.

## Goal

Reward the volunteer who fixes something. `civicPointsCached` has existed on
every user since the auth slice, is returned by the API, and has never been
written by anything: every user reads zero forever. This slice makes it mean
what its own comment says it means — the sum of a `point_transactions` ledger.

It also removes the AI's ability to move money, which is the reason §1 exists.

## Non-goals

- **Reputation.** It stays at 100 and untouched. Points are output; reputation
  would be reliability, and nothing currently reads it to gate anything. Writing
  a number no rule consults is decoration — give it meaning when something
  depends on it. Recorded here so the omission is a decision, not an oversight.
- **Points for reporting.** One credit source keeps the arithmetic honest and
  makes farming impossible. Reporting is already rewarded by the issue being
  fixed.
- **Spending, redeeming or transferring points.** A balance, not a currency.
- **Leaderboards.** A read-model question, and a social one.
- **Weighted awards.** Flat, per §3. The ledger records the issue, so amounts
  can change later without a migration.

## 1. Revision: the AI no longer verifies

B2 shipped with `APPROVED` at or above the threshold setting `VERIFIED`
directly. Once `VERIFIED` awards points, that makes a vision model's judgement
into a payout with no human in the loop — a fooled comparison or a successful
prompt injection becomes money.

So `APPROVED` no longer reaches `VERIFIED`. It reaches a new state:

```
RESOLVED ──AI approves──▶ AI_APPROVED ──agency confirms──▶ VERIFIED ──▶ points
    │                          │
    │                          └── agency rejects ──▶ IN_PROGRESS
    └── AI defers / skips / fails ──▶ agency reviews ──▶ VERIFIED
```

`IssueStatus` gains **`AI_APPROVED`**, positioned between `RESOLVED` and
`VERIFIED`. The contracts spec asserts the enum's exact order, so that test
changes with it — deliberately, because the order is the documented arc.

New transitions:

| From | To | Actor | Requires |
|---|---|---|---|
| `RESOLVED` | `AI_APPROVED` | the system, inside `resolve()` | an `APPROVED` assessment |
| `AI_APPROVED` | `VERIFIED` | `AGENCY`/`ADMIN` | — (they are agreeing) |
| `AI_APPROVED` | `IN_PROGRESS` | `AGENCY`/`ADMIN` | a reason |

`AI_APPROVED` is **not** in `AGENCY_TARGETS`, for the same reason `RESOLVED` and
`CLAIMED` are not: only the system puts an issue there. An agency setting it by
hand would be claiming the model said something it did not.

**What the AI becomes.** A triage signal, not an approver. The 0.7 threshold now
decides which queue an issue lands in — "ready to confirm" against "needs real
review" — rather than whether someone gets paid. That is a far weaker claim to
ask a vision model for, and it makes the threshold much less load-bearing.

With the feature off, `RESOLVED → VERIFIED` remains direct. Nothing changes for
an agency working without it.

## 2. The ledger

A new collection, `point_transactions`. Append-only: nothing is ever updated or
deleted.

| Field | Type | Notes |
|---|---|---|
| `userId` | `ObjectId` ref `User`, indexed | Whose points these are. |
| `issueId` | `ObjectId` ref `Issue`, indexed | What caused it. |
| `amount` | `number` | `+10` for an award, `-10` for a reversal. |
| `reason` | `PointsReason` | `RESOLUTION_VERIFIED` or `VERIFICATION_REVERSED`. |
| `createdAt` | `Date` | From `timestamps`. |

Index: `{ userId: 1, issueId: 1 }`, serving both the balance and the idempotency
check below.

A reversal is a **new negative entry**, never a deletion. The history then shows
both the award and its undoing, which is what a volunteer needs when their
balance drops — and what an auditor needs when asking how often the model was
wrong.

## 3. The award

```ts
export const POINTS_PER_VERIFIED_RESOLUTION = 10;
```

Flat, for every issue. Nothing to tune, nothing to dispute, and no incentive to
cherry-pick categories.

## 4. The cache

`civicPointsCached` becomes what its comment always claimed: **recomputed** from
the ledger after every write, not incremented.

```
civicPointsCached = sum(amount) for this user
```

A single `$group` on an indexed field. Recomputing rather than incrementing
means the cache cannot drift: an increment that fires twice would corrupt the
balance permanently and silently, and nothing would ever notice.

## 5. Idempotency

`VERIFIED → IN_PROGRESS → RESOLVED → VERIFIED` is a legal cycle, so an issue can
be verified more than once, and a client can double-submit anything.

Both operations are therefore guarded by what the ledger already says for that
`(userId, issueId)` pair:

- **Award** only if the net for that pair is zero.
- **Reverse** only if the net is positive.

No locks, no distributed coordination — the ledger is the state, and a duplicate
call becomes a no-op. A second verification after a genuine reversal correctly
awards again, because the net returned to zero.

## 6. Where it fires

`CivicPointsService` owns the ledger and the cache. `IssueLifecycleService`
calls it, in the two places that already exist:

- **On entering `VERIFIED`** — award to `volunteerId`. This covers both the
  agency confirming an `AI_APPROVED` issue and an agency verifying a `RESOLVED`
  one, because both converge on the same assignment.
- **On `VERIFIED → IN_PROGRESS`** — reverse.

`status` is still assigned in exactly one file. The points service never touches
an issue.

An issue with no `volunteerId` — verified without ever being claimed, which the
transition table does not currently allow but might one day — awards nothing
rather than throwing. There is no one to pay.

## 7. API

| Route | Access | Returns |
|---|---|---|
| `GET /users/me/points` | any authenticated user | `{ balance, transactions[] }`, newest first, limited |

`PublicUser` already exposes `civicPointsCached`, so balances appear wherever
users do — correct at last.

No admin route for adjusting points. An adjustment mechanism is a way to make
the ledger disagree with itself, and nothing needs one yet.

## 8. Error contract

| Condition | Status |
|---|---|
| Unauthenticated on `/users/me/points` | 401 |

Nothing else is new. Awarding and reversing are consequences of a status change,
not things a client requests, so they have no failure modes a caller sees.

A failure inside the points service must not roll back a verification: the
status change is the decision, and the ledger catches up. A failure is logged
and the cache recomputes on the next write.

## 9. Testing

Unit:

- Award writes one entry of `+10` with the right reason, user and issue.
- Reversal writes a second entry of `-10`; the first is untouched.
- Awarding twice for the same issue writes one entry.
- Reversing twice writes one reversal.
- Award, reverse, award again writes three entries and a balance of `+10`.
- The cache equals the hand-summed ledger after each.
- An issue with no volunteer awards nothing and does not throw.
- `resolve()` sets `AI_APPROVED`, never `VERIFIED`, on an `APPROVED` assessment.
- `AI_APPROVED → VERIFIED` needs no reason; `AI_APPROVED → IN_PROGRESS` does.

e2e:

- The full arc to `VERIFIED` leaves a balance of 10 and one ledger row.
- A reversal returns the balance to 0 and leaves **two** rows, not zero.
- `GET /users/me/points` shows both.
- With the AI off, `RESOLVED → VERIFIED` still awards — the path an agency uses
  today is unchanged.

## 10. Risks

| Risk | Mitigation |
|---|---|
| A wrong auto-approval pays someone | Removed as a category: the AI cannot reach `VERIFIED`. A human confirms every payout. |
| The cache drifts from the ledger | It is recomputed, never incremented, so drift is not expressible. |
| Double awards from retries or a verify cycle | The ledger is the idempotency key; a duplicate is a no-op. |
| Two accounts owned by one person | Anti-self-dealing stops the obvious case and nothing here can stop the determined one. Unchanged from B1, and worth revisiting only with real usage. |
| `AI_APPROVED` becomes a queue nobody drains | Visible in any status listing and filterable. A demo-scale problem, not an architectural one. |
| Points make weak proof worth submitting | Now costs a human confirmation to succeed, which is the point of §1. |

## Definition of Done

- A verified resolution awards 10 points to the volunteer, and
  `civicPointsCached` reflects it.
- An AI approval reaches `AI_APPROVED` and awards nothing until an agency
  confirms.
- Reversing a verification writes a negative entry; the balance returns and both
  rows remain.
- Awarding or reversing twice changes nothing the second time.
- `GET /users/me/points` returns a balance and its transactions.
- Reputation is still 100 everywhere, untouched.
- `npm run test`, `npm run test:e2e` and `npm run lint` all pass.
