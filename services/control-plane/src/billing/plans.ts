/**
 * Plan catalog + quota logic (pure). Each plan caps resources; the billing
 * service enforces these on provisioning. Framework/DB-free and unit-tested.
 */
export type PlanId = 'trial' | 'free' | 'pro' | 'enterprise';

export interface PlanLimits {
  devices: number;
  users: number;
}
export interface Plan {
  id: PlanId;
  name: string;
  priceUsdMonthly: number;
  limits: PlanLimits;
}

export const PLANS: Record<PlanId, Plan> = {
  trial: { id: 'trial', name: 'Trial', priceUsdMonthly: 0, limits: { devices: 2, users: 1 } },
  free: { id: 'free', name: 'Free', priceUsdMonthly: 0, limits: { devices: 25, users: 10 } },
  pro: { id: 'pro', name: 'Pro', priceUsdMonthly: 199, limits: { devices: 1000, users: 100 } },
  enterprise: { id: 'enterprise', name: 'Enterprise', priceUsdMonthly: 1999, limits: { devices: 100_000, users: 5000 } },
};

export const DEFAULT_PLAN: PlanId = 'free';

export function isPlanId(id: string): id is PlanId {
  return id in PLANS;
}
export function getPlan(id: PlanId): Plan {
  return PLANS[id];
}

export interface Usage {
  devices: number;
  users: number;
}

/** True if adding one more of `resource` would exceed the plan's limit. */
export function wouldExceed(plan: Plan, usage: Usage, resource: keyof PlanLimits): boolean {
  return usage[resource] >= plan.limits[resource];
}
