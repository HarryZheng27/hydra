export const onboardingSteps = ['welcome', 'import', 'appearance', 'accounts'] as const;
export type OnboardingStep = typeof onboardingSteps[number];
export interface OnboardingState { version: 1; step: OnboardingStep; completed: boolean; skipped: OnboardingStep[] }
export function readOnboarding(value: unknown): OnboardingState {
  const state = value as { version?: unknown; step?: unknown; completed?: unknown; skipped?: unknown } | undefined;
  // 'project' was retired as its own step; earlier saves referencing it map onto
  // the new final step so already-completed onboarding is not lost.
  const migrateStep = (step: unknown): unknown => step === 'project' ? 'accounts' : step;
  const step = migrateStep(state?.step);
  const skipped = Array.isArray(state?.skipped) ? state.skipped.map(migrateStep) : undefined;
  if (state?.version !== 1 || !onboardingSteps.includes(step as OnboardingStep) || typeof state.completed !== 'boolean' || !skipped || skipped.some(item => !onboardingSteps.includes(item as OnboardingStep))) {
    return { version: 1, step: 'welcome', completed: false, skipped: [] };
  }
  return { version: 1, step: step as OnboardingStep, completed: state.completed, skipped: [...new Set(skipped)] as OnboardingStep[] };
}
export function advanceOnboarding(state: OnboardingState, skip: boolean): OnboardingState {
  const index = onboardingSteps.indexOf(state.step);
  return { ...state, skipped: skip ? [...new Set([...state.skipped, state.step])] : state.skipped.filter(step => step !== state.step),
    step: onboardingSteps[Math.min(index + 1, onboardingSteps.length - 1)]!, completed: index === onboardingSteps.length - 1 };
}
export function shouldOpenOnboarding(input: { desktop: boolean; trusted: boolean; development: boolean; handoff: boolean; completed: boolean }): boolean {
  return input.desktop && input.trusted && !input.development && !input.handoff && !input.completed;
}

// ---- First run: connect the agents already on this computer (docs/Heads.md, "Connecting Claude Code and Codex") ----

export type OnboardingProvider = 'claude' | 'codex';
export const firstRunConnectKey = 'hydra.firstRunConnect.v1';

/**
 * Whether this window connects Claude Code and Codex by itself, once: only an installed desktop Hydra (never a
 * development or test window, which would point the real Claude and Codex at itself), not already done.
 */
export function shouldConnectOnFirstRun(input: { desktop: boolean; production: boolean; development: boolean; test: boolean; handoff: boolean; done: boolean }): boolean {
  return input.desktop && input.production && !input.development && !input.test && !input.handoff && !input.done;
}

/**
 * Which agents to set up on the first run: those whose command-line tool is on this computer, unless they're already
 * connected with their extension installed here (a connection made from another editor leaves this one without it).
 */
export function firstRunProviders(input: Record<OnboardingProvider, { cli: boolean; connected: boolean; extension: boolean }>): OnboardingProvider[] {
  return (['claude', 'codex'] as const).filter(provider => input[provider].cli && !(input[provider].connected && input[provider].extension));
}
