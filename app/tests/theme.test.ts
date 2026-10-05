import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolveTheme, themeVariableNames, themeVariables, titleBarColors } from '../src/shared/theme';

const themeFile = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'themes', `hydra-${name}.json`), 'utf8')) as { type: string; colors: Record<string, string> };

test('the app\'s dark and light palettes are UI-direction.md\'s, with every color the app uses; the IDE theme files still load', () => {
  // Each mode's table in the design doc: | Canvas | #FBFBFA |, and so on.
  const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'internal', 'hydra-app', 'UI-direction.md'), 'utf8');
  const table = (mode: string) => {
    const section = doc.slice(doc.indexOf(`## ${mode}`), doc.indexOf('\n## ', doc.indexOf(`## ${mode}`) + 3));
    return Object.fromEntries([...section.matchAll(/^\| ([A-Za-z ]+) \| (#[0-9A-Fa-f]{6}) \|$/gm)].map(match => [match[1]!, match[2]!.toUpperCase()]));
  };
  const tokens: Record<string, string> = { Canvas: '--bg', Sidebar: '--sidebar-bg', Hover: '--hover', Selection: '--selected-bg', Border: '--border', 'Primary text': '--fg', 'Muted text': '--muted', 'Hydra green': '--link' };
  for (const [name, mode] of [['dark', 'Dark mode'], ['light', 'Light mode']] as const) {
    const vars = themeVariables(name);
    assert.deepEqual(Object.keys(vars), [...themeVariableNames]);
    for (const [variable, value] of Object.entries(vars)) assert.match(value, /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/, `${name} ${variable}`);
    const colors = table(mode);
    assert.ok(Object.keys(colors).length >= 8, `${mode}'s table`);
    for (const [label, variable] of Object.entries(tokens)) assert.equal(vars[variable]!.toUpperCase(), colors[label], `${name} ${label}`);
    assert.equal(themeFile(name).type, name);
  }
});

test('the theme setting resolves Dark, Light or System', () => {
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
});

test('the title bar overlay takes six-digit colors from the theme', () => {
  for (const name of ['dark', 'light'] as const) {
    const colors = titleBarColors(name);
    assert.match(colors.color, /^#[0-9A-Fa-f]{6}$/);
    assert.match(colors.symbolColor, /^#[0-9A-Fa-f]{6}$/);
  }
});

test('the CSS defaults match Hydra Dark, and Hydra Light under a light preference, so the first paint matches', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const light = css.indexOf('@media (prefers-color-scheme: light)');
  assert.ok(light > 0);
  const darkBlock = css.slice(0, light), lightBlock = css.slice(light, css.indexOf('\n}', light));
  for (const [variable, value] of Object.entries(themeVariables('dark'))) assert.ok(darkBlock.includes(`${variable}: ${value};`), `dark ${variable}: ${value}`);
  for (const [variable, value] of Object.entries(themeVariables('light'))) assert.ok(lightBlock.includes(`${variable}: ${value};`), `light ${variable}: ${value}`);
});
