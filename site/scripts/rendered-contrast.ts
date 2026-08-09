export interface RgbaColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

function parseChannel(token: string, scale: number): number {
  const value = Number.parseFloat(token);
  return token.endsWith('%') ? (value / 100) * scale : value;
}

export function parseCssColor(value: string): RgbaColor | undefined {
  const normalized = value.trim().toLowerCase();
  const tokens = normalized.match(/[+-]?(?:\d+\.?\d*|\.\d+)%?/g);
  if (!tokens || tokens.length < 3) return undefined;

  const isSrgb = normalized.startsWith('color(srgb ');
  if (!isSrgb && !normalized.startsWith('rgb')) return undefined;

  const parseColorChannel = (token: string): number =>
    isSrgb ? parseChannel(token, 1) * 255 : parseChannel(token, 255);
  const alphaToken = tokens[3];
  return {
    red: clamp(parseColorChannel(tokens[0]), 0, 255),
    green: clamp(parseColorChannel(tokens[1]), 0, 255),
    blue: clamp(parseColorChannel(tokens[2]), 0, 255),
    alpha: alphaToken ? clamp(parseChannel(alphaToken, 1), 0, 1) : 1,
  };
}

export function compositeColor(foreground: RgbaColor, background: RgbaColor): RgbaColor {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
  if (alpha === 0) return { red: 0, green: 0, blue: 0, alpha: 0 };

  const backgroundContribution = background.alpha * (1 - foreground.alpha);
  return {
    red: (foreground.red * foreground.alpha + background.red * backgroundContribution) / alpha,
    green:
      (foreground.green * foreground.alpha + background.green * backgroundContribution) / alpha,
    blue: (foreground.blue * foreground.alpha + background.blue * backgroundContribution) / alpha,
    alpha,
  };
}

function linearChannel(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

export function contrastRatio(first: RgbaColor, second: RgbaColor): number {
  const firstLuminance =
    0.2126 * linearChannel(first.red) +
    0.7152 * linearChannel(first.green) +
    0.0722 * linearChannel(first.blue);
  const secondLuminance =
    0.2126 * linearChannel(second.red) +
    0.7152 * linearChannel(second.green) +
    0.0722 * linearChannel(second.blue);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export function requiredContrastRatio(fontSizePx: number, fontWeight: number): number {
  const isLargeText = fontSizePx >= 24 || (fontSizePx >= 18.6667 && fontWeight >= 700);
  return isLargeText ? 3 : 4.5;
}
