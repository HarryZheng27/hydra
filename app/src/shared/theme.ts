import hydraDark from '../../../themes/hydra-dark.json';
import hydraLight from '../../../themes/hydra-light.json';

/**
 * Hydra Dark and Hydra Light, from the IDE's own theme files (themes/hydra-*.json), as the CSS variables the app's
 * renderer uses, so the two apps share one look. Each variable lists the theme keys it reads, first one present wins.
 */
export type ThemeName = 'dark' | 'light';
export type ThemeSetting = ThemeName | 'system';
export const themeSettings: readonly ThemeSetting[] = ['dark', 'light', 'system'];

const sources: Record<string, readonly string[]> = {
  '--bg': ['editor.background'],
  '--fg': ['editor.foreground', 'foreground'],
  '--muted': ['descriptionForeground', 'list.deemphasizedForeground', 'sideBar.foreground'],
  '--faint': ['sideBarSectionHeader.foreground'],
  '--sidebar-bg': ['sideBar.background'],
  '--sidebar-fg': ['sideBar.foreground'],
  '--sidebar-border': ['sideBar.border', 'panel.border'],
  '--border': ['panel.border'],
  '--hover': ['list.hoverBackground'],
  '--selected-bg': ['list.inactiveSelectionBackground'],
  '--selected-fg': ['list.inactiveSelectionForeground', 'editor.foreground'],
  '--input-bg': ['input.background'],
  '--input-fg': ['input.foreground'],
  '--input-border': ['input.border'],
  '--button-bg': ['button.background'],
  '--button-fg': ['button.foreground'],
  '--button-hover': ['button.hoverBackground'],
  '--focus': ['focusBorder'],
  '--link': ['textLink.foreground'],
  '--titlebar-bg': ['titleBar.activeBackground'],
  '--titlebar-fg': ['titleBar.activeForeground'],
  '--error': ['list.errorForeground'],
  '--warning': ['list.warningForeground'],
  '--ok': ['gitDecoration.addedResourceForeground'],
};
/** The app's own colors, beyond what the IDE's themes give: each theme sets every one (appColors, below). */
const appOnly = ['--user-bubble'];
export const themeVariableNames = Object.freeze([...Object.keys(sources), ...appOnly]);

const files: Record<ThemeName, { colors: Record<string, string> }> = { dark: hydraDark, light: hydraLight };
/** The app's own adjustments on top of the IDE's themes: Hydra Light's sidebar sits closer to the canvas here. */
const appColors: Record<ThemeName, Record<string, string>> = {
  dark: { '--user-bubble': '#262626' },
  light: { '--sidebar-bg': '#F6F8F4', '--user-bubble': '#EEF0EC' },
};

/** The CSS variables for one theme. Throws if the theme file lacks a color the app needs. */
export function themeVariables(name: ThemeName): Record<string, string> {
  const colors = files[name].colors;
  const out: Record<string, string> = {};
  for (const [variable, keys] of Object.entries(sources)) {
    const key = keys.find(candidate => typeof colors[candidate] === 'string');
    if (!key) throw new Error(`Hydra ${name} has none of ${keys.join(', ')}.`);
    out[variable] = colors[key]!;
  }
  return { ...out, ...appColors[name] };
}

/** The theme a setting shows, given whether the system prefers dark. */
export const resolveTheme = (setting: ThemeSetting, systemDark: boolean): ThemeName =>
  setting === 'system' ? (systemDark ? 'dark' : 'light') : setting;

/** The title bar's own colors, for the window controls Windows draws over it. */
export function titleBarColors(name: ThemeName): { color: string; symbolColor: string } {
  const vars = themeVariables(name);
  return { color: vars['--titlebar-bg']!, symbolColor: vars['--titlebar-fg']! };
}
