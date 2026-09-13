# Issue Reporting — Design

**Status:** approved, not yet implemented
**Slice:** A of three (A reporting → B claim & resolution → C civic points)

## Goal

Let a citizen report a civic problem, let anyone read the resulting public
record, and let an agency triage what comes in. This is the smallest slice that
makes the platform demonstrate something: before it, a logged-in citizen has
nothing to do.

## Non-goals

Deliberately excluded, each the subject of a later slice:

- **Claiming and resolution** — a citizen taking an issue on, submitting proof,
  an agency verifying it. Slice B. The `IssueStatus` enum defined here already
  names those states; this slice simply implements none of the transitions into
  them.
- **Civic points** — `point_transactions` and the maintenance of
  `civicPointsCached`. Slice C.
- **Photos and other media.** No upload endpoint, no object storage, not even a
  URL field. Adding one later is additive.
- **Geospatial location.** `location` is a text landmark or address. "Issues
  near me" needs a GeoJSON `Point` and a `2dsphere` index, and that is a
  migration when it arrives — accepted knowingly, see Risks.
- **An `agencies` collection and `agencyId` linkage.** Inherited from the auth
  design's reasoning: there is no agencies collection yet, and a dangling
  reference is worse than a later additive migration. Every `AGENCY` user sees
  every issue.
- **Search, and pagination beyond `limit`/`offset`.**

## Context: what exists today

The auth slice is complete (`docs/superpowers/specs/2026-09-13-auth-identity-design.md`).
It leaves behind exactly the machinery this slice needs:

- Global default-deny guards (`JwtAuthGuard` then `RolesGuard`) registered as
  `APP_GUARD`, with `@Public()` as the opt-out and `@Roles()` as the per-route
  requirement.
- `@CurrentUser()` yielding `AuthenticatedUser { id, email, roles }` built from
  token claims.
- `MongoExceptionFilter` (`CastError` → 400, `ValidationError` → 400, duplicate
  key → 409) and a global `ValidationPipe` with `whitelist` +
  `forbidNonWhitelisted`, both registered in `AppModule` so tests share the
  production stack.
- `ParseObjectIdPipe` for `:id` params.
- `src/contracts/` as the single source of truth for cross-cutting enums.
- Conventions: `.js` extensions on relative imports, unit specs beside sources,
  e2e specs in `test/` against a `_test`-suffixed database.

There is no issues code of any kind. `src/contracts/` holds only `Role`.

The execution guide that the auth spec cites (§4.1, §4.3) is **not available**.
This design is derived from first principles plus the hints that spec leaves:
`reportedBy` vs `volunteerId` for anti-self-dealing, an eligibility/lock/
assignment model for claims, and `civicPointsCached` as a cache over
`point_transactions`. Where the guide resurfaces and disagrees, it wins.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Slice size | Reporting only | Smallest thing that demos; B and C both sit on top of it. |
| Location | Text string | No geo infrastructure for a demo that shows no map. Additive later. |
| Media | None | An upload endpoint is its own subsystem (storage, limits, serving) and would roughly double this slice. |
| Status enum | Full lifecycle now, only `OPEN`'s transitions implemented | Slice B slots in without an enum migration, and the intended arc is documented in code from day one. |
| Categories | Fixed enum in `src/contracts/` | Follows the `Role` precedent. An admin-managed category table is a later slice if ever wanted. |
| Read access | `@Public()` | A civic record that requires a login is not a transparency platform, and the demo is viewable without credentials. |
| Create access | `@Roles(CITIZEN)` | Attribution is the point; `reportedBy` comes from the token. |
| Status changes | `@Roles(AGENCY, ADMIN)` only | Matches the auth design's claim that agencies remain authoritative owners of issues. |
| Lifecycle location | A separate `IssueLifecycleService` | The only writer of `status`. Keeps transition rules out of CRUD and unit-testable without a database; slice B's lock and anti-self-dealing rules drop in without restructuring. |
| Deletion | No `DELETE` route | A civic record should not be erasable. `REJECTED` and `DUPLICATE` cover the real need. |

## 1. Contracts

Two enums in `src/contracts/`, each in its own file, re-exported from
`index.ts` beside `role.js`.

```ts
// src/contracts/issue-status.ts
export enum IssueStatus {
  OPEN = 'OPEN',
  CLAIMED = 'CLAIMED',
  IN_PROGRESS = 'IN_PROGRESS',
  RESOLVED = 'RESOLVED',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
  DUPLICATE = 'DUPLICATE',
}
```

`CLAIMED`, `IN_PROGRESS`, `RESOLVED` and `VERIFIED` are declared but
unreachable in this slice. That is deliberate: the enum is the contract for the
whole arc, and slice B implements the transitions rather than widening the type.

```ts
// src/contracts/issue-category.ts
export enum IssueCategory {
  SANITATION = 'SANITATION',
  ROADS = 'ROADS',
  WATER = 'WATER',
  ELECTRICITY = 'ELECTRICITY',
  DRAINAGE = 'DRAINAGE',
  PUBLIC_SAFETY = 'PUBLIC_SAFETY',
  OTHER = 'OTHER',
}
```

## 2. Issue schema

`src/issues/schemas/issue.schema.ts`, following `user.schema.ts`'s conventions
exactly — `timestamps: true`, and a `toJSON` transform mapping `_id` to `id`
with `versionKey: false`.

| Field | Type | Constraints |
|---|---|---|
| `title` | `string` | required, trimmed, max 140 |
| `description` | `string` | required, trimmed, max 2000 |
| `category` | `IssueCategory` | required, enum-validated |
| `location` | `string` | required, trimmed, max 200 |
| `status` | `IssueStatus` | default `OPEN`, indexed |
| `reportedBy` | `ObjectId` ref `User` | required, indexed |
| `statusReason` | `string` | optional, max 500 |
| `duplicateOf` | `ObjectId` ref `Issue` | optional |

Indexes: `reportedBy`, and a compound `{ status: 1, createdAt: -1 }` serving the
default listing (open issues, newest first).

`statusReason` and `duplicateOf` are written only by `IssueLifecycleService`.

## 3. Module layout

```
src/issues/
  issues.module.ts
  issues.controller.ts
  issues.service.ts
  issues.service.spec.ts
  issue-lifecycle.service.ts
  issue-lifecycle.service.spec.ts
  issues.controller.spec.ts
  issue-response.ts
  dto/
    create-issue.dto.ts
    update-issue.dto.ts
    change-status.dto.ts
    list-issues.query.ts
  schemas/
    issue.schema.ts
```

**`IssuesService`** owns persistence and queries: `create`, `findAll(query)`,
`findOne(id)`, `updateOwn(id, actorId, dto)`. It never *changes* `status`: on
create the value comes from the schema default (`OPEN`), and `create` passes no
`status` of its own, so every subsequent transition goes through the lifecycle
service.

**`IssueLifecycleService`** owns the transition table and is the only writer of
`status`. Its public method is
`changeStatus(id, actor, dto): Promise<IssueDocument>`.

The split exists because slice B's rules (is the issue locked, is this actor the
reporter, does anti-self-dealing forbid this claim) are lifecycle concerns that
would otherwise tangle with CRUD — the same tangle that made `UsersService`
need its "only place that selects the password hash" comment.

**`issue-response.ts`** exports `PublicIssue` and `toPublicIssue(issue)`,
following `user-response.ts`: explicit field mapping, so adding a schema field
cannot silently widen what the API exposes.

## 4. Transitions

The transition table, held in `IssueLifecycleService`:

| From | To | Allowed for | Requires |
|---|---|---|---|
| `OPEN` | `REJECTED` | `AGENCY`, `ADMIN` | `reason` |
| `OPEN` | `DUPLICATE` | `AGENCY`, `ADMIN` | `duplicateOf` |

Every other pair is refused with `409 Conflict` naming both states, e.g.
`Cannot move an issue from VERIFIED to REJECTED`. A transition to the issue's
current status is refused the same way rather than treated as a no-op: silently
accepting it would hide a client bug.

`duplicateOf` must reference an existing issue, and must not be the issue
itself. Both are checked in the service, not the DTO, because both need a
database read.

Slice B adds `OPEN → CLAIMED`, `CLAIMED → IN_PROGRESS`, `IN_PROGRESS →
RESOLVED`, `RESOLVED → VERIFIED` and the corresponding release/rejection paths.

## 5. API

| Route | Access | Success | Notes |
|---|---|---|---|
| `POST /issues` | `@Roles(CITIZEN)` | 201 | `reportedBy` from `@CurrentUser()`, never the body. `status` forced to `OPEN`. |
| `GET /issues` | `@Public()` | 200 | Filters: `status`, `category`, `reportedBy`. Paging: `limit` (default 20, max 100), `offset`. Sorted newest first. |
| `GET /issues/:id` | `@Public()` | 200 | 404 when unknown. |
| `PATCH /issues/:id` | authenticated; reporter only | 200 | Editable: `title`, `description`, `category`, `location`. Only while `OPEN`. |
| `PATCH /issues/:id/status` | `@Roles(AGENCY, ADMIN)` | 200 | Body `{ status, reason?, duplicateOf? }`. Routed through `IssueLifecycleService`. |

`CreateIssueDto` declares no `status` and no `reportedBy`. As with
`RegisterDto` and `roles`, a payload carrying either is rejected by the global
`forbidNonWhitelisted` pipe as an unknown property — the gate is structural
rather than validated, so there is no gate to get wrong.

`PATCH /issues/:id` is authenticated but carries no `@Roles()`: ownership, not
role, is the requirement. The check compares `reportedBy` against
`@CurrentUser().id` inside the service and throws `403` on mismatch. Editing is
refused once the issue leaves `OPEN` — `409`, since an agency may already have
acted on what it read.

Ownership is the *only* way in: an `ADMIN` editing someone else's issue gets the
same `403`. Rewriting a citizen's account of what they saw is not an
administrative power, and nothing in the demo needs it. An admin who must
suppress a report has `REJECTED`, which is recorded rather than silent.

## 6. Error contract

Mostly inherited; nothing is hand-rolled.

| Condition | Status | Source |
|---|---|---|
| Malformed `:id` | 400 | `ParseObjectIdPipe` |
| Unknown or invalid body property | 400 | global `ValidationPipe` |
| No/!bad token on a non-public route | 401 | `JwtAuthGuard` |
| Wrong role | 403 | `RolesGuard` |
| Editing another user's issue | 403 | `IssuesService`, `ForbiddenException` |
| Unknown issue | 404 | `NotFoundException` |
| Illegal transition, or editing a non-`OPEN` issue | 409 | `IssueLifecycleService` / `IssuesService`, `ConflictException` |

## 7. Seed

`src/seed.ts` gains a handful of issues attributed to the seeded citizens,
upserted on a stable natural key (`title` + `reportedBy`) so re-running stays
idempotent, consistent with the existing user seeding. `--fresh` clears issues
as well as users.

Seeded issues are all `OPEN`, so slice B has material to claim.

## 8. Testing

Unit, beside the sources, no database:

- `issue-lifecycle.service.spec.ts` — the transition table exhaustively: each
  allowed move, a representative sample of refused ones, missing `reason`,
  missing `duplicateOf`, self-referential `duplicateOf`, same-state transition.
- `issues.service.spec.ts` — mocked model: create forces `OPEN` and the token's
  `reportedBy`; ownership check rejects a non-reporter; edit refused when not
  `OPEN`; filters compose into the expected query.
- `issues.controller.spec.ts` — mocked service, delegation only.

e2e, `test/issues.e2e-spec.ts`, against the `_test` database:

- Public read works with no token, for both list and detail.
- A citizen creates an issue; the response carries `reportedBy` as the caller
  and `status: OPEN`.
- A body carrying `status` or `reportedBy` is rejected 400.
- An anonymous create is 401; an `AGENCY` create is 403.
- The reporter edits their own issue; a different citizen gets 403, and so does
  an admin.
- Editing an issue that is no longer `OPEN` returns 409.
- An agency rejects an issue with a reason; an illegal transition returns 409.
- Filters and paging return what they claim.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Text `location` needs to become geospatial | Accepted. Adding a `GeoJSON` field and a `2dsphere` index is additive; backfilling coordinates from free text is the real cost, and is a migration whenever it happens. |
| Four enum members unreachable in this slice | Deliberate and documented here; slice B implements the transitions. The alternative churns the contract. |
| Category enum guessed without the execution guide | Cheap to change while no data exists. Revisit the moment the guide resurfaces. |
| `@Public()` read exposes reporter identity | `toPublicIssue` returns `reportedBy` as an id, and this is a civic record where attribution is the point. If anonymity is ever needed it is a response-shaping change, not a schema one. |
| Slice B needs fields not designed here (`volunteerId`, lock state) | Additive to the schema; the lifecycle service is already the single write path for status. |

## Definition of Done

- A citizen can report an issue and it comes back `OPEN` with `reportedBy` set
  from the token, not the body.
- An anonymous caller can list and read issues; creating requires a `CITIZEN`.
- A reporter can edit their own `OPEN` issue; another citizen gets 403; editing
  a non-`OPEN` issue gets 409.
- An agency can reject an issue with a reason and mark one a duplicate; every
  other transition returns 409 naming both states.
- `status` changes in exactly one place in the codebase
  (`IssueLifecycleService`); creation takes the schema default.
- `npm run test`, `npm run test:e2e` and `npm run lint` all pass.
