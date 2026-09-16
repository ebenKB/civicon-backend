import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { IssueStatus } from '../contracts/index.js';
import { ChangeStatusDto } from './dto/change-status.dto.js';
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
    [IssueStatus.RESOLVED, [IssueStatus.VERIFIED, IssueStatus.IN_PROGRESS]],
  ]);

/**
 * The single place an issue's status changes. Keeping it out of IssuesService
 * means the rules are unit-testable without a database, and the later slices'
 * lock and anti-self-dealing checks have an obvious home.
 */
@Injectable()
export class IssueLifecycleService {
  constructor(private readonly issuesService: IssuesService) {}

  async changeStatus(id: string, dto: ChangeStatusDto): Promise<IssueDocument> {
    const issue = await this.issuesService.findOne(id);

    const allowed = ALLOWED_TRANSITIONS.get(issue.status) ?? [];
    // A move to the current status is refused rather than ignored: silently
    // accepting it would hide a client bug.
    if (!allowed.includes(dto.status)) {
      throw new ConflictException(
        `Cannot move an issue from ${issue.status} to ${dto.status}`,
      );
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

    issue.status = dto.status;
    issue.statusReason = dto.reason;
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
}
