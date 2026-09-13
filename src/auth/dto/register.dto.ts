import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PUBLIC_ROLES, Role } from '../../contracts/index.js';

export class RegisterDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;

  // bcrypt silently truncates past 72 bytes, so a longer password would have
  // meaningless trailing characters. Rejecting is more honest than truncating.
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;

  // Requesting AGENCY, SPONSOR or ADMIN fails here, before any service code
  // runs. Those roles come from the seed or from an admin grant.
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(PUBLIC_ROLES, { each: true })
  roles?: Role[];
}
