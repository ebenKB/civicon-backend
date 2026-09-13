import { SetMetadata } from '@nestjs/common';
import { Role } from '../../contracts/index.js';

export const ROLES_KEY = 'roles';

/** The caller must hold at least one of these roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
