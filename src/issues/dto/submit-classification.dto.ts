import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { HazardAnswer, followUpIds } from '../../contracts/index.js';

export class HazardAnswerDto {
  @IsIn(followUpIds())
  questionId: string;

  @IsEnum(HazardAnswer)
  answer: HazardAnswer;
}

/**
 * The first call carries nothing. The second carries every pending question's
 * answer — which questions are pending is the server's business, so the body
 * is checked against what was actually asked.
 */
export class SubmitClassificationDto {
  @IsOptional()
  @IsArray()
  @ArrayUnique((a: HazardAnswerDto) => a.questionId)
  @ValidateNested({ each: true })
  @Type(() => HazardAnswerDto)
  answers?: HazardAnswerDto[];
}
