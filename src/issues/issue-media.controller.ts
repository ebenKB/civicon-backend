import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile as UploadedFileParam,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Public } from '../auth/decorators/public.decorator.js';
// `import type` is required: isolatedModules + emitDecoratorMetadata forbid a
// value import for a type referenced in a decorated signature.
import type { AuthenticatedUser } from '../auth/types/jwt-payload.js';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe.js';
import { MAX_UPLOAD_BYTES } from '../contracts/index.js';
import { IssueMediaService } from './issue-media.service.js';
import type { UploadedFile } from './issue-media.types.js';

@Controller('issues')
export class IssueMediaController {
  constructor(private readonly issueMediaService: IssueMediaService) {}

  /**
   * No @Roles(): ownership is the requirement, and the service enforces it.
   *
   * multer's limits.fileSize takes a single number, so it carries the larger
   * of the two caps and aborts parsing past it — a 415 or 413 for anything
   * smaller comes from the service, once the type is known.
   */
  @Post(':id/media')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  upload(
    @Param('id', ParseObjectIdPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFileParam() file: UploadedFile,
  ) {
    if (!file) {
      throw new BadRequestException('A file is required, in the "file" field');
    }
    return this.issueMediaService.upload(id, user.id, file);
  }

  @Public()
  @Get(':id/media')
  listFor(@Param('id', ParseObjectIdPipe) id: string) {
    return this.issueMediaService.listFor(id);
  }
}
