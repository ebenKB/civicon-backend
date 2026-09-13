import { Role } from '../contracts/index.js';
import { UserDocument } from './schemas/user.schema.js';

/**
 * The user shape the API returns. Deliberately explicit: adding a field to the
 * schema must not silently widen what the API exposes.
 */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  roles: Role[];
  civicPointsCached: number;
  reputation: number;
}

export function toPublicUser(user: UserDocument): PublicUser {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    roles: user.roles,
    civicPointsCached: user.civicPointsCached,
    reputation: user.reputation,
  };
}
