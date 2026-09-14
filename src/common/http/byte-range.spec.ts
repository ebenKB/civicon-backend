import { parseByteRange } from './byte-range.js';

const SIZE = 1000;

describe('parseByteRange', () => {
  it('returns null when no header is present', () => {
    expect(parseByteRange(undefined, SIZE)).toBeNull();
  });

  it('parses a closed range', () => {
    expect(parseByteRange('bytes=0-499', SIZE)).toEqual({ start: 0, end: 499 });
  });

  it('parses an open-ended range as running to the last byte', () => {
    expect(parseByteRange('bytes=500-', SIZE)).toEqual({
      start: 500,
      end: 999,
    });
  });

  it('parses a suffix range as the last N bytes', () => {
    expect(parseByteRange('bytes=-100', SIZE)).toEqual({
      start: 900,
      end: 999,
    });
  });

  it('clamps an end past the last byte', () => {
    expect(parseByteRange('bytes=900-5000', SIZE)).toEqual({
      start: 900,
      end: 999,
    });
  });

  it('accepts a range covering the whole file', () => {
    expect(parseByteRange('bytes=0-999', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it.each([
    ['bytes=1000-', 'a start at or past the end'],
    ['bytes=600-500', 'an end before the start'],
    ['bytes=-0', 'a zero-length suffix'],
  ])('reports %s as unsatisfiable (%s)', (header) => {
    expect(parseByteRange(header, SIZE)).toBe('unsatisfiable');
  });

  it.each([
    'items=0-10',
    'bytes=abc-def',
    'bytes=',
    'nonsense',
    'bytes=0-10, 20-30',
  ])('treats the malformed header %s as no range', (header) => {
    expect(parseByteRange(header, SIZE)).toBeNull();
  });

  it('treats a zero-byte file as unsatisfiable for any range', () => {
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable');
  });
});
