import { Role } from '../../contracts/index.js';

/** The claims carried by an access token. `sub` is the user id. */
export interface JwtPayload {
  sub: string;
  email: string;
  roles: Role[];
}

/** What the guards attach to `request.user`, built from the claims alone. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  roles: Role[];
}
