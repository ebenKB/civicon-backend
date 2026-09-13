import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opts a route out of authentication entirely. It short-circuits before any
 * token parsing, so `request.user` is undefined on a public route even when a
 * caller supplies a valid token.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
