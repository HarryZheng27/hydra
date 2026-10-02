/**
 * Hydra settings that are read fresh wherever they are used and touch no provider,
 * model catalog or repository state, so changing one only needs the panel
 * republished. The helper cap is read by the helper service on every dispatch.
 */
export const preferenceOnlySettings: ReadonlySet<string> = new Set([
  'hydra.maxConcurrentHelpers', 'hydra.chatLocation',
  'hydra.heads.defaultMinutes', 'hydra.heads.defaultMaxTurns', 'hydra.heads.defaultBudgetUsd',
  'hydra.startupLayout', 'hydra.limits.offerHandoff', 'hydra.updates.check',
  // Read at each use by the packs service (docs/internal/Packs_Plan.md).
  'hydra.packs.folder',
  // Only changes what Connect/Repair do next; nothing about the current provider connection.
  'hydra.claudeMem.enabled',
  // O1: read fresh by hydra_plan_create; nothing about the current provider connection.
  'hydra.plans.leadPlansNeedApproval',
  // O5: read fresh by hydra_plan_amend; nothing about the current provider connection.
  'hydra.plans.maxAmendments',
  // Small plans run as one head: read fresh by Run plan; nothing about the current provider connection.
  'hydra.plans.singleHeadForSmallPlans',
  // O6: read fresh by the limit-offer handler and hydra_done/gates; nothing about the current provider connection.
  'hydra.limits.autoContinuePlans',
]);

/**
 * The contributed settings whose change must reset provider state and refresh.
 * Built from the manifest rather than a fixed list, so a setting added later
 * takes the full path by default; with no readable manifest, everything does.
 */
export function settingsRequiringRefresh(contributed: readonly string[]): string[] {
  return contributed.length ? contributed.filter(key => !preferenceOnlySettings.has(key)) : ['hydra'];
}
