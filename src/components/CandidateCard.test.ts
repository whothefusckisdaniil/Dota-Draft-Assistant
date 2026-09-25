import { describe, expect, it } from 'vitest';
import { formatMatches } from './CandidateCard';

describe('formatMatches (Top-15 polish: no more "0k matches")', () => {
  it('renders thin samples as "<1k"', () => {
    expect(formatMatches(0)).toBe('<1k');
    expect(formatMatches(42)).toBe('<1k');
    expect(formatMatches(999)).toBe('<1k');
  });

  it('renders thousands with one decimal only when needed', () => {
    expect(formatMatches(1000)).toBe('1k');
    expect(formatMatches(1240)).toBe('1.2k');
    expect(formatMatches(12400)).toBe('12.4k');
    expect(formatMatches(999499)).toBe('999.5k');
  });

  it('rolls over to millions instead of printing "1000k"', () => {
    expect(formatMatches(999999)).toBe('1M');
    expect(formatMatches(1000000)).toBe('1M');
    expect(formatMatches(1200000)).toBe('1.2M');
    expect(formatMatches(12400000)).toBe('12.4M');
  });
});
