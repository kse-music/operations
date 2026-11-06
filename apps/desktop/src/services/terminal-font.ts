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
