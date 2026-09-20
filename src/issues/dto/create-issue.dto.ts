import { ArrayUnique, IsArray, IsEnum, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { IssueCategory, observationIds } from '../../contracts/index.js';

/**
 * Four fields, and deliberately no `status` or `reportedBy`. Both are derived
 * by the server — a payload carrying either is rejected as an unknown property
 * by the global forbidNonWhitelisted pipe, so there is no gate to get wrong.
 */
export class CreateIssueDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(140)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  description: string;

  @IsEnum(IssueCategory)
  category: IssueCategory;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  location: string;

  /**
   * What the reporter says they could see. Only the checkbox entries of the
   * question bank: a follow-up id here would mean the client invented a
   * question nobody asked.
   */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(observationIds(), { each: true })
  observations?: string[];
}
