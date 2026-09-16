import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsMongoId,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { IssueCategory, IssueStatus } from '../../contracts/index.js';

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
