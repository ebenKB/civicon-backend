import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { IssueCategory, IssueStatus } from '../../contracts/index.js';

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

  @Prop({ required: true, enum: Object.values(IssueCategory) })
  category: IssueCategory;

  // Free text: a landmark or address. Geospatial coordinates are a later,
  // additive change — see the design doc's Risks table.
  @Prop({ required: true, trim: true, maxlength: 200 })
  location: string;

  // Written by IssueLifecycleService and nowhere else. Creation takes this
  // default rather than passing a value.
  @Prop({
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

  // Supplied by `timestamps: true`. Declared without @Prop so they are typed on
  // the document without being redeclared as schema paths.
  createdAt: Date;
  updatedAt: Date;
}

export const IssueSchema = SchemaFactory.createForClass(Issue);

// Serves the default listing: newest first, usually filtered by status.
IssueSchema.index({ status: 1, createdAt: -1 });
