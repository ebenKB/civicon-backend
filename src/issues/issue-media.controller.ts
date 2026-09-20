import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Headers,
  HttpStatus,
  Param,
  Post,
  HttpException,
  Res,
  UploadedFile as UploadedFileParam,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Public } from '../auth/decorators/public.decorator.js';
// `import type` is required: isolatedModules + emitDecoratorMetadata forbid a
// value import for a type referenced in a decorated signature.
import type { AuthenticatedUser } from '../auth/types/jwt-payload.js';
import { parseByteRange } from '../common/http/byte-range.js';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe.js';
import { MAX_UPLOAD_BYTES } from '../contracts/index.js';
import { IssueMediaService } from './issue-media.service.js';
import type { UploadedFile } from './issue-media.types.js';
import type { Response } from 'express';

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
    return this.issueMediaService.upload(id, user.id, file, user.roles);
  }

  @Public()
  @Get(':id/media')
  listFor(@Param('id', ParseObjectIdPipe) id: string) {
    return this.issueMediaService.listFor(id);
  }
  /**
   * Public, so a plain <img> or <video> tag can load it with no token.
   *
   * Sits outside the :id prefix deliberately: a GridFS id is globally unique,
   * and routing bytes through the parent issue would invite a mismatched pair.
   */
  @Public()
  @Get('media/:mediaId')
  async download(
    @Param('mediaId', ParseObjectIdPipe) mediaId: string,
    @Headers() headers: Record<string, string | undefined>,
    @Res() res: Response,
  ): Promise<void> {
    // The file's size is needed before a range can be judged, so the metadata
    // is fetched first and the stream re-opened only once the range is known.
    const whole = await this.issueMediaService.openDownload(mediaId);
    const requested = parseByteRange(headers.range, whole.size);

    if (requested === 'unsatisfiable') {
      // Nest ships no 416 exception class, only the status constant.
      throw new HttpException(
        `Range is not satisfiable for a file of ${whole.size} bytes`,
        HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
      );
    }

    const media = requested
      ? await this.issueMediaService.openDownload(mediaId, requested)
      : whole;

    const length = requested ? requested.end - requested.start + 1 : media.size;

    res.status(requested ? HttpStatus.PARTIAL_CONTENT : HttpStatus.OK).set({
      'Content-Type': media.contentType,
      'Content-Length': String(length),
      'Accept-Ranges': 'bytes',
      ...(requested
        ? {
            'Content-Range': `bytes ${requested.start}-${requested.end}/${media.size}`,
          }
        : {}),
    });

    media.stream.pipe(res);
  }
  @Delete('media/:mediaId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('mediaId', ParseObjectIdPipe) mediaId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.issueMediaService.remove(mediaId, user.id, user.roles);
  }
}
