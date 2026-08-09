import { describe, expect, it } from 'vitest';
import {
  compositeColor,
  contrastRatio,
  parseCssColor,
  requiredContrastRatio,
} from './rendered-contrast.js';

describe('rendered contrast math', () => {
  it('parses browser RGB and color(srgb) output', () => {
    expect(parseCssColor('rgba(12, 34, 56, 0.25)')).toEqual({
      red: 12,
      green: 34,
      blue: 56,
      alpha: 0.25,
    });
    expect(parseCssColor('color(srgb 0.1 0.2 0.3 / 40%)')).toEqual({
      red: 25.5,
      green: 51,
      blue: 76.5,
      alpha: 0.4,
    });
    expect(parseCssColor('rgb(10% 20% 30% / 50%)')).toEqual({
      red: 25.5,
      green: 51,
      blue: 76.5,
      alpha: 0.5,
    });
    expect(parseCssColor('color(srgb 10% 20% 30%)')).toEqual({
      red: 25.5,
      green: 51,
      blue: 76.5,
      alpha: 1,
    });
    expect(parseCssColor('transparent')).toBeUndefined();
    expect(parseCssColor('hsl(0 0% 0%)')).toBeUndefined();
  });

  it('composites translucent foregrounds over their rendered background', () => {
    expect(
      compositeColor(
        { red: 255, green: 255, blue: 255, alpha: 0.5 },
        { red: 0, green: 0, blue: 0, alpha: 1 },
      ),
    ).toEqual({ red: 127.5, green: 127.5, blue: 127.5, alpha: 1 });
  });

  it('uses WCAG luminance and large-text thresholds', () => {
    expect(contrastRatio(parseCssColor('rgb(0 0 0)')!, parseCssColor('rgb(255 255 255)')!)).toBe(
      21,
    );
    expect(requiredContrastRatio(16, 700)).toBe(4.5);
    expect(requiredContrastRatio(18.65, 700)).toBe(4.5);
    expect(requiredContrastRatio(18.6666, 700)).toBe(4.5);
    expect(requiredContrastRatio(18.6667, 700)).toBe(3);
    expect(requiredContrastRatio(24, 400)).toBe(3);
  });
});
