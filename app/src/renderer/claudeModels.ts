import type { PickerOption } from './Picker';

/**
 * Claude Code's models as Claude desktop's menu lists them: the latest of each family first, then More models. The ids
 * and names are Claude Code's own (its extension's model table: latest_per_family, display_name); the CLI takes the id
 * as --model.
 */
export const claudeLatest = [
  { value: 'claude-opus-5-5', label: 'Opus 5.5' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];
export const claudeMore = [
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-opus-5', label: 'Opus 5' },
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
];
export const claudeDefaultModel = 'claude-opus-5-5';

/** Each model's context window, from the same table: 1M, but 200k for Haiku 4.5, Opus 4.6 and Sonnet 4.6. */
export function claudeContextWindow(model: string | undefined): number {
  return ['claude-haiku-4-5', 'claude-opus-4-6', 'claude-sonnet-4-6'].includes(claudeModelId(model) ?? '') ? 200_000 : 1_000_000;
}

/**
 * A model as the menu knows it: an alias (opus, which older chats and settings hold) is its family's latest; a dated
 * id (claude-haiku-4-5-20251001, as the CLI reports it) is the undated one.
 */
export function claudeModelId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase().replace(/\[1m\]$/, '');
  const family = /^(opus|sonnet|haiku|fable)$/.exec(lower)?.[1];
  if (family) return claudeLatest.find(model => model.value.startsWith(`claude-${family}-`))?.value;
  const undated = lower.replace(/-\d{8}$/, '');
  return [...claudeLatest, ...claudeMore].some(model => model.value === undated) ? undated : value;
}

/** The menu's choices: the latest models (the default badged), a line, and More models with the rest. */
export function claudeModelOptions(): PickerOption[] {
  return [
    ...claudeLatest.map(model => (model.value === claudeDefaultModel ? { ...model, badge: 'Default' } : model)),
    { value: 'more', label: 'More models', separator: true, submenu: claudeMore },
  ];
}
