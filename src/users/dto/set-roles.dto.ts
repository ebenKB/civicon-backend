import { ArrayNotEmpty, IsArray, IsEnum } from 'class-validator';
import { Role } from '../../contracts/index.js';

export class SetRolesDto {
  // The full enum, not PUBLIC_ROLES: this is the admin-only path by which
  // AGENCY, SPONSOR and ADMIN accounts come into existence.
  // Non-empty because a roleless user could log in and do nothing.
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(Role, { each: true })
  roles: Role[];
}
