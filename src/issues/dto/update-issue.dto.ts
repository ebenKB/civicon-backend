import { PartialType } from '@nestjs/mapped-types';
import { CreateIssueDto } from './create-issue.dto.js';

/** Same four editable fields, all optional. Status is not among them. */
export class UpdateIssueDto extends PartialType(CreateIssueDto) {}
