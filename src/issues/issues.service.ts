import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, QueryFilter, Types, UpdateQuery } from 'mongoose';
import { HazardLevel, IssueStatus } from '../contracts/index.js';
import { CreateIssueDto } from './dto/create-issue.dto.js';
import { ListIssuesQuery } from './dto/list-issues.query.js';
import { UpdateIssueDto } from './dto/update-issue.dto.js';
import { Issue, IssueDocument } from './schemas/issue.schema.js';

const DEFAULT_LIMIT = 20;

/** The fields a hazard verdict is actually about. Anything else — an edit
 * touching only, say, `observations` if that were ever re-added — would not
 * make an existing classification stale. */
const CLASSIFIER_INPUT_FIELDS = ['title', 'description', 'category', 'location'] as const;

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
    if (query.volunteerId) {
      filter.volunteerId = new Types.ObjectId(query.volunteerId);
    }
    if (query.aiOutcome) {
      filter['aiAssessment.outcome'] = query.aiOutcome;
    }
    if (query.hazard) {
      filter.hazard = query.hazard;
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

    const before = CLASSIFIER_INPUT_FIELDS.map((field) => issue[field]);
    Object.assign(issue, dto);
    const inputsChanged = CLASSIFIER_INPUT_FIELDS.some(
      (field, i) => issue[field] !== before[i],
    );

    // Exception to the rule that only IssueHazardService (and the hazard
    // route) write `hazard` — see the schema comment on that field. A
    // classification describes the title/description/category/location the
    // classifier actually read; once the reporter edits any of them, that
    // verdict is about an issue that no longer exists, and leaving it in
    // place would let "streetlight cover loose" clear as UNRESTRICTED and
    // then be silently rewritten to describe a live, sparking cable. This
    // only ever moves `hazard` back to UNCLASSIFIED — it never assigns a
    // level — so the actual classification decision stays owned by
    // IssueHazardService; the reporter must submit for classification again.
    if (inputsChanged && issue.hazard !== HazardLevel.UNCLASSIFIED) {
      issue.hazard = HazardLevel.UNCLASSIFIED;
      issue.hazardAssessment = undefined;
      issue.pendingQuestions = undefined;
      issue.answers = undefined;
    }

    return issue.save();
  }

  /**
   * A guarded write for a caller whose read and write straddle an async gap
   * — an AI call that can take up to a minute, during which a human can act.
   * `expected` is merged into the id filter, so the update applies only if
   * the document still looks the way it did when the caller started; this is
   * a single atomic `findOneAndUpdate`, not a read-then-write, so there is no
   * gap of its own for a second race to land in. Returns null, rather than
   * throwing, when the filter no longer matches — the caller decides what
   * that means (typically a 409: something else decided first).
   */
  updateIfMatches(
    id: string,
    expected: QueryFilter<IssueDocument>,
    update: UpdateQuery<IssueDocument>,
  ): Promise<IssueDocument | null> {
    return this.issueModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(id), ...expected },
        update,
        { returnDocument: 'after' },
      )
      .exec();
  }
}
