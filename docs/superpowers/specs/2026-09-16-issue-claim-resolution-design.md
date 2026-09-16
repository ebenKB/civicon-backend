# Issue Claim & Resolution — Design

**Status:** approved, not yet implemented
**Slice:** B1 of the claim work. B2 (AI proof verification) has its own spec and builds on this one.
**Follows:** `2026-09-13-issue-reporting-design.md`, `2026-09-14-issue-media-design.md`

## Goal

Let a citizen take on an issue someone else reported, do the work, show evidence,
and have an agency confirm it. This is the half that turns a complaints box into
a civic platform: before it, nothing reported ever gets fixed.

## Non-goals

- **AI verification of the proof.** Slice B2. This slice establishes the
  `REPORT` / `PROOF` distinction that B2 depends on, and an agency verifies by
  hand in the meantime.
- **Civic points and reputation.** Slice C. `VERIFIED` is the event C will hang
  awards on; nothing here writes `civicPointsCached` or `reputation`.
- **Claim expiry.** A claim is released by its holder or forced open by an
  agency — no clocks, no scheduler, no background job.
- **Agency assignment.** Claiming is self-service; the first claimer holds it.
- **Reputation-gated eligibility.** Any citizen who is not the reporter may
  claim. The `RESTRICTED` eligibility the auth spec mentions is a later concern,
  and per that spec should arrive as a per-category credential, not a role.

## Context: what exists today

Reporting and media are complete. Relevant machinery:

- `IssueLifecycleService` is the **single writer of `status`** and holds the
  transition table. It was split out of `IssuesService` precisely so this slice
  could drop in.
- `IssueStatus` already declares `CLAIMED`, `IN_PROGRESS`, `RESOLVED` and
  `VERIFIED` with nothing transitioning into them. This slice makes all four
  reachable and adds no enum members.
- `reportedBy` is on every issue — the field anti-self-dealing compares against.
- `IssueMediaService` stores media in GridFS with `{ issueId, uploadedBy }`
  metadata, capped at 5 files, and currently permits upload only by the reporter
  while the issue is `OPEN`.
- Global default-deny guards, `@CurrentUser()`, `ParseObjectIdPipe`,
  `MongoExceptionFilter`, and a `ValidationPipe` with `forbidNonWhitelisted`.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Claim model | Self-service; first claimer holds it exclusively | Shows the whole arc without an admin in the loop. Agency authority stays where it already is — verifying the result. |
| Abandonment | Holder releases; agency can force-release | Nothing can be stuck forever, and no scheduler is needed. |
| Anti-self-dealing | `reportedBy !== volunteerId`, enforced on claim | Verbatim from the `Role` docstring's reasoning. A reporter approving their own work is the failure this prevents. |
| Proof | A note **and at least one `PROOF` photo** | Evidence is the point. It also gives the media slice a second purpose and gives B2 something to look at. |
| Media kind | `REPORT` / `PROOF` on each file's metadata | Without it there is no way to tell the reporter's "before" photos from the volunteer's "after" photos, and B2's entire premise is comparing them. |
| Verification | `AGENCY`/`ADMIN` verifies or sends back with a reason | Agencies remain the authoritative owners of an issue's state. |
| Route shape | Dedicated action routes, not one overloaded `PATCH /status` | Each action has a different actor and a different payload; a single endpoint would need a union body and lose the 400s that come free from DTO validation. |
| Status writes | Still only `IssueLifecycleService` | The invariant that made this slice cheap. Action routes call it; none writes `status` itself. |

## 1. Schema additions

All additive to `Issue`; no migration is required because every field is
optional until an issue is claimed.

| Field | Type | Notes |
|---|---|---|
| `volunteerId` | `ObjectId` ref `User`, indexed | The current holder. **Cleared on release**, so an unclaimed issue never carries a stale holder. |
| `claimedAt` | `Date` | Set on claim, cleared on release. |
| `resolutionNote` | `string`, max 2000 | What the volunteer says they did. |
| `resolvedAt` | `Date` | |
| `verifiedAt` | `Date` | |

Index: `{ volunteerId: 1 }`, serving "issues I am working on".

## 2. Media: the REPORT / PROOF distinction

`IssueMediaService` gains a `kind` on the metadata it writes:

```ts
{ issueId: ObjectId, uploadedBy: ObjectId, contentType: string, kind: 'REPORT' | 'PROOF' }
```

`kind` is **derived, never supplied by the client** — the same principle that
keeps `reportedBy` and `status` out of request bodies. The rule is positional:

- Uploading while the issue is `OPEN` → `REPORT` (only the reporter can, as today).
- Uploading while `CLAIMED` or `IN_PROGRESS` → `PROOF` (only the holder can).

So `assertMayAttach` gains a second branch rather than a new parameter:

| Issue status | Who may attach | kind |
|---|---|---|
| `OPEN` | the reporter | `REPORT` |
| `CLAIMED`, `IN_PROGRESS` | the holder (`volunteerId`) | `PROOF` |
| anything else | nobody | — |

The 5-file cap stays per issue, counting both kinds together.

### Proof left behind by a previous volunteer

A holder may attach proof, release the claim, and leave it there. Nothing is
deleted on release — a photo someone took of real work is a record, and silently
destroying user content to tidy state is worse than keeping it.

Instead, proof is read by **author**: `metadata.uploadedBy` already identifies
who attached each file, so "this issue's proof" means files with
`kind: 'PROOF'` whose `uploadedBy` is the current `volunteerId`. A new
volunteer's resolution is judged on their own evidence, and B2 compares the
reporter's `REPORT` photos against the current holder's `PROOF` photos only.

The consequence is that abandoned proof still counts against the 5-file cap.
That is recorded as a risk rather than solved: an agency can delete a file, and
a cap reached this way is a signal worth seeing rather than hiding.

**Existing files carry no `kind`.** Anything already stored was uploaded by a
reporter while `OPEN`, so a missing `kind` reads as `REPORT`. `toPublicMedia`
applies that default; no backfill is needed.

## 3. Transitions

Added to the table in `IssueLifecycleService`:

| From | To | Actor | Requires |
|---|---|---|---|
| `OPEN` | `CLAIMED` | any `CITIZEN` except the reporter | — |
| `CLAIMED` | `IN_PROGRESS` | the holder | — |
| `CLAIMED` | `OPEN` | the holder, or `AGENCY`/`ADMIN` | a reason when an agency forces it |
| `IN_PROGRESS` | `OPEN` | the holder, or `AGENCY`/`ADMIN` | a reason when an agency forces it |
| `CLAIMED` | `RESOLVED` | the holder | a note and ≥1 `PROOF` photo |
| `IN_PROGRESS` | `RESOLVED` | the holder | a note and ≥1 `PROOF` photo |
| `RESOLVED` | `VERIFIED` | `AGENCY`/`ADMIN` | — |
| `RESOLVED` | `IN_PROGRESS` | `AGENCY`/`ADMIN` | a reason |

`IN_PROGRESS` is deliberately optional — a volunteer may go straight from
`CLAIMED` to `RESOLVED`. It exists so a holder can signal they have started,
which matters to anyone watching the issue; forcing it would be ceremony.

Releasing clears `volunteerId` and `claimedAt`. A send-back from `RESOLVED`
keeps the holder — the same volunteer is expected to finish the job — and
clears `resolvedAt` and `resolutionNote`.

`REJECTED` and `DUPLICATE` remain reachable only from `OPEN`, as today. An
agency that wants to reject a claimed issue must force-release it first, which
is deliberate: rejecting work someone is actively doing should be two steps.

## 4. API

| Route | Access | Success | Body |
|---|---|---|---|
| `POST /issues/:id/claim` | `@Roles(CITIZEN)`, not the reporter | 200 | — |
| `DELETE /issues/:id/claim` | the holder | 200 | — |
| `POST /issues/:id/start` | the holder | 200 | — |
| `POST /issues/:id/resolution` | the holder | 200 | `{ note }` |
| `PATCH /issues/:id/status` | `@Roles(AGENCY, ADMIN)` | 200 | `{ status, reason?, duplicateOf? }` |

`PATCH /issues/:id/status` is where an agency verifies, sends back, force-releases,
rejects or dedupes — it already exists and already carries a reason. The four
new routes are the volunteer's, and none of them takes a status: the route *is*
the intent, so a client cannot ask for a transition that does not belong to it.

`PublicIssue` gains `volunteerId`, `claimedAt`, `resolutionNote`, `resolvedAt`
and `verifiedAt`, mapped explicitly as the existing fields are.

`GET /issues` gains a `volunteerId` filter, so "what am I working on" is one
query.

## 5. Error contract

| Condition | Status |
|---|---|
| Not authenticated | 401 |
| Wrong role, or not the holder | 403 |
| The reporter claiming their own issue | 403, message naming the rule |
| Unknown issue | 404 |
| Claiming an issue someone else holds | 409 |
| Any illegal transition | 409, naming both states |
| Resolving with no note | 400 (DTO) |
| Resolving with no `PROOF` photo | 400, from the lifecycle service |
| Agency force-release or send-back without a reason | 400 |

The reporter-claims-own-issue case gets its own message rather than a bare 403.
It is the rule most likely to surprise someone, and the design's reason for
existing is worth stating at the point it bites.

## 6. Testing

Unit, no database:

- The expanded transition table: every allowed move, a representative sample of
  refused ones, and each required companion (`reason`, note, proof).
- Anti-self-dealing: the reporter is refused; any other citizen is allowed.
- Release clears `volunteerId` and `claimedAt`; send-back keeps the holder and
  clears `resolvedAt`.
- The media `kind` rule: `OPEN` yields `REPORT`, `CLAIMED`/`IN_PROGRESS` yields
  `PROOF`, and a client-supplied `kind` is ignored.

e2e, against the `_test` database — the full arc as one test, then the refusals:

- Report → claim (by a second citizen) → start → attach proof → resolve →
  agency verifies. Assert the status and the actor at each step.
- The reporter cannot claim their own issue (403).
- A second claimer gets 409.
- A non-holder cannot start, resolve, or release.
- Resolving without a proof photo is 400.
- Release returns the issue to `OPEN`, clears the holder, and lets someone else
  claim it.
- An agency force-release with a reason does the same.
- A send-back from `RESOLVED` returns it to `IN_PROGRESS` with the holder intact.
- Proof photos are `kind: PROOF`; the reporter's are `kind: REPORT`.
- After a release and a re-claim, the new holder's resolution is judged on their
  own proof: a file attached by the previous volunteer does not satisfy the
  "at least one proof photo" requirement.

## 7. Risks

| Risk | Mitigation |
|---|---|
| A verified resolution will later pay civic points, so a wrong `VERIFIED` is a payout | Accepted here: verification is a human agency decision in this slice. It becomes material in B2, where auto-approval enters — which is why that spec keeps an agency reversal path. |
| The 5-file cap is shared between report and proof photos | Deliberate, and documented. A reporter who attaches five photos leaves no room for proof — the cap should be revisited if that happens in practice, not pre-emptively split. |
| Anti-self-dealing compares ids only | It stops the obvious case. Two accounts owned by one person defeats it, and no rule in this slice can prevent that; reputation and points (slice C) are where that is worth addressing. |
| `volunteerId` left stale after a release | Release clears it, and an e2e test asserts the cleared state rather than only the status. |
| Proof from an abandoned claim counts against the 5-file cap | Accepted. Nothing is auto-deleted; an agency can remove a file. Reaching the cap this way is visible rather than silent, and the alternative — destroying someone's photos on release — is worse. |

## Definition of Done

- A citizen other than the reporter can claim, start, resolve with evidence, and
  have an agency verify — end to end.
- The reporter cannot claim their own issue, and a second claimer gets 409.
- Resolving without a proof photo is refused.
- Releasing, by the holder or by an agency, returns the issue to `OPEN` with no
  holder, and it can be claimed again.
- Media uploaded while `OPEN` is `REPORT`; media uploaded by the holder is
  `PROOF`; the client cannot set either.
- A resolution requires proof attached by the **current** holder, so evidence
  left behind by a previous volunteer does not satisfy it.
- `status` is still written in exactly one place.
- `npm run test`, `npm run test:e2e` and `npm run lint` all pass.
