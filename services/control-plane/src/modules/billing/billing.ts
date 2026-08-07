import {
  Body, Controller, Get, HttpCode, HttpException, HttpStatus, Inject, Injectable, Post,
} from '@nestjs/common';
import { IsIn } from 'class-validator';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth';
import { TOKENS, type DeviceRepository, type UserRepository, type SubscriptionRepository } from '../../domain/repository';
import type { PaymentProvider } from '../../billing/payment';
import {
  DEFAULT_PLAN, PLANS, getPlan, isPlanId, wouldExceed, type Plan, type PlanId, type Usage,
} from '../../billing/plans';

/** Thrown when a quota would be exceeded → HTTP 402 Payment Required. */
export class QuotaExceededException extends HttpException {
  constructor(message: string) {
    super({ statusCode: HttpStatus.PAYMENT_REQUIRED, error: 'QuotaExceeded', message }, HttpStatus.PAYMENT_REQUIRED);
  }
}

const ALL_PLAN_IDS = Object.keys(PLANS) as PlanId[];

export class SubscribeDto {
  @IsIn(ALL_PLAN_IDS) planId!: PlanId;
}

@Injectable()
export class BillingService {
  constructor(
    @Inject(TOKENS.SubscriptionRepository) private readonly subs: SubscriptionRepository,
    @Inject(TOKENS.DeviceRepository) private readonly devices: DeviceRepository,
    @Inject(TOKENS.UserRepository) private readonly users: UserRepository,
    @Inject(TOKENS.PaymentProvider) private readonly payments: PaymentProvider,
  ) {}

  async planFor(tenantId: string): Promise<Plan> {
    const sub = await this.subs.get(tenantId);
    const id = sub && isPlanId(sub.planId) ? sub.planId : DEFAULT_PLAN;
    return getPlan(id);
  }

  async usage(tenantId: string): Promise<Usage> {
    return { devices: await this.devices.count(tenantId), users: await this.users.count(tenantId) };
  }

  /** Called before provisioning a device — throws 402 if over the plan limit. */
  async assertCanAddDevice(tenantId: string): Promise<void> {
    const plan = await this.planFor(tenantId);
    const usage = await this.usage(tenantId);
    if (wouldExceed(plan, usage, 'devices')) {
      throw new QuotaExceededException(`Device limit reached for the ${plan.name} plan (${plan.limits.devices}). Upgrade to add more.`);
    }
  }

  /** Called before creating a user — throws 402 if over the plan limit. */
  async assertCanAddUser(tenantId: string): Promise<void> {
    const plan = await this.planFor(tenantId);
    const usage = await this.usage(tenantId);
    if (wouldExceed(plan, usage, 'users')) {
      throw new QuotaExceededException(`User limit reached for the ${plan.name} plan (${plan.limits.users}). Upgrade to add more.`);
    }
  }

  async subscribe(tenantId: string, planId: PlanId) {
    const { status } = await this.payments.subscribe(tenantId, planId);
    await this.subs.set(tenantId, { tenantId, planId, status, createdAt: new Date().toISOString() });
    return this.summary(tenantId);
  }

  async summary(tenantId: string) {
    const plan = await this.planFor(tenantId);
    const usage = await this.usage(tenantId);
    return {
      plan: { id: plan.id, name: plan.name, priceUsdMonthly: plan.priceUsdMonthly, limits: plan.limits },
      usage,
    };
  }
}

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Current plan, limits and usage. Available plans are also returned. */
  @Get()
  async summary(@CurrentUser() user: AuthUser) {
    return { ...(await this.billing.summary(user.tenantId)), plans: Object.values(PLANS) };
  }

  @Post('subscribe')
  @Roles('admin')
  @HttpCode(200)
  subscribe(@CurrentUser() user: AuthUser, @Body() dto: SubscribeDto) {
    return this.billing.subscribe(user.tenantId, dto.planId);
  }
}
