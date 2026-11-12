import { expect, it } from 'vitest';
import { megabytes } from './format';
it('displays transfer size and rate in decimal MB with two decimal places', () => {
  expect(megabytes(6_895_429)).toBe('6.90');
  expect(megabytes(427_621_376)).toBe('427.62');
  expect(megabytes(0)).toBe('0.00');
  expect(megabytes(NaN)).toBe('0.00');
});
