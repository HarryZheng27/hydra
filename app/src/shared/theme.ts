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
/**
 * The app's own palette (docs/internal/hydra-app/UI-direction.md), over the IDE's themes: neutral surfaces, subtle
 * borders, and Hydra green only for primary buttons, focus, success and links. The IDE's themes are unchanged.
 */
const appColors: Record<ThemeName, Record<string, string>> = {
  dark: {
    '--bg': '#141414', '--fg': '#ECECEC', '--muted': '#999999', '--faint': '#6E6E6E',
    '--sidebar-bg': '#181818', '--sidebar-fg': '#CFCFCF', '--sidebar-border': '#2A2A2A', '--border': '#2A2A2A',
    '--hover': '#222222', '--selected-bg': '#292929', '--selected-fg': '#ECECEC',
    '--input-bg': '#1B1B1B', '--input-fg': '#ECECEC', '--input-border': '#333333',
    '--button-bg': '#42A875', '--button-fg': '#0C1510', '--button-hover': '#4DB881',
    '--focus': '#42A87566', '--link': '#42A875', '--titlebar-bg': '#141414', '--titlebar-fg': '#999999',
    '--error': '#F2777A', '--warning': '#E5B25D', '--ok': '#42A875', '--user-bubble': '#222222',
  },
  light: {
    '--bg': '#FBFBFA', '--fg': '#20201E', '--muted': '#73736E', '--faint': '#A3A39E',
    '--sidebar-bg': '#F7F7F5', '--sidebar-fg': '#3A3A37', '--sidebar-border': '#E3E3E0', '--border': '#E3E3E0',
    '--hover': '#ECECEA', '--selected-bg': '#E7E7E4', '--selected-fg': '#20201E',
    '--input-bg': '#FFFFFF', '--input-fg': '#20201E', '--input-border': '#DADAD6',
    '--button-bg': '#1F7A4D', '--button-fg': '#FFFFFF', '--button-hover': '#19663F',
    '--focus': '#1F7A4D55', '--link': '#1F7A4D', '--titlebar-bg': '#FBFBFA', '--titlebar-fg': '#73736E',
    '--error': '#C4314B', '--warning': '#A86A00', '--ok': '#1F7A4D', '--user-bubble': '#EFEFEC',
  },
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

/**
 * A theme's colors as VS Code's webview CSS variables (`--vscode-editor-background` for `editor.background`), plus
 * the font: for the IDE's own Hydra Settings pages, which the app shows in their own window (G5 milestone 5).
 */
export function vscodeThemeVariables(name: ThemeName): Record<string, string> {
  const out: Record<string, string> = {
    // The app's type (Claude desktop's fallback stack and 14px body), in Hydra Settings' window too.
    '--vscode-font-family': 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    '--vscode-font-size': '14px',
  };
  for (const [key, value] of Object.entries(files[name].colors)) {
    if (/^[a-zA-Z0-9.]+$/.test(key) && /^#[0-9a-fA-F]{3,8}$/.test(value)) out[`--vscode-${key.replace(/\./g, '-')}`] = value;
  }
  return out;
}
