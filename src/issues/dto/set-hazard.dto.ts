import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { HazardLevel } from '../../contracts/index.js';

export class SetHazardDto {
  /**
   * Only the two decided values. NEEDS_REVIEW and UNCLASSIFIED are states the
   * system arrives at, never ones a person chooses: a human decision is a
   * decision.
   */
  @IsIn([HazardLevel.RESTRICTED, HazardLevel.UNRESTRICTED])
  level: HazardLevel;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
