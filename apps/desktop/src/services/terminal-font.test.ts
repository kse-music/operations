import { expect, it } from 'vitest';
import { defaultTerminalPreferences } from '../types/preferences';
import { resolveTerminalFontFamily, resolveTerminalLineHeight } from './terminal-font';

it.each(['Linux x86_64', 'Linux aarch64'])(
  'uses the generic monospace family for the saved default on %s',
  (platform) => {
    const preferences = defaultTerminalPreferences();
    expect(resolveTerminalFontFamily(preferences.fontFamily, platform)).toBe('monospace');
    expect(preferences.fontFamily).toBe('Cascadia Mono, Consolas, monospace');
  },
);

it.each(['Win32', 'MacIntel'])('preserves the existing default on %s', (platform) => {
  const fontFamily = defaultTerminalPreferences().fontFamily;
  expect(resolveTerminalFontFamily(fontFamily, platform)).toBe(fontFamily);
});

it('preserves a custom font family on Linux', () => {
  const fontFamily = 'JetBrains Mono, monospace';
  expect(resolveTerminalFontFamily(fontFamily, 'Linux x86_64')).toBe(fontFamily);
});

it.each(['Linux x86_64', 'Linux aarch64'])(
  'keeps low glyphs inside Linux terminal rows on %s',
  (platform) => {
    expect(resolveTerminalLineHeight(100, platform)).toBe(1.1);
    expect(resolveTerminalLineHeight(105, platform)).toBe(1.1);
    expect(resolveTerminalLineHeight(110, platform)).toBe(1.1);
    expect(resolveTerminalLineHeight(150, platform)).toBe(1.5);
    expect(resolveTerminalLineHeight(200, platform)).toBe(2);
  },
);

it.each(['Win32', 'MacIntel'])('preserves the configured line height on %s', (platform) => {
  expect(resolveTerminalLineHeight(100, platform)).toBe(1);
  expect(resolveTerminalLineHeight(105, platform)).toBe(1.05);
  expect(resolveTerminalLineHeight(150, platform)).toBe(1.5);
});
