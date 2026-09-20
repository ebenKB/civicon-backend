import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import {
  AiOutcome,
  HazardAnswer,
  HazardLevel,
  HazardSource,
  IssueCategory,
  IssueStatus,
} from '../../contracts/index.js';
// `import type`: AiAssessment and HazardAssessment appear in decorated signatures, which
// isolatedModules + emitDecoratorMetadata require to be erased. Other imports above
// stay as value imports because Object.values() needs them at runtime.
import type { AiAssessment, HazardAssessment } from '../../contracts/index.js';

export type IssueDocument = HydratedDocument<Issue>;

@Schema({
  timestamps: true,
  toJSON: {
    virtuals: true,
    versionKey: false,
    transform: (_doc, ret: Record<string, unknown>) => {
      ret.id = ret._id;
      delete ret._id;
      return ret;
    },
  },
})
export class Issue {
  @Prop({ required: true, trim: true, maxlength: 140 })
  title: string;

  @Prop({ required: true, trim: true, maxlength: 2000 })
  description: string;

  // Explicit `type` is required: TypeScript emits `Object` as the design:type
  // metadata for an enum-typed property, so without it Mongoose reads this
  // options object itself as a nested path definition and throws.
  @Prop({ type: String, required: true, enum: Object.values(IssueCategory) })
  category: IssueCategory;

  // Free text: a landmark or address. Geospatial coordinates are a later,
  // additive change — see the design doc's Risks table.
  @Prop({ required: true, trim: true, maxlength: 200 })
  location: string;

  // Written by IssueLifecycleService and nowhere else. Creation takes this
  // default rather than passing a value.
  @Prop({
    type: String,
    required: true,
    enum: Object.values(IssueStatus),
    default: IssueStatus.OPEN,
    index: true,
  })
  status: IssueStatus;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  })
  reportedBy: Types.ObjectId;

  @Prop({ trim: true, maxlength: 500 })
  statusReason?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Issue' })
  duplicateOf?: Types.ObjectId;

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

  /**
   * What the AI made of the volunteer's evidence. Absent when the feature is
   * off, which is how an issue resolved without a configured key looks exactly
   * as it did before this slice.
   */
  @Prop({
    type: {
      outcome: { type: String, enum: Object.values(AiOutcome) },
      confidence: Number,
      reasoning: String,
      model: String,
      assessedAt: Date,
    },
    _id: false,
  })
  aiAssessment?: AiAssessment;

  /**
   * Whether a volunteer may take this on. Written only by IssueHazardService
   * and the hazard route, the same way status belongs to IssueLifecycleService.
   */
  @Prop({
    type: String,
    required: true,
    enum: Object.values(HazardLevel),
    default: HazardLevel.UNCLASSIFIED,
    index: true,
  })
  hazard: HazardLevel;

  @Prop({
    type: {
      level: { type: String, enum: Object.values(HazardLevel), required: true },
      source: {
        type: String,
        enum: Object.values(HazardSource),
        required: true,
      },
      confidence: { type: Number },
      reasoning: { type: String },
      model: { type: String },
      decidedBy: { type: String },
      assessedAt: { type: Date, required: true },
    },
    _id: false,
  })
  hazardAssessment?: HazardAssessment;

  /** Question ids the reporter ticked when reporting. Escalate-only. */
  @Prop({ type: [String], default: [] })
  observations: string[];

  /** Question ids sent to the reporter and not yet answered or superseded. */
  @Prop({ type: [String] })
  pendingQuestions?: string[];

  @Prop({
    type: [
      {
        questionId: { type: String, required: true },
        answer: {
          type: String,
          enum: Object.values(HazardAnswer),
          required: true,
        },
      },
    ],
    _id: false,
  })
  answers?: { questionId: string; answer: HazardAnswer }[];

  /**
   * The agency user who recorded a fix on a restricted issue. Distinct from
   * volunteerId: it pays no points, and it is the other identity that may not
   * confirm its own work.
   */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  agencyResolverId?: Types.ObjectId;

  // Supplied by `timestamps: true`. Declared without @Prop so they are typed on
  // the document without being redeclared as schema paths.
  createdAt: Date;
  updatedAt: Date;
}

export const IssueSchema = SchemaFactory.createForClass(Issue);

// Serves the default listing: newest first, usually filtered by status.
IssueSchema.index({ status: 1, createdAt: -1 });

// Serves the agency's review queue: everything not APPROVED needs a human.
IssueSchema.index({ 'aiAssessment.outcome': 1 });
