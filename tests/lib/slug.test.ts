import { describe, expect, it } from 'vitest';
import { slugify } from '../../src/lib/slug.ts';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Sea Lions Puerto Ayora')).toBe('sea-lions-puerto-ayora');
  });

  it('strips accents', () => {
    expect(slugify('Piquero de patas azules')).toBe('piquero-de-patas-azules');
    expect(slugify('José Valdiviezo')).toBe('jose-valdiviezo');
  });

  it('collapses non-alphanumeric runs into a single hyphen and trims edges', () => {
    expect(slugify('  DSC_0042 (final)!!.jpg  ')).toBe('dsc-0042-final-jpg');
  });

  it('caps length at 80 chars', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(80);
  });
});
