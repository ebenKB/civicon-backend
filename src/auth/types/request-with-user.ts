import { Request } from 'express';
import { AuthenticatedUser } from './jwt-payload.js';

export interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
}
