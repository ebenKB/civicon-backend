import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, QueryFilter, Types } from 'mongoose';
import { IssueStatus } from '../contracts/index.js';
import { CreateIssueDto } from './dto/create-issue.dto.js';
import { ListIssuesQuery } from './dto/list-issues.query.js';
import { UpdateIssueDto } from './dto/update-issue.dto.js';
import { Issue, IssueDocument } from './schemas/issue.schema.js';

const DEFAULT_LIMIT = 20;

/**
 * Persistence and queries for issues. This service never changes `status` —
 * that belongs to IssueLifecycleService, which is the single write path for it.
 */
@Injectable()
export class IssuesService {
  constructor(
    @InjectModel(Issue.name) private readonly issueModel: Model<IssueDocument>,
  ) {}

  create(reporterId: string, dto: CreateIssueDto): Promise<IssueDocument> {
    // reportedBy comes from the authenticated caller; no status is passed, so
    // the schema default (OPEN) applies.
    return this.issueModel.create({
      ...dto,
      reportedBy: new Types.ObjectId(reporterId),
    });
  }

  findAll(query: ListIssuesQuery): Promise<IssueDocument[]> {
    const filter: QueryFilter<IssueDocument> = {};
    if (query.status) {
      filter.status = query.status;
    }
    if (query.category) {
      filter.category = query.category;
    }
    if (query.reportedBy) {
      filter.reportedBy = new Types.ObjectId(query.reportedBy);
    }

    return this.issueModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(query.offset ?? 0)
      .limit(query.limit ?? DEFAULT_LIMIT)
      .exec();
  }

  async findOne(id: string): Promise<IssueDocument> {
    const issue = await this.issueModel.findById(id).exec();
    if (!issue) {
      throw new NotFoundException(`Issue with id "${id}" not found`);
    }
    return issue;
  }
  /**
   * Ownership, not role, is the requirement — an admin editing someone else's
   * issue gets the same 403. Rewriting a citizen's account of what they saw is
   * not an administrative power; REJECTED is the recorded alternative.
   */
  async updateOwn(
    id: string,
    actorId: string,
    dto: UpdateIssueDto,
  ): Promise<IssueDocument> {
    const issue = await this.findOne(id);

    if (issue.reportedBy.toString() !== actorId) {
      throw new ForbiddenException('You can only edit issues you reported');
    }

    // An agency may already have acted on what it read.
    if (issue.status !== IssueStatus.OPEN) {
      throw new ConflictException(
        `An issue can only be edited while OPEN; this one is ${issue.status}`,
      );
    }

    Object.assign(issue, dto);
    return issue.save();
  }
}
