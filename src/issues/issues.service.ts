import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { CreateIssueDto } from './dto/create-issue.dto.js';
import { ListIssuesQuery } from './dto/list-issues.query.js';
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
    const filter: FilterQuery<IssueDocument> = {};
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
}
