import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateIssueDto } from './create-issue.dto.js';

/**
 * Same four editable fields, all optional. Status is not among them, and
 * neither is `observations` any more: it is written once, at report time, and
 * escalates only. Letting a PATCH touch it would let a reporter tick an
 * observation and clear it again before ever submitting for classification —
 * OmitType removes the property from the class entirely, so the global
 * forbidNonWhitelisted pipe rejects an `observations` key in the body outright
 * rather than silently applying it.
 */
export class UpdateIssueDto extends PartialType(
  OmitType(CreateIssueDto, ['observations'] as const),
) {}
