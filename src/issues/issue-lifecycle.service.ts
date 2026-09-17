import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { AiOutcome, IssueStatus } from '../contracts/index.js';
import { CivicPointsService } from '../points/civic-points.service.js';
import { ChangeStatusDto } from './dto/change-status.dto.js';
import { ResolveIssueDto } from './dto/resolve-issue.dto.js';
import { IssueMediaService } from './issue-media.service.js';
import { IssueVerificationService } from './issue-verification.service.js';
import { IssuesService } from './issues.service.js';
import { IssueDocument } from './schemas/issue.schema.js';

/**
 * Which statuses each status may move to. Actor rules live in the methods
 * below: the same move is legal for different people depending on intent — a
 * holder releasing and an agency forcing a release both go CLAIMED -> OPEN.
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
    [
      IssueStatus.RESOLVED,
      [IssueStatus.VERIFIED, IssueStatus.IN_PROGRESS, IssueStatus.AI_APPROVED],
    ],
    [IssueStatus.AI_APPROVED, [IssueStatus.VERIFIED, IssueStatus.IN_PROGRESS]],
    // The only way out of VERIFIED, and only an agency has it. An auto-approval
    // becomes a payout once civic points exist, so the model's mistakes must be
    // undoable.
    [IssueStatus.VERIFIED, [IssueStatus.IN_PROGRESS]],
  ]);

// Note this yields 403, not the 409 an illegal transition gives: the move may
// be legal, just not for this actor.
//
// RESOLVED is absent on purpose — it requires evidence, and an agency setting
// it directly would walk around that. CLAIMED is absent because a claim needs a
// volunteer, which this route has no way to name.
const AGENCY_TARGETS: readonly IssueStatus[] = [
  IssueStatus.VERIFIED,
  IssueStatus.IN_PROGRESS,
  IssueStatus.OPEN,
  IssueStatus.REJECTED,
  IssueStatus.DUPLICATE,
];

/**
 * The single place an issue's status changes. Keeping it out of IssuesService
 * means the rules are unit-testable without a database, and the later slices'
 * lock and anti-self-dealing checks have an obvious home.
 */
@Injectable()
export class IssueLifecycleService {
  private readonly logger = new Logger(IssueLifecycleService.name);

  constructor(
    private readonly issuesService: IssuesService,
    private readonly issueMediaService: IssueMediaService,
    private readonly issueVerificationService: IssueVerificationService,
    private readonly civicPointsService: CivicPointsService,
  ) {}

  async changeStatus(
    id: string,
    dto: ChangeStatusDto,
    actorId: string,
  ): Promise<IssueDocument> {
    const issue = await this.issuesService.findOne(id);

    // Captured before the reassignment below: by the time points are settled,
    // issue.status is already the new value.
    const wasVerified = issue.status === IssueStatus.VERIFIED;

    if (!AGENCY_TARGETS.includes(dto.status)) {
      throw new ForbiddenException(
        `An agency cannot set an issue to ${dto.status}`,
      );
    }

    // A move to the current status is refused rather than ignored: silently
    // accepting it would hide a client bug.
    this.assertTransition(issue.status, dto.status);

    // No one may verify their own work. Holds from both RESOLVED and
    // AI_APPROVED, and applies even to a volunteer who also holds the AGENCY
    // role. The reporter and the volunteer's own IN_PROGRESS/OPEN moves are
    // untouched — neither of those pays the actor.
    if (
      dto.status === IssueStatus.VERIFIED &&
      issue.volunteerId?.toString() === actorId
    ) {
      throw new ForbiddenException('You cannot verify work you did yourself');
    }

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

    if (dto.status === IssueStatus.REJECTED && !dto.reason) {
      throw new BadRequestException(
        'A reason is required when rejecting an issue',
      );
    }

    if (dto.status === IssueStatus.DUPLICATE) {
      if (!dto.duplicateOf) {
        throw new BadRequestException(
          'duplicateOf is required when marking an issue a duplicate',
        );
      }
      if (dto.duplicateOf === id) {
        throw new BadRequestException('An issue cannot duplicate itself');
      }
      // Throws NotFoundException if the referenced issue does not exist.
      await this.issuesService.findOne(dto.duplicateOf);
      issue.duplicateOf = new Types.ObjectId(dto.duplicateOf);
    }

    if (dto.status === IssueStatus.VERIFIED) {
      issue.verifiedAt = new Date();
    }

    if (dto.status === IssueStatus.IN_PROGRESS) {
      // Sent back for more work, or an approval reversed: the same volunteer
      // keeps it either way. aiAssessment is left alone — what the model said,
      // and got wrong, is worth keeping.
      issue.resolvedAt = undefined;
      issue.resolutionNote = undefined;
      issue.verifiedAt = undefined;
    }

    if (dto.status === IssueStatus.OPEN) {
      issue.statusReason = dto.reason;
      return this.returnToOpen(issue);
    }

    issue.status = dto.status;
    issue.statusReason = dto.reason;
    const saved = await issue.save();

    // Points follow the status, and never block it: a ledger failure must not
    // undo a decision an agency has already made.
    if (dto.status === IssueStatus.VERIFIED) {
      await this.settlePoints('award', saved, () =>
        this.civicPointsService.awardForVerification(saved),
      );
    }

    if (dto.status === IssueStatus.IN_PROGRESS && wasVerified) {
      await this.settlePoints('reverse', saved, () =>
        this.civicPointsService.reverseForVerification(saved),
      );
    }

    return saved;
  }

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

    // undefined means the feature is off, in which case the issue simply waits
    // for an agency exactly as it did before this slice.
    const assessment = await this.issueVerificationService.assess(issue);
    if (assessment) {
      issue.aiAssessment = assessment;

      if (assessment.outcome === AiOutcome.APPROVED) {
        // The model recommends; it does not pay. An agency confirms before
        // anything reaches VERIFIED, which is where points are awarded.
        issue.status = IssueStatus.AI_APPROVED;
      }
    }

    return issue.save();
  }
  private assertTransition(from: IssueStatus, to: IssueStatus): void {
    const allowed = ALLOWED_TRANSITIONS.get(from) ?? [];
    if (!allowed.includes(to)) {
      throw new ConflictException(`Cannot move an issue from ${from} to ${to}`);
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

    // Checked before the transition so a second claimer gets a message about
    // the conflict rather than "cannot move from CLAIMED to CLAIMED".
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

  /**
   * Runs a points-ledger write and never lets it undo or block the status
   * change that already happened. A failure is logged with enough context
   * — the issue, the volunteer, and which direction — to repair by hand;
   * there is no automatic reconciliation.
   */
  private async settlePoints(
    direction: 'award' | 'reverse',
    issue: IssueDocument,
    work: () => Promise<void>,
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Points ${direction} failed for issue ${issue._id} (volunteer ${issue.volunteerId}): ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
