import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { IssueStatus } from '../contracts/index.js';
import { ChangeStatusDto } from './dto/change-status.dto.js';
import { IssuesService } from './issues.service.js';
import { IssueDocument } from './schemas/issue.schema.js';

/**
 * The transition table. Only moves out of OPEN exist in the reporting slice;
 * claiming and resolution add the rest without touching anything else here.
 */
const ALLOWED_TRANSITIONS: ReadonlyMap<IssueStatus, readonly IssueStatus[]> =
  new Map([[IssueStatus.OPEN, [IssueStatus.REJECTED, IssueStatus.DUPLICATE]]]);

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
}
