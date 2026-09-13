import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import mongoose from 'mongoose';

const DUPLICATE_KEY = 11000;

/**
 * Translates raw driver/ODM errors into proper HTTP responses. Without this
 * they surface as opaque 500s:
 *   - a malformed ObjectId -> CastError
 *   - a unique-index collision -> MongoServerError code 11000
 */
@Catch(
  mongoose.Error.CastError,
  mongoose.Error.ValidationError,
  mongoose.mongo.MongoServerError,
)
export class MongoExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(MongoExceptionFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();

    const { status, message } = this.describe(exception);

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(exception);
    }

    httpAdapter.reply(
      ctx.getResponse(),
      {
        statusCode: status,
        message,
        error: HttpStatus[status]
          .split('_')
          .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
          .join(' '),
      },
      status,
    );
  }

  private describe(exception: unknown): { status: number; message: string } {
    if (exception instanceof mongoose.Error.CastError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        message: `Invalid value "${String(exception.value)}" for field "${exception.path}"`,
      };
    }

    if (exception instanceof mongoose.Error.ValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        message: Object.values(exception.errors)
          .map((error) => error.message)
          .join(', '),
      };
    }

    if (
      exception instanceof mongoose.mongo.MongoServerError &&
      exception.code === DUPLICATE_KEY
    ) {
      // keyValue looks like { email: 'ada@example.com' }
      const fields = Object.keys(exception.keyValue ?? {}).join(', ');
      return {
        status: HttpStatus.CONFLICT,
        message: fields
          ? `A record with this ${fields} already exists`
          : 'A record with these values already exists',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    };
  }
}
