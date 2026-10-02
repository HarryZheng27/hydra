import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolveTheme, themeVariableNames, themeVariables, titleBarColors } from '../src/shared/theme';

const themeFile = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'themes', `hydra-${name}.json`), 'utf8')) as { type: string; colors: Record<string, string> };

test('Hydra Dark and Light come from the IDE theme files, with every color the app uses', () => {
  for (const name of ['dark', 'light'] as const) {
    const vars = themeVariables(name);
    assert.deepEqual(Object.keys(vars), [...themeVariableNames]);
    for (const [variable, value] of Object.entries(vars)) assert.match(value, /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/, `${name} ${variable}`);
    assert.equal(vars['--bg'], themeFile(name).colors['editor.background']);
    assert.equal(themeFile(name).type, name);
  }
  assert.notEqual(themeVariables('dark')['--bg'], themeVariables('light')['--bg']);
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
