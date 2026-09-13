import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Three fields, and deliberately no `roles`. Registration always creates a
 * CITIZEN.
 *
 * This is the structural form of the self-assignment gate: AGENCY, SPONSOR and
 * ADMIN cannot be requested because there is nothing to request them with. A
 * payload carrying `roles` is rejected as an unknown property by the global
 * forbidNonWhitelisted pipe — a 400 because the field does not exist, rather
 * than because a validator turned it down. There is no gate to get wrong.
 */
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
}
