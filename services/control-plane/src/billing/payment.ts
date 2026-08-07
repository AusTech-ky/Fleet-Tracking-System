import type { PlanId } from './plans';

/**
 * Payment provider port. The billing service calls this on plan changes. Kept
 * behind an interface so the app is testable without a real provider; the
 * production adapter (Stripe) is a thin wrapper injected when STRIPE_KEY is set.
 */
export interface PaymentProvider {
  /** Create/replace a subscription for a tenant on a plan. Returns its status. */
  subscribe(tenantId: string, planId: PlanId): Promise<{ status: 'active' | 'past_due' }>;
}

/** Dev/test provider: everything succeeds immediately. */
export class FakePaymentProvider implements PaymentProvider {
  readonly calls: { tenantId: string; planId: PlanId }[] = [];
  async subscribe(tenantId: string, planId: PlanId) {
    this.calls.push({ tenantId, planId });
    return { status: 'active' as const };
  }
}

/**
 * Stripe adapter placeholder. Real implementation would map plans to Stripe
 * Prices and create/update a Subscription via the Stripe SDK using STRIPE_KEY.
 * Not exercised here (no Stripe account in the sandbox) — deploy-only.
 */
export class StripePaymentProvider implements PaymentProvider {
  constructor(private readonly apiKey: string) {}
  async subscribe(_tenantId: string, _planId: PlanId): Promise<{ status: 'active' | 'past_due' }> {
    throw new Error('StripePaymentProvider not implemented in this build — configure and wire the Stripe SDK');
  }
}
