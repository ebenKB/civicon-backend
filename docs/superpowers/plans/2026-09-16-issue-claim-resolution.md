# Issue Claim & Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a citizen who is not the reporter claim an issue, work it, submit evidence, and have an agency verify it.

**Architecture:** `IssueLifecycleService` stays the single writer of `status` and grows one method per volunteer intent (`claim`, `release`, `start`, `resolve`), each with its own actor rule, plus an extended agency path on `changeStatus`. The four statuses already declared in `IssueStatus` become reachable; no enum members are added. Media gains a derived `purpose` (`REPORT` / `PROOF`) so the reporter's photos and the volunteer's are distinguishable.

**Tech Stack:** NestJS 12 (ESM), Mongoose 9, Vitest, MongoDB 8.

**Spec:** `docs/superpowers/specs/2026-09-16-issue-claim-resolution-design.md`

## Global Constraints

- **ESM codebase.** Every relative import carries a `.js` extension.
- **A type used in a decorated signature needs `import type`** (`isolatedModules` + `emitDecoratorMetadata`). This applies to `AuthenticatedUser`.
- **Import mongoose's `Connection` with `import type`** — it is CommonJS and Node's ESM interop cannot extract it as a named export at runtime.
- **`@Prop` on an enum property needs an explicit `type: String`.**
- **Mongoose 9 exports `QueryFilter`, not `FilterQuery`.**
- **GridFS `contentType` lives in `metadata`**, not at the top level.
- **Global pipe, filter and guards are already registered.** `@Public()` opts out; `@Roles()` requires a role.
- **`status` may be assigned in exactly one file:** `issue-lifecycle.service.ts`.
- **Naming deviation from the spec, deliberate:** the spec calls the media field `kind`. `MediaKind` is already the image/video classifier in `src/contracts/issue-media.ts`, so this plan uses **`purpose` / `MediaPurpose`**. Two different "kind"s in one module would be worse than the deviation.
- **`purpose` is derived from the issue's state, never read from the request body.**
- **The e2e suite builds its actors once in `beforeAll`** and each file gets its own database.
- **No new dependencies.**
- Run `npm run format` and `npm run lint` before each commit.

---

### Task 1: Schema and response fields

The five additive fields, and their explicit mapping into the API shape.

**Files:**
- Modify: `src/issues/schemas/issue.schema.ts`
- Modify: `src/issues/issue-response.ts`
- Modify: `src/issues/issue-response.spec.ts`
- Create: `src/issues/schemas/issue.schema.claim.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Issue.volunteerId?`, `.claimedAt?`, `.resolutionNote?`, `.resolvedAt?`, `.verifiedAt?`; the same five on `PublicIssue`, with `volunteerId` as a string.

- [ ] **Step 1: Write the failing test**

Create `src/issues/schemas/issue.schema.claim.spec.ts`:

```ts
import { IssueSchema } from './issue.schema.js';

// Imports IssueSchema as a VALUE so the module actually executes — a spec that
// imports only a type is erased and cannot catch a schema that fails to build.
describe('IssueSchema claim fields', () => {
  it('references the volunteer as an ObjectId', () => {
    expect(IssueSchema.path('volunteerId').instance).toBe('ObjectId');
    expect(IssueSchema.path('volunteerId').options.ref).toBe('User');
  });

  it('indexes volunteerId, so "what am I working on" is not a scan', () => {
    expect(IssueSchema.path('volunteerId').options.index).toBe(true);
  });

  it('leaves every claim field optional, so no migration is needed', () => {
    for (const field of [
      'volunteerId',
      'claimedAt',
      'resolutionNote',
      'resolvedAt',
      'verifiedAt',
    ]) {
      expect(IssueSchema.path(field).isRequired).toBeFalsy();
    }
  });

  it('caps the resolution note', () => {
    expect(IssueSchema.path('resolutionNote').options.maxlength).toBe(2000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/issues/schemas/issue.schema.claim.spec.ts`
Expected: FAIL — `Cannot read properties of undefined (reading 'instance')`, because the path does not exist.

- [ ] **Step 3: Add the schema fields**

In `src/issues/schemas/issue.schema.ts`, after `duplicateOf`:

```ts
  // The citizen currently holding this issue. Cleared on release, so an
  // unclaimed issue never carries a stale holder.
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    index: true,
  })
  volunteerId?: Types.ObjectId;

  @Prop()
  claimedAt?: Date;

  @Prop({ trim: true, maxlength: 2000 })
  resolutionNote?: string;

  @Prop()
  resolvedAt?: Date;

  @Prop()
  verifiedAt?: Date;
```

- [ ] **Step 4: Widen the response**

In `src/issues/issue-response.ts`, add to `PublicIssue` after `duplicateOf`:

```ts
  volunteerId?: string;
  claimedAt?: Date;
  resolutionNote?: string;
  resolvedAt?: Date;
  verifiedAt?: Date;
```

and to the returned object in `toPublicIssue`:

```ts
    volunteerId: issue.volunteerId?.toString(),
    claimedAt: issue.claimedAt,
    resolutionNote: issue.resolutionNote,
    resolvedAt: issue.resolvedAt,
    verifiedAt: issue.verifiedAt,
```

In `src/issues/issue-response.spec.ts`, add the five keys as `undefined` to the
expected object in 'maps the document onto the public shape', and add:

```ts
  it('renders the volunteer id as a string', () => {
    const volunteerId = new Types.ObjectId();

    const result = toPublicIssue(issueDoc({ volunteerId }));

    expect(result.volunteerId).toBe(volunteerId.toString());
  });
```

- [ ] **Step 5: Run the tests**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run format && npm run lint
git add src/issues
git commit -m "Add claim fields to the issue schema and response"
```

---

### Task 2: Media purpose — REPORT and PROOF

The distinction the AI verification slice will compare, derived from the issue's state.

**Files:**
- Modify: `src/contracts/issue-media.ts`
- Modify: `src/issues/issue-media-response.ts`
- Modify: `src/issues/issue-media.service.ts`
- Modify: `src/issues/issue-media.service.spec.ts`

**Interfaces:**
- Consumes: `IssueStatus` (existing); `Issue.volunteerId` (Task 1).
- Produces: `MediaPurpose` enum (`REPORT` | `PROOF`); `PublicMedia.purpose`; `IssueMediaService.countProofBy(issueId: string, volunteerId: string): Promise<number>`.

- [ ] **Step 1: Add the contract**

Append to `src/contracts/issue-media.ts`:

```ts
/**
 * Why a file is attached, derived from the issue's state at upload time and
 * never supplied by the client — the same principle that keeps reportedBy and
 * status out of request bodies.
 *
 * Named `purpose` rather than `kind` because MediaKind above already means
 * image-vs-video; two different "kind"s in one module would be worse than
 * diverging from the design document's wording.
 */
export enum MediaPurpose {
  REPORT = 'REPORT',
  PROOF = 'PROOF',
}
```

- [ ] **Step 2: Write the failing test**

In `src/issues/issue-media.service.spec.ts`, add `MediaPurpose` to the contracts
import, and add this block inside the outer `describe`:

```ts
  describe('purpose', () => {
    const claimedIssue = (volunteerId: string) => ({
      _id: new Types.ObjectId(ISSUE_ID),
      reportedBy: new Types.ObjectId(REPORTER),
      volunteerId: new Types.ObjectId(volunteerId),
      status: IssueStatus.CLAIMED,
    });

    it('refuses a non-holder while the issue is claimed', async () => {
      issuesService.findOne.mockResolvedValue(claimedIssue(STRANGER));

      await expect(
        service.upload(ISSUE_ID, REPORTER, anImage()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses the reporter once the issue is no longer OPEN', async () => {
      issuesService.findOne.mockResolvedValue(claimedIssue(STRANGER));

      // The reporter may attach while OPEN; after a claim the holder owns it.
      await expect(
        service.upload(ISSUE_ID, REPORTER, anImage()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses anyone once the issue is resolved', async () => {
      issuesService.findOne.mockResolvedValue({
        ...claimedIssue(STRANGER),
        status: IssueStatus.RESOLVED,
      });

      await expect(
        service.upload(ISSUE_ID, STRANGER, anImage()),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('countProofBy', () => {
    it('counts only the named volunteer\'s proof', async () => {
      bucket.find.mockReturnValue(cursorOf([fileDoc(), fileDoc()]));

      await service.countProofBy(ISSUE_ID, REPORTER);

      const [filter] = bucket.find.mock.calls[0];
      expect(filter['metadata.purpose']).toBe(MediaPurpose.PROOF);
      expect(filter['metadata.uploadedBy'].toString()).toBe(REPORTER);
      expect(filter['metadata.issueId'].toString()).toBe(ISSUE_ID);
    });
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/issues/issue-media.service.spec.ts`
Expected: FAIL — the reporter is still allowed on a CLAIMED issue, and
`countProofBy` does not exist.

- [ ] **Step 4: Rewrite assertMayAttach**

In `src/issues/issue-media.service.ts`, replace `assertMayAttach` entirely:

```ts
  /**
   * Who may attach, and what the file counts as. Both are positional: the
   * issue's state decides, so a client cannot claim its upload is something it
   * is not.
   */
  private async assertMayAttach(
    issueId: string,
    actorId: string,
  ): Promise<MediaPurpose> {
    const issue = await this.issuesService.findOne(issueId);

    if (issue.status === IssueStatus.OPEN) {
      if (issue.reportedBy.toString() !== actorId) {
        throw new ForbiddenException(
          'You can only attach media to issues you reported',
        );
      }
      return MediaPurpose.REPORT;
    }

    if (
      issue.status === IssueStatus.CLAIMED ||
      issue.status === IssueStatus.IN_PROGRESS
    ) {
      if (issue.volunteerId?.toString() !== actorId) {
        throw new ForbiddenException(
          'Only the volunteer holding this issue can attach proof of work',
        );
      }
      return MediaPurpose.PROOF;
    }

    throw new ConflictException(
      `Media cannot be attached while an issue is ${issue.status}`,
    );
  }
```

In `upload`, capture the returned purpose and write it into the metadata:

```ts
    const purpose = await this.assertMayAttach(issueId, actorId);
```

and in the `openUploadStream` metadata object add:

```ts
        purpose,
```

In `remove`, `assertMayAttach`'s return value is unused — call it as before.

Add the counter:

```ts
  /**
   * Proof is read by author: a file left behind by a previous volunteer does
   * not count towards the current holder's resolution.
   */
  async countProofBy(issueId: string, volunteerId: string): Promise<number> {
    const files = await this.bucket
      .find({
        'metadata.issueId': new Types.ObjectId(issueId),
        'metadata.uploadedBy': new Types.ObjectId(volunteerId),
        'metadata.purpose': MediaPurpose.PROOF,
      })
      .toArray();

    return files.length;
  }
```

Add `MediaPurpose` to the contracts import.

- [ ] **Step 5: Surface it on the response**

In `src/issues/issue-media-response.ts`, add `purpose?: string;` to the
`metadata` shape of `MediaFileDocument`, add `purpose: MediaPurpose;` to
`PublicMedia`, and map it:

```ts
    // Files stored before this slice carry no purpose. Everything that existed
    // then was uploaded by a reporter while the issue was OPEN, so REPORT is
    // the correct reading and no backfill is needed.
    purpose: (file.metadata?.purpose as MediaPurpose) ?? MediaPurpose.REPORT,
```

Import `MediaPurpose` from `../contracts/index.js`.

- [ ] **Step 6: Run the tests**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npm run format && npm run lint
git add src/contracts src/issues
git commit -m "Derive a REPORT/PROOF purpose for issue media"
```

---

### Task 3: Claiming, releasing and starting

Three transitions, each with its own actor rule. No proof involved yet.

**Files:**
- Modify: `src/issues/issue-lifecycle.service.ts`
- Modify: `src/issues/issue-lifecycle.service.spec.ts`

**Interfaces:**
- Consumes: `IssuesService.findOne`; `Issue.volunteerId`, `.claimedAt` (Task 1).
- Produces: `IssueLifecycleService.claim(id, actorId)`, `.release(id, actorId)`, `.start(id, actorId)`, all returning `Promise<IssueDocument>`.

- [ ] **Step 1: Write the failing test**

Add to `src/issues/issue-lifecycle.service.spec.ts`. Add `ForbiddenException` to
the `@nestjs/common` import and `Types` to the mongoose import:

```ts
  describe('claim', () => {
    const REPORTER = '507f1f77bcf86cd799439011';
    const VOLUNTEER = '507f1f77bcf86cd799439044';

    const openIssue = (overrides: Record<string, unknown> = {}) => ({
      status: IssueStatus.OPEN,
      reportedBy: new Types.ObjectId(REPORTER),
      save: vi.fn().mockImplementation(function (this: unknown) {
        return Promise.resolve(this);
      }),
      ...overrides,
    });

    it('lets a citizen who is not the reporter take it', async () => {
      const issue = openIssue();
      issuesService.findOne.mockResolvedValue(issue);

      const result = await service.claim(ISSUE_ID, VOLUNTEER);

      expect(result.status).toBe(IssueStatus.CLAIMED);
      expect(result.volunteerId?.toString()).toBe(VOLUNTEER);
      expect(result.claimedAt).toBeInstanceOf(Date);
    });

    // The rule the Role contract exists to express: a reporter who could also
    // claim could approve their own work once points are on the line.
    it('refuses the reporter, naming the rule', async () => {
      issuesService.findOne.mockResolvedValue(openIssue());

      await expect(service.claim(ISSUE_ID, REPORTER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.claim(ISSUE_ID, REPORTER)).rejects.toThrow(
        /report/i,
      );
    });

    it('refuses an issue someone else already holds', async () => {
      issuesService.findOne.mockResolvedValue(
        openIssue({
          status: IssueStatus.CLAIMED,
          volunteerId: new Types.ObjectId(VOLUNTEER),
        }),
      );

      await expect(
        service.claim(ISSUE_ID, '507f1f77bcf86cd799439055'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('release', () => {
    const REPORTER = '507f1f77bcf86cd799439011';
    const VOLUNTEER = '507f1f77bcf86cd799439044';

    const heldIssue = (status = IssueStatus.CLAIMED) => ({
      status,
      reportedBy: new Types.ObjectId(REPORTER),
      volunteerId: new Types.ObjectId(VOLUNTEER),
      claimedAt: new Date(),
      save: vi.fn().mockImplementation(function (this: unknown) {
        return Promise.resolve(this);
      }),
    });

    it('returns the issue to OPEN and clears the holder', async () => {
      issuesService.findOne.mockResolvedValue(heldIssue());

      const result = await service.release(ISSUE_ID, VOLUNTEER);

      expect(result.status).toBe(IssueStatus.OPEN);
      expect(result.volunteerId).toBeUndefined();
      expect(result.claimedAt).toBeUndefined();
    });

    it('works from IN_PROGRESS too', async () => {
      issuesService.findOne.mockResolvedValue(
        heldIssue(IssueStatus.IN_PROGRESS),
      );

      const result = await service.release(ISSUE_ID, VOLUNTEER);

      expect(result.status).toBe(IssueStatus.OPEN);
    });

    it('refuses anyone but the holder', async () => {
      issuesService.findOne.mockResolvedValue(heldIssue());

      await expect(
        service.release(ISSUE_ID, REPORTER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('start', () => {
    const VOLUNTEER = '507f1f77bcf86cd799439044';

    const claimed = () => ({
      status: IssueStatus.CLAIMED,
      reportedBy: new Types.ObjectId('507f1f77bcf86cd799439011'),
      volunteerId: new Types.ObjectId(VOLUNTEER),
      save: vi.fn().mockImplementation(function (this: unknown) {
        return Promise.resolve(this);
      }),
    });

    it('moves a claimed issue to IN_PROGRESS', async () => {
      issuesService.findOne.mockResolvedValue(claimed());

      const result = await service.start(ISSUE_ID, VOLUNTEER);

      expect(result.status).toBe(IssueStatus.IN_PROGRESS);
    });

    it('refuses anyone but the holder', async () => {
      issuesService.findOne.mockResolvedValue(claimed());

      await expect(
        service.start(ISSUE_ID, '507f1f77bcf86cd799439055'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/issues/issue-lifecycle.service.spec.ts`
Expected: FAIL — `service.claim is not a function`.

- [ ] **Step 3: Widen the transition table**

In `src/issues/issue-lifecycle.service.ts`, replace the map:

```ts
/**
 * Which statuses each status may move to. Actor rules live in the methods
 * below: the same move is legal for different people depending on intent —
 * a holder releasing and an agency forcing a release both go CLAIMED -> OPEN.
 */
const ALLOWED_TRANSITIONS: ReadonlyMap<IssueStatus, readonly IssueStatus[]> =
  new Map([
    [
      IssueStatus.OPEN,
      [IssueStatus.CLAIMED, IssueStatus.REJECTED, IssueStatus.DUPLICATE],
    ],
    [
      IssueStatus.CLAIMED,
      [IssueStatus.IN_PROGRESS, IssueStatus.RESOLVED, IssueStatus.OPEN],
    ],
    [IssueStatus.IN_PROGRESS, [IssueStatus.RESOLVED, IssueStatus.OPEN]],
    [IssueStatus.RESOLVED, [IssueStatus.VERIFIED, IssueStatus.IN_PROGRESS]],
  ]);
```

- [ ] **Step 4: Add the shared guards and the three methods**

Add these private helpers and public methods:

```ts
  private assertTransition(from: IssueStatus, to: IssueStatus): void {
    const allowed = ALLOWED_TRANSITIONS.get(from) ?? [];
    if (!allowed.includes(to)) {
      throw new ConflictException(
        `Cannot move an issue from ${from} to ${to}`,
      );
    }
  }

  private assertIsHolder(issue: IssueDocument, actorId: string): void {
    if (issue.volunteerId?.toString() !== actorId) {
      throw new ForbiddenException(
        'Only the volunteer holding this issue can do that',
      );
    }
  }

  /**
   * Anti-self-dealing. A reporter who could also claim could, once civic points
   * exist, report and resolve their own issue for credit.
   */
  async claim(id: string, actorId: string): Promise<IssueDocument> {
    const issue = await this.issuesService.findOne(id);

    if (issue.status === IssueStatus.CLAIMED && issue.volunteerId) {
      throw new ConflictException(
        'This issue is already claimed by another volunteer',
      );
    }

    this.assertTransition(issue.status, IssueStatus.CLAIMED);

    if (issue.reportedBy.toString() === actorId) {
      throw new ForbiddenException(
        'You cannot claim an issue you reported yourself',
      );
    }

    issue.volunteerId = new Types.ObjectId(actorId);
    issue.claimedAt = new Date();
    issue.status = IssueStatus.CLAIMED;
    return issue.save();
  }

  async release(id: string, actorId: string): Promise<IssueDocument> {
    const issue = await this.issuesService.findOne(id);
    this.assertTransition(issue.status, IssueStatus.OPEN);
    this.assertIsHolder(issue, actorId);

    return this.returnToOpen(issue);
  }

  async start(id: string, actorId: string): Promise<IssueDocument> {
    const issue = await this.issuesService.findOne(id);
    this.assertTransition(issue.status, IssueStatus.IN_PROGRESS);
    this.assertIsHolder(issue, actorId);

    issue.status = IssueStatus.IN_PROGRESS;
    return issue.save();
  }

  /** Shared by a holder's release and an agency's force-release. */
  private returnToOpen(issue: IssueDocument): Promise<IssueDocument> {
    issue.volunteerId = undefined;
    issue.claimedAt = undefined;
    issue.resolvedAt = undefined;
    issue.resolutionNote = undefined;
    issue.status = IssueStatus.OPEN;
    return issue.save();
  }
```

Add `ForbiddenException` to the `@nestjs/common` import.

Note the ordering in `claim`: the already-claimed check runs before
`assertTransition`, so a second claimer gets a 409 naming the conflict rather
than a generic "cannot move from CLAIMED to CLAIMED".

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/issues/issue-lifecycle.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run format && npm run lint
git add src/issues
git commit -m "Add claiming, releasing and starting an issue"
```

---

### Task 4: Resolving, and the agency's verdict

**Files:**
- Create: `src/issues/dto/resolve-issue.dto.ts`
- Modify: `src/issues/issue-lifecycle.service.ts`
- Modify: `src/issues/issue-lifecycle.service.spec.ts`
- Modify: `src/issues/issues.module.ts`

**Interfaces:**
- Consumes: `IssueMediaService.countProofBy` (Task 2).
- Produces: `ResolveIssueDto { note: string }`; `IssueLifecycleService.resolve(id, actorId, dto)`; an extended `changeStatus` covering `VERIFIED`, the send-back and the force-release.

- [ ] **Step 1: Write the DTO**

Create `src/issues/dto/resolve-issue.dto.ts`:

```ts
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ResolveIssueDto {
  /** What the volunteer says they did. The proof photos are the evidence. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  note: string;
}
```

- [ ] **Step 2: Write the failing test**

Add to `src/issues/issue-lifecycle.service.spec.ts`. The suite's testing module
needs the new dependency — add to its `providers`:

```ts
        { provide: IssueMediaService, useValue: mediaService },
```

with `let mediaService: { countProofBy: ReturnType<typeof vi.fn> };` and
`mediaService = { countProofBy: vi.fn().mockResolvedValue(1) };` in
`beforeEach`, plus the import of `IssueMediaService`.

```ts
  describe('resolve', () => {
    const VOLUNTEER = '507f1f77bcf86cd799439044';

    const inProgress = () => ({
      status: IssueStatus.IN_PROGRESS,
      reportedBy: new Types.ObjectId('507f1f77bcf86cd799439011'),
      volunteerId: new Types.ObjectId(VOLUNTEER),
      save: vi.fn().mockImplementation(function (this: unknown) {
        return Promise.resolve(this);
      }),
    });

    it('records the note and moves to RESOLVED', async () => {
      issuesService.findOne.mockResolvedValue(inProgress());

      const result = await service.resolve(ISSUE_ID, VOLUNTEER, {
        note: 'Cleared the silt and reset the grate.',
      });

      expect(result.status).toBe(IssueStatus.RESOLVED);
      expect(result.resolutionNote).toContain('silt');
      expect(result.resolvedAt).toBeInstanceOf(Date);
    });

    it('refuses without a proof photo from this volunteer', async () => {
      issuesService.findOne.mockResolvedValue(inProgress());
      mediaService.countProofBy.mockResolvedValue(0);

      await expect(
        service.resolve(ISSUE_ID, VOLUNTEER, { note: 'Done' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('counts proof by the current holder, not by anyone', async () => {
      issuesService.findOne.mockResolvedValue(inProgress());

      await service.resolve(ISSUE_ID, VOLUNTEER, { note: 'Done' });

      expect(mediaService.countProofBy).toHaveBeenCalledWith(
        ISSUE_ID,
        VOLUNTEER,
      );
    });

    it('refuses anyone but the holder', async () => {
      issuesService.findOne.mockResolvedValue(inProgress());

      await expect(
        service.resolve(ISSUE_ID, '507f1f77bcf86cd799439055', { note: 'x' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('the agency verdict', () => {
    const VOLUNTEER = '507f1f77bcf86cd799439044';

    const resolved = () => ({
      status: IssueStatus.RESOLVED,
      reportedBy: new Types.ObjectId('507f1f77bcf86cd799439011'),
      volunteerId: new Types.ObjectId(VOLUNTEER),
      resolvedAt: new Date(),
      resolutionNote: 'Done',
      save: vi.fn().mockImplementation(function (this: unknown) {
        return Promise.resolve(this);
      }),
    });

    it('verifies a resolved issue', async () => {
      issuesService.findOne.mockResolvedValue(resolved());

      const result = await service.changeStatus(ISSUE_ID, {
        status: IssueStatus.VERIFIED,
      });

      expect(result.status).toBe(IssueStatus.VERIFIED);
      expect(result.verifiedAt).toBeInstanceOf(Date);
      // The holder is kept: slice C awards points to this person.
      expect(result.volunteerId?.toString()).toBe(VOLUNTEER);
    });

    it('sends work back to IN_PROGRESS with a reason, keeping the holder', async () => {
      issuesService.findOne.mockResolvedValue(resolved());

      const result = await service.changeStatus(ISSUE_ID, {
        status: IssueStatus.IN_PROGRESS,
        reason: 'The grate is still blocked',
      });

      expect(result.status).toBe(IssueStatus.IN_PROGRESS);
      expect(result.volunteerId?.toString()).toBe(VOLUNTEER);
      expect(result.resolvedAt).toBeUndefined();
    });

    it('refuses a send-back with no reason', async () => {
      issuesService.findOne.mockResolvedValue(resolved());

      await expect(
        service.changeStatus(ISSUE_ID, { status: IssueStatus.IN_PROGRESS }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('force-releases a claimed issue, clearing the holder', async () => {
      issuesService.findOne.mockResolvedValue({
        ...resolved(),
        status: IssueStatus.CLAIMED,
      });

      const result = await service.changeStatus(ISSUE_ID, {
        status: IssueStatus.OPEN,
        reason: 'No progress for a fortnight',
      });

      expect(result.status).toBe(IssueStatus.OPEN);
      expect(result.volunteerId).toBeUndefined();
    });

    it('refuses a force-release with no reason', async () => {
      issuesService.findOne.mockResolvedValue({
        ...resolved(),
        status: IssueStatus.CLAIMED,
      });

      await expect(
        service.changeStatus(ISSUE_ID, { status: IssueStatus.OPEN }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    // An agency must not be able to skip the evidence requirement by setting
    // RESOLVED directly, nor hand the issue to someone by setting CLAIMED.
    it.each([IssueStatus.RESOLVED, IssueStatus.CLAIMED])(
      'refuses %s through the agency path',
      async (target) => {
        issuesService.findOne.mockResolvedValue({
          ...resolved(),
          status: IssueStatus.IN_PROGRESS,
        });

        await expect(
          service.changeStatus(ISSUE_ID, { status: target }),
        ).rejects.toBeInstanceOf(ForbiddenException);
      },
    );
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/issues/issue-lifecycle.service.spec.ts`
Expected: FAIL — `service.resolve is not a function`.

- [ ] **Step 4: Implement resolve and extend changeStatus**

In `src/issues/issue-lifecycle.service.ts`, inject the media service:

```ts
  constructor(
    private readonly issuesService: IssuesService,
    private readonly issueMediaService: IssueMediaService,
  ) {}
```

Add the statuses an agency may set, above the class:

```ts
/**
 * What the agency route may do. RESOLVED is absent on purpose — it requires
 * evidence, and an agency setting it directly would walk around that. CLAIMED
 * is absent because a claim needs a volunteer, which this route has no way to
 * name.
 */
// Note this yields 403, not the 409 an illegal transition gives: the move may
// be legal, just not for this actor. The spec's error table does not draw that
// line; this is the finer reading.
const AGENCY_TARGETS: readonly IssueStatus[] = [
  IssueStatus.VERIFIED,
  IssueStatus.IN_PROGRESS,
  IssueStatus.OPEN,
  IssueStatus.REJECTED,
  IssueStatus.DUPLICATE,
];
```

Add `resolve`:

```ts
  async resolve(
    id: string,
    actorId: string,
    dto: ResolveIssueDto,
  ): Promise<IssueDocument> {
    const issue = await this.issuesService.findOne(id);
    this.assertTransition(issue.status, IssueStatus.RESOLVED);
    this.assertIsHolder(issue, actorId);

    // Proof is read by author, so evidence left by a previous volunteer does
    // not satisfy this.
    const proof = await this.issueMediaService.countProofBy(id, actorId);
    if (proof === 0) {
      throw new BadRequestException(
        'Attach at least one photo as proof of work before resolving',
      );
    }

    issue.resolutionNote = dto.note;
    issue.resolvedAt = new Date();
    issue.status = IssueStatus.RESOLVED;
    return issue.save();
  }
```

At the top of `changeStatus`, after fetching the issue, add the agency
restriction and the companion checks:

```ts
    if (!AGENCY_TARGETS.includes(dto.status)) {
      throw new ForbiddenException(
        `An agency cannot set an issue to ${dto.status}`,
      );
    }
```

Replace the bare `ALLOWED_TRANSITIONS` lookup with `this.assertTransition(issue.status, dto.status);`
and add, alongside the existing REJECTED and DUPLICATE checks:

```ts
    // Both of these overrule a volunteer, so both must be explained.
    if (
      dto.status === IssueStatus.IN_PROGRESS ||
      (dto.status === IssueStatus.OPEN && issue.volunteerId)
    ) {
      if (!dto.reason) {
        throw new BadRequestException(
          'A reason is required when overruling a volunteer',
        );
      }
    }

    if (dto.status === IssueStatus.VERIFIED) {
      issue.verifiedAt = new Date();
    }

    if (dto.status === IssueStatus.IN_PROGRESS) {
      // Sent back for more work: the same volunteer keeps it.
      issue.resolvedAt = undefined;
      issue.resolutionNote = undefined;
    }

    if (dto.status === IssueStatus.OPEN) {
      return this.returnToOpen(issue);
    }
```

Import `ResolveIssueDto` and `IssueMediaService`.

- [ ] **Step 5: Break the dependency cycle**

`IssueMediaService` already depends on `IssuesService`, and now
`IssueLifecycleService` depends on `IssueMediaService`. That is a chain, not a
cycle, so no `forwardRef` is needed. Confirm by booting the app:

Run: `npm run build && node dist/main.js`
Expected: starts cleanly and maps the issue routes. If Nest reports a circular
dependency, stop — do not reach for `forwardRef` without re-reading which
service actually needs which.

- [ ] **Step 6: Run the tests**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npm run format && npm run lint
git add src/issues
git commit -m "Add resolving with evidence and the agency verdict"
```

---

### Task 5: Action routes

**Files:**
- Modify: `src/issues/issues.controller.ts`
- Modify: `src/issues/issues.controller.spec.ts`
- Modify: `src/issues/dto/list-issues.query.ts`
- Modify: `src/issues/issues.service.ts`
- Modify: `src/issues/issues.service.spec.ts`

**Interfaces:**
- Consumes: the four lifecycle methods (Tasks 3-4).
- Produces: `POST /issues/:id/claim`, `DELETE /issues/:id/claim`, `POST /issues/:id/start`, `POST /issues/:id/resolution`; a `volunteerId` filter on `GET /issues`.

- [ ] **Step 1: Write the failing controller test**

In `src/issues/issues.controller.spec.ts`, add `claim`, `release`, `start` and
`resolve` to the `lifecycle` double, and add:

```ts
  it.each([
    ['claim', 'claim'],
    ['release', 'release'],
    ['start', 'start'],
  ])('passes the caller id to %s', async (method, lifecycleMethod) => {
    lifecycle[lifecycleMethod].mockResolvedValue(issueDoc());

    await controller[method]('507f1f77bcf86cd799439011', caller);

    expect(lifecycle[lifecycleMethod]).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      reporterId.toString(),
    );
  });

  it('passes the note and the caller id to resolve', async () => {
    lifecycle.resolve.mockResolvedValue(issueDoc());

    await controller.resolve('507f1f77bcf86cd799439011', caller, {
      note: 'Cleared it',
    });

    expect(lifecycle.resolve).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      reporterId.toString(),
      { note: 'Cleared it' },
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/issues/issues.controller.spec.ts`
Expected: FAIL — `controller.claim is not a function`.

- [ ] **Step 3: Add the routes**

In `src/issues/issues.controller.ts`, add `Delete` to the `@nestjs/common`
import, import `ResolveIssueDto`, and add:

```ts
  // The route is the intent: none of these takes a status, so a client cannot
  // ask for a transition that does not belong to it.
  @Post(':id/claim')
  @Roles(Role.CITIZEN)
  async claim(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return toPublicIssue(await this.issueLifecycleService.claim(id, user.id));
  }

  @Delete(':id/claim')
  async release(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return toPublicIssue(await this.issueLifecycleService.release(id, user.id));
  }

  @Post(':id/start')
  async start(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return toPublicIssue(await this.issueLifecycleService.start(id, user.id));
  }

  @Post(':id/resolution')
  async resolve(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() resolveIssueDto: ResolveIssueDto,
  ) {
    return toPublicIssue(
      await this.issueLifecycleService.resolve(id, user.id, resolveIssueDto),
    );
  }
```

Only `claim` carries `@Roles(CITIZEN)`. The other three are holder-only, and the
service enforces that — a role check would be redundant and would wrongly refuse
a holder whose roles change.

- [ ] **Step 4: Add the volunteerId filter**

In `src/issues/dto/list-issues.query.ts`:

```ts
  @IsOptional()
  @IsMongoId()
  volunteerId?: string;
```

In `src/issues/issues.service.ts`, inside `findAll`:

```ts
    if (query.volunteerId) {
      filter.volunteerId = new Types.ObjectId(query.volunteerId);
    }
```

In `src/issues/issues.service.spec.ts`:

```ts
    it('filters by volunteer as an ObjectId', async () => {
      model.find.mockReturnValue(chainOf([]));

      await service.findAll({ volunteerId: REPORTER });

      const [filter] = model.find.mock.calls[0];
      expect(filter.volunteerId).toBeInstanceOf(Types.ObjectId);
    });
```

- [ ] **Step 5: Run the tests and verify by hand**

Run: `npm run test` — expected PASS. Then:

```bash
docker compose up -d && npm run build && npm run seed
node dist/main.js &
```

```bash
CITIZEN=$(curl -s -X POST localhost:9000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"citizen@civicon.test","password":"Password123!"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')
VOLUNTEER=$(curl -s -X POST localhost:9000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"volunteer@civicon.test","password":"Password123!"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')

ISSUE=$(curl -s 'localhost:9000/issues?status=OPEN&limit=1' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8"))[0].id')

# The reporter cannot claim their own
curl -s -o /dev/null -w 'reporter claims -> %{http_code}\n' \
  -X POST "localhost:9000/issues/$ISSUE/claim" -H "Authorization: Bearer $CITIZEN"

# Another citizen can
curl -s -X POST "localhost:9000/issues/$ISSUE/claim" -H "Authorization: Bearer $VOLUNTEER"
```

Expected: `403` for the reporter (the seeded issues are reported by
`citizen@civicon.test`), then a 200 body with `status: CLAIMED` and a
`volunteerId`. Stop the server when done.

- [ ] **Step 6: Commit**

```bash
npm run format && npm run lint
git add src/issues
git commit -m "Add claim, release, start and resolution routes"
```

---

### Task 6: End-to-end coverage

**Files:**
- Create: `test/issue-claim.e2e-spec.ts`

**Interfaces:**
- Consumes: every route from Tasks 2-5.
- Produces: nothing.

- [ ] **Step 1: Write the suite**

Create `test/issue-claim.e2e-spec.ts`:

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
  MediaPurpose,
  Role,
} from './../src/contracts/index.js';

const PASSWORD = 'super-secret';
const PIXEL = readFileSync(join(import.meta.dirname, 'fixtures/pixel.png'));

const ISSUE = {
  title: 'Collapsed culvert',
  description: 'Gave way after Sunday rain.',
  category: IssueCategory.DRAINAGE,
  location: 'School road',
};

describe('Issue claim & resolution (e2e)', () => {
  let app: INestApplication<App>;
  let connection: Connection;
  let reporterToken: string;
  let volunteerToken: string;
  let otherToken: string;
  let agencyToken: string;
  let issueId: string;

  const login = async (email: string): Promise<string> => {
    const { body } = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return body.token;
  };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const attachProof = (token: string) =>
    request(app.getHttpServer())
      .post(`/issues/${issueId}/media`)
      .set(auth(token))
      .attach('file', PIXEL, { filename: 'after.png', contentType: 'image/png' });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    connection = moduleFixture.get<Connection>(getConnectionToken());
    if (!connection.name.includes('_test')) {
      throw new Error(
        `Refusing to run destructive e2e tests against database "${connection.name}".`,
      );
    }

    await connection.collection('users').deleteMany({});
    for (const email of [
      'reporter@x.test',
      'volunteer@x.test',
      'other@x.test',
      'agency@x.test',
    ]) {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ name: 'Test User', email, password: PASSWORD })
        .expect(201);
    }
    await connection
      .collection('users')
      .updateOne({ email: 'agency@x.test' }, { $set: { roles: [Role.AGENCY] } });

    reporterToken = await login('reporter@x.test');
    volunteerToken = await login('volunteer@x.test');
    otherToken = await login('other@x.test');
    agencyToken = await login('agency@x.test');
  });

  beforeEach(async () => {
    await connection.collection('issues').deleteMany({});
    await connection.collection('issue_media.files').deleteMany({});
    await connection.collection('issue_media.chunks').deleteMany({});

    const { body } = await request(app.getHttpServer())
      .post('/issues')
      .set(auth(reporterToken))
      .send(ISSUE)
      .expect(201);
    issueId = body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('runs the whole arc: claim, start, prove, resolve, verify', async () => {
    const claimed = await request(app.getHttpServer())
      .post(`/issues/${issueId}/claim`)
      .set(auth(volunteerToken))
      .expect(200);
    expect(claimed.body.status).toBe(IssueStatus.CLAIMED);
    expect(claimed.body.volunteerId).toEqual(expect.any(String));

    await request(app.getHttpServer())
      .post(`/issues/${issueId}/start`)
      .set(auth(volunteerToken))
      .expect(200)
      .expect((res) => expect(res.body.status).toBe(IssueStatus.IN_PROGRESS));

    const proof = await attachProof(volunteerToken).expect(201);
    expect(proof.body.purpose).toBe(MediaPurpose.PROOF);

    const resolved = await request(app.getHttpServer())
      .post(`/issues/${issueId}/resolution`)
      .set(auth(volunteerToken))
      .send({ note: 'Cleared the silt and reset the grate.' })
      .expect(200);
    expect(resolved.body.status).toBe(IssueStatus.RESOLVED);
    expect(resolved.body.resolutionNote).toContain('silt');

    const verified = await request(app.getHttpServer())
      .patch(`/issues/${issueId}/status`)
      .set(auth(agencyToken))
      .send({ status: IssueStatus.VERIFIED })
      .expect(200);
    expect(verified.body.status).toBe(IssueStatus.VERIFIED);
    expect(verified.body.verifiedAt).toEqual(expect.any(String));
    expect(verified.body.volunteerId).toBe(claimed.body.volunteerId);
  });

  describe('claiming', () => {
    it('refuses the reporter, naming the rule', async () => {
      const res = await request(app.getHttpServer())
        .post(`/issues/${issueId}/claim`)
        .set(auth(reporterToken))
        .expect(403);

      expect(res.body.message).toMatch(/reported/i);
    });

    it('refuses a second claimer with 409', async () => {
      await request(app.getHttpServer())
        .post(`/issues/${issueId}/claim`)
        .set(auth(volunteerToken))
        .expect(200);

      await request(app.getHttpServer())
        .post(`/issues/${issueId}/claim`)
        .set(auth(otherToken))
        .expect(409);
    });

    it('refuses an anonymous claim', async () => {
      await request(app.getHttpServer())
        .post(`/issues/${issueId}/claim`)
        .expect(401);
    });
  });

  describe('releasing', () => {
    beforeEach(async () => {
      await request(app.getHttpServer())
        .post(`/issues/${issueId}/claim`)
        .set(auth(volunteerToken))
        .expect(200);
    });

    it('returns it to OPEN, clears the holder, and frees it for someone else', async () => {
      const released = await request(app.getHttpServer())
        .delete(`/issues/${issueId}/claim`)
        .set(auth(volunteerToken))
        .expect(200);

      expect(released.body.status).toBe(IssueStatus.OPEN);
      expect(released.body.volunteerId).toBeUndefined();

      await request(app.getHttpServer())
        .post(`/issues/${issueId}/claim`)
        .set(auth(otherToken))
        .expect(200);
    });

    it('refuses a non-holder', async () => {
      await request(app.getHttpServer())
        .delete(`/issues/${issueId}/claim`)
        .set(auth(otherToken))
        .expect(403);
    });

    it('lets an agency force-release with a reason', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/issues/${issueId}/status`)
        .set(auth(agencyToken))
        .send({ status: IssueStatus.OPEN, reason: 'No progress' })
        .expect(200);

      expect(res.body.status).toBe(IssueStatus.OPEN);
      expect(res.body.volunteerId).toBeUndefined();
    });

    it('refuses an agency force-release with no reason', async () => {
      await request(app.getHttpServer())
        .patch(`/issues/${issueId}/status`)
        .set(auth(agencyToken))
        .send({ status: IssueStatus.OPEN })
        .expect(400);
    });
  });

  describe('resolving', () => {
    beforeEach(async () => {
      await request(app.getHttpServer())
        .post(`/issues/${issueId}/claim`)
        .set(auth(volunteerToken))
        .expect(200);
    });

    it('refuses with no proof photo', async () => {
      await request(app.getHttpServer())
        .post(`/issues/${issueId}/resolution`)
        .set(auth(volunteerToken))
        .send({ note: 'Trust me' })
        .expect(400);
    });

    it('refuses with no note', async () => {
      await attachProof(volunteerToken).expect(201);

      await request(app.getHttpServer())
        .post(`/issues/${issueId}/resolution`)
        .set(auth(volunteerToken))
        .send({})
        .expect(400);
    });

    it('refuses a non-holder', async () => {
      await attachProof(volunteerToken).expect(201);

      await request(app.getHttpServer())
        .post(`/issues/${issueId}/resolution`)
        .set(auth(otherToken))
        .send({ note: 'Not mine' })
        .expect(403);
    });

    // Proof is read by author, so a previous volunteer's evidence does not
    // satisfy the next one's resolution.
    it('does not count proof left behind by a previous volunteer', async () => {
      await attachProof(volunteerToken).expect(201);

      await request(app.getHttpServer())
        .delete(`/issues/${issueId}/claim`)
        .set(auth(volunteerToken))
        .expect(200);

      await request(app.getHttpServer())
        .post(`/issues/${issueId}/claim`)
        .set(auth(otherToken))
        .expect(200);

      await request(app.getHttpServer())
        .post(`/issues/${issueId}/resolution`)
        .set(auth(otherToken))
        .send({ note: 'Someone else did this' })
        .expect(400);
    });
  });

  describe('media purpose', () => {
    it('marks the reporter\'s photos REPORT and the holder\'s PROOF', async () => {
      const reportPhoto = await request(app.getHttpServer())
        .post(`/issues/${issueId}/media`)
        .set(auth(reporterToken))
        .attach('file', PIXEL, { filename: 'before.png', contentType: 'image/png' })
        .expect(201);
      expect(reportPhoto.body.purpose).toBe(MediaPurpose.REPORT);

      await request(app.getHttpServer())
        .post(`/issues/${issueId}/claim`)
        .set(auth(volunteerToken))
        .expect(200);

      const proofPhoto = await attachProof(volunteerToken).expect(201);
      expect(proofPhoto.body.purpose).toBe(MediaPurpose.PROOF);
    });

    it('refuses the reporter once the issue is claimed', async () => {
      await request(app.getHttpServer())
        .post(`/issues/${issueId}/claim`)
        .set(auth(volunteerToken))
        .expect(200);

      await request(app.getHttpServer())
        .post(`/issues/${issueId}/media`)
        .set(auth(reporterToken))
        .attach('file', PIXEL, { filename: 'x.png', contentType: 'image/png' })
        .expect(403);
    });
  });

  describe('the agency verdict', () => {
    beforeEach(async () => {
      await request(app.getHttpServer())
        .post(`/issues/${issueId}/claim`)
        .set(auth(volunteerToken))
        .expect(200);
      await attachProof(volunteerToken).expect(201);
      await request(app.getHttpServer())
        .post(`/issues/${issueId}/resolution`)
        .set(auth(volunteerToken))
        .send({ note: 'Done' })
        .expect(200);
    });

    it('sends work back with a reason, keeping the holder', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/issues/${issueId}/status`)
        .set(auth(agencyToken))
        .send({ status: IssueStatus.IN_PROGRESS, reason: 'Still blocked' })
        .expect(200);

      expect(res.body.status).toBe(IssueStatus.IN_PROGRESS);
      expect(res.body.volunteerId).toEqual(expect.any(String));
    });

    it('refuses a citizen verifying', async () => {
      await request(app.getHttpServer())
        .patch(`/issues/${issueId}/status`)
        .set(auth(volunteerToken))
        .send({ status: IssueStatus.VERIFIED })
        .expect(403);
    });

    it('refuses an agency setting RESOLVED directly, which would skip the evidence rule', async () => {
      await request(app.getHttpServer())
        .patch(`/issues/${issueId}/status`)
        .set(auth(agencyToken))
        .send({ status: IssueStatus.IN_PROGRESS, reason: 'back' })
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/issues/${issueId}/status`)
        .set(auth(agencyToken))
        .send({ status: IssueStatus.RESOLVED })
        .expect(403);
    });
  });

  describe('filtering', () => {
    it('lists the issues a volunteer is working on', async () => {
      const claimed = await request(app.getHttpServer())
        .post(`/issues/${issueId}/claim`)
        .set(auth(volunteerToken))
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(`/issues?volunteerId=${claimed.body.volunteerId}`)
        .expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(issueId);
    });
  });
});
```

- [ ] **Step 2: Run the suite**

```bash
docker compose up -d
npm run test:e2e
```

Expected: PASS, all suites.

- [ ] **Step 3: Commit**

```bash
npm run format && npm run lint
git add test/issue-claim.e2e-spec.ts
git commit -m "Add claim and resolution e2e coverage"
```

---

### Task 7: Seed, documentation and Postman

**Files:**
- Modify: `src/seed.ts`
- Modify: `README.md`
- Modify: `postman/civicon-auth.postman_collection.json`

**Interfaces:**
- Consumes: every route from Tasks 2-5.
- Produces: nothing.

- [ ] **Step 1: Seed one claimed issue**

The demo should open with an issue already in flight, not only OPEN ones. In
`src/seed.ts`, after the issue `bulkWrite` and the sample photo, add:

```ts
    // Put one issue in CLAIMED so the demo opens mid-arc rather than with
    // everything untouched. Uses the lifecycle service rather than writing
    // status directly — that invariant holds in the seed too.
    const lifecycle = app.get(IssueLifecycleService);
    const [toClaim] = await issueModel
      .find({ title: SAMPLE_ISSUES[2].title })
      .exec();
    const volunteer = usersByEmail.get('volunteer@civicon.test');

    if (toClaim && volunteer && toClaim.status === IssueStatus.OPEN) {
      await lifecycle.claim(toClaim._id.toString(), volunteer.toString());
      report(`claimed "${toClaim.title}" for the volunteer account`);
    }
```

`SAMPLE_ISSUES[2]` is the pothole, reported by `volunteer@civicon.test` — so
claim it with a different account. **Check which account reports it** and pick a
citizen who did not; if the reporter and the claimer match, the seed will throw
a `ForbiddenException`, which is the anti-self-dealing rule working. Use
`citizen@civicon.test` if so.

Import `IssueLifecycleService` and `IssueStatus`.

- [ ] **Step 2: Verify the seed both ways**

```bash
npm run seed -- --fresh
npm run seed
```

Expected: the first run reports the claim; the second skips it, because the
issue is no longer `OPEN`.

- [ ] **Step 3: Document the lifecycle**

In `README.md`, inside `## Issues`, before `### Media`, add:

````markdown
### Claiming and resolving

A citizen other than the reporter takes an issue on, does the work, submits
evidence, and an agency confirms it.

| Route | Access |
|---|---|
| `POST /issues/:id/claim` | any `CITIZEN` except the reporter |
| `DELETE /issues/:id/claim` | the holder — returns it to `OPEN` |
| `POST /issues/:id/start` | the holder — `CLAIMED` → `IN_PROGRESS` |
| `POST /issues/:id/resolution` | the holder — needs a note and ≥1 proof photo |
| `PATCH /issues/:id/status` | `AGENCY`/`ADMIN` — verify, send back, or force-release |

```
OPEN ──claim──▶ CLAIMED ──start──▶ IN_PROGRESS ──resolve──▶ RESOLVED ──verify──▶ VERIFIED
  ▲                │                     │                      │
  └────── release / force-release ───────┘         send back ───┘
```

`IN_PROGRESS` is optional — a volunteer may resolve straight from `CLAIMED`.

**A reporter cannot claim their own issue** (403). That is the anti-self-dealing
rule: once civic points exist, reporting and resolving the same issue would be a
way to pay yourself.

Photos carry a `purpose` derived from the issue's state, never from the request:
uploaded while `OPEN` they are `REPORT`, uploaded by the holder they are
`PROOF`. Resolution counts only proof uploaded by the **current** holder, so
evidence left behind by a volunteer who released the claim does not count.

An agency cannot set `RESOLVED` directly — that would walk around the evidence
requirement — nor `CLAIMED`, which needs a volunteer the route cannot name.
````

- [ ] **Step 4: Add a Postman folder**

Add a folder `Issue lifecycle`, after `Issue media`, whose requests run in order
against a freshly seeded database. Each asserts its status code in the style of
the existing folders:

1. **Sign in as the volunteer** — `POST /auth/login` with
   `volunteer@civicon.test`; store `volunteer_token`. Test: 200.
2. **Find an open issue** — `GET /issues?status=OPEN&limit=1`, noauth; store
   `lifecycle_issue_id`. Test: 200 and the array is non-empty.
3. **Claim it** — `POST /issues/{{lifecycle_issue_id}}/claim`, bearer
   `{{volunteer_token}}`. Test: 200 and `status` is `CLAIMED`.
4. **The reporter cannot claim** — same route, bearer `{{citizen_token}}`. Test:
   403. (Add a description noting this passes only when the seeded issue was
   reported by `citizen@civicon.test`.)
5. **Start work** — `POST /issues/{{lifecycle_issue_id}}/start`, bearer
   `{{volunteer_token}}`. Test: 200 and `status` is `IN_PROGRESS`.
6. **Resolve without proof is refused** — `POST /issues/{{lifecycle_issue_id}}/resolution`
   with `{"note": "Trust me"}`. Test: 400.
7. **Release it** — `DELETE /issues/{{lifecycle_issue_id}}/claim`, bearer
   `{{volunteer_token}}`. Test: 200, `status` is `OPEN`, and `volunteerId` is
   absent.

Add `volunteer_token` and `lifecycle_issue_id` collection variables. The
resolution step stops at the 400 deliberately: attaching proof needs a file
selected in the UI, which a CLI run cannot supply.

- [ ] **Step 5: Verify the collection still runs**

```bash
docker compose up -d && npm run seed -- --fresh && npm run build
node dist/main.js &
postman collection run postman/civicon-auth.postman_collection.json \
  -e postman/civicon-local.postman_environment.json
```

Expected: 0 failed assertions.

- [ ] **Step 6: Full verification**

```bash
npm run format && npm run lint
npm run build
npm run test
npm run test:e2e
```

Expected: all clean, all passing.

- [ ] **Step 7: Commit**

```bash
git add src/seed.ts README.md postman
git commit -m "Seed a claimed issue and document the lifecycle"
```
