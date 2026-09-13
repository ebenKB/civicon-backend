import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { IssueCategory } from '../../contracts/index.js';

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
}
