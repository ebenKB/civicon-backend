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
const CLASSIFIER_INPUT_FIELDS = [
  'title',
  'description',
  'category',
  'location',
] as const;

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
    // verdict describes the title/description/category/location the
    // classifier actually read; once the reporter edits any of them it is
    // about an issue that no longer exists, and leaving it in place would
    // let "streetlight cover loose" clear as UNRESTRICTED and then be
    // rewritten to describe a live, sparking cable. This only ever moves
    // `hazard` back to UNCLASSIFIED, so the decision itself stays owned by
    // IssueHazardService and the reporter must submit again.
    //
    // Only ever from the claimable state. An edit must be able to take an
    // issue OUT of clearance, but never out of a restriction: a reporter who
    // could wipe an agency's RESTRICTED ruling by changing one word would
    // then resubmit and take their chances with the model. NEEDS_REVIEW is
    // left alone too — it is sitting in an agency queue, and resetting it
    // would quietly drop it out of that queue; whoever picks it up reads the
    // text as it stands then.
    if (inputsChanged && issue.hazard === HazardLevel.UNRESTRICTED) {
      issue.hazard = HazardLevel.UNCLASSIFIED;
      issue.hazardAssessment = undefined;
      issue.pendingQuestions = undefined;
      issue.answers = undefined;
    }

    return issue.save();
  }

  /**
   * New report evidence landed, so any clearance the classifier gave is about
   * an issue that no longer exists. One atomic write, filtered on the
   * claimable state, for the same reason `updateIfMatches` exists: the caller
   * read this document before a long GridFS transfer, and a human decision
   * can land in between. Filtering on UNRESTRICTED means a concurrent
   * RESTRICTED simply stands — the reset can only ever remove a clearance,
   * never overwrite a restriction.
   *
   * `updatedAt` is bumped either way, including when there was nothing to
   * clear: IssueHazardService.submit() guards on it, so a photo added while
   * classify() is still awaiting the model has to move it for that guard to
   * catch the race.
   */
  async registerNewReportEvidence(id: string): Promise<void> {
    const _id = new Types.ObjectId(id);
    const now = new Date();

    const cleared = await this.issueModel
      .updateOne(
        { _id, hazard: HazardLevel.UNRESTRICTED },
        {
          $set: { hazard: HazardLevel.UNCLASSIFIED, updatedAt: now },
          $unset: { hazardAssessment: '', pendingQuestions: '', answers: '' },
        },
        { timestamps: false },
      )
      .exec();

    if (cleared.modifiedCount === 0) {
      await this.issueModel
        .updateOne({ _id }, { $set: { updatedAt: now } }, { timestamps: false })
        .exec();
    }
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
      .findOneAndUpdate({ _id: new Types.ObjectId(id), ...expected }, update, {
        returnDocument: 'after',
      })
      .exec();
  }
}
