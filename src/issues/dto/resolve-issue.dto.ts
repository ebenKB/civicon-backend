import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ResolveIssueDto {
  /** What the volunteer says they did. The proof photos are the evidence. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  note: string;
}
