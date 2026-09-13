import {
  IsEnum,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IssueStatus } from '../../contracts/index.js';

/**
 * `reason` and `duplicateOf` are conditionally required, and that condition is
 * enforced in IssueLifecycleService rather than here: which one is needed
 * depends on the target status, and duplicateOf additionally needs a database
 * read to confirm the referenced issue exists.
 */
export class ChangeStatusDto {
  @IsEnum(IssueStatus)
  status: IssueStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsMongoId()
  duplicateOf?: string;
}
