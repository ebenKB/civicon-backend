import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsMongoId,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import {
  AiOutcome,
  HazardLevel,
  IssueCategory,
  IssueStatus,
} from '../../contracts/index.js';

export class ListIssuesQuery {
  @IsOptional()
  @IsEnum(IssueStatus)
  status?: IssueStatus;

  @IsOptional()
  @IsEnum(IssueCategory)
  category?: IssueCategory;

  @IsOptional()
  @IsMongoId()
  reportedBy?: string;

  @IsOptional()
  @IsMongoId()
  volunteerId?: string;

  /** The agency's review queue: anything not APPROVED needs a human. */
  @IsOptional()
  @IsEnum(AiOutcome)
  aiOutcome?: AiOutcome;

  /** The hazard queue: the unsure ones, and the reports never submitted. */
  @IsOptional()
  @IsEnum(HazardLevel)
  hazard?: HazardLevel;

  // Query parameters arrive as strings and enableImplicitConversion is off, so
  // @Type is what makes @IsInt meaningful here.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
