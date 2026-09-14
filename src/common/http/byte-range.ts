export interface ByteRange {
  start: number;
  end: number;
}

/** Inclusive on both ends, as HTTP byte ranges are. */
const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * Parses a Range header against a known file size.
 *
 * Returns null when the caller asked for no range, or asked in a way we do not
 * honour — a malformed header, or multiple ranges. RFC 9110 permits answering
 * such a request with the whole representation, and a single stream is all
 * GridFS gives us cheaply.
 *
 * Returns 'unsatisfiable' when the range is well formed but cannot be served,
 * which the caller answers with 416.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) {
    return null;
  }

  const match = SINGLE_RANGE.exec(header.trim());
  if (!match) {
    return null;
  }

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') {
    return null;
  }

  if (size === 0) {
    return 'unsatisfiable';
  }

  // "bytes=-100" means the last 100 bytes, not "up to byte 100".
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (suffix === 0) {
      return 'unsatisfiable';
    }
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) {
    return 'unsatisfiable';
  }

  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) {
    return 'unsatisfiable';
  }

  return { start, end };
}
