import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { Role } from '../../contracts/index.js';

export type UserDocument = HydratedDocument<User>;

@Schema({
  timestamps: true,
  toJSON: {
    virtuals: true,
    versionKey: false,
    transform: (_doc, ret: Record<string, unknown>) => {
      ret.id = ret._id;
      delete ret._id;
      // Second line of defence. `select: false` already keeps the hash out of
      // every query that does not explicitly ask for it; this makes a leak
      // impossible even if some future code does ask.
      delete ret.passwordHash;
      return ret;
    },
  },
})
export class User {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  // Never returned by a plain find(); only `.select('+passwordHash')` retrieves
  // it, and that appears in exactly one place (UsersService.findByEmailWithPassword).
  @Prop({ required: true, select: false })
  passwordHash: string;

  @Prop({
    type: [String],
    enum: Object.values(Role),
    default: [Role.CITIZEN],
  })
  roles: Role[];

  // A cache, per execution guide §4.3: the truth is the sum of
  // point_transactions. Nothing in the auth slice writes to it.
  @Prop({ default: 0 })
  civicPointsCached: number;

  @Prop({ default: 100 })
  reputation: number;

  @Prop({ default: true })
  isActive: boolean;
}

export const UserSchema = SchemaFactory.createForClass(User);
