import { defaultTerminalPreferences } from '../types/preferences';

const defaultFontFamily = defaultTerminalPreferences().fontFamily;

export function resolveTerminalFontFamily(
  fontFamily: string,
  platform: string = navigator.platform,
): string {
  // Fontconfig may substitute a proportional font before reaching monospace.
  return platform.startsWith('Linux') && fontFamily === defaultFontFamily
    ? 'monospace'
    : fontFamily;
}

export function resolveTerminalLineHeight(
  lineHeight: number,
  platform: string = navigator.platform,
): number {
  // WebKitGTK clips low glyphs in xterm's DOM rows at the tightest line heights.
  return Math.max(platform.startsWith('Linux') ? 110 : 100, lineHeight) / 100;
}
