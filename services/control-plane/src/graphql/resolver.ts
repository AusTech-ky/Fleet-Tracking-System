import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Inject } from '@nestjs/common';
import { CurrentUser, Roles, type AuthUser } from '../common/auth';
import { TOKENS } from '../domain/repository';
import type { HotState } from '../integrations/ports';
import { DevicesService } from '../modules/devices/devices.service';
import { GeofencesService } from '../modules/geofences/geofences';
import { AlertsService } from '../modules/alerts/alerts';
import { BillingService } from '../modules/billing/billing';
import { DeviceType, PositionType, AlertType, GeofenceType, MeType, BillingType } from './types';

/**
 * GraphQL API over the existing services — one flexible query for partners
 * instead of stitching REST calls. Auth + department scoping are identical to
 * REST (same guards, same DevicesService.get/list). Read queries + a device
 * provisioning mutation.
 */
@Resolver()
export class FleetResolver {
  constructor(
    private readonly deviceSvc: DevicesService,
    private readonly geofenceSvc: GeofencesService,
    private readonly alertSvc: AlertsService,
    private readonly billingSvc: BillingService,
    @Inject(TOKENS.HotState) private readonly hot: HotState,
  ) {}

  @Query(() => MeType)
  me(@CurrentUser() user: AuthUser): MeType {
    return { userId: user.userId, tenantId: user.tenantId, email: user.email, role: user.role, departmentId: user.departmentId };
  }

  @Query(() => [DeviceType])
  devices(@CurrentUser() user: AuthUser) {
    return this.deviceSvc.list(user); // department-scoped
  }

  @Query(() => DeviceType)
  device(@CurrentUser() user: AuthUser, @Args('id', { type: () => ID }) id: string) {
    return this.deviceSvc.get(user, id);
  }

  @Query(() => PositionType, { nullable: true })
  async latestPosition(@CurrentUser() user: AuthUser, @Args('deviceId', { type: () => ID }) deviceId: string) {
    await this.deviceSvc.get(user, deviceId); // scope check
    return this.hot.getLast(user.tenantId, deviceId);
  }

  @Query(() => [GeofenceType])
  geofences(@CurrentUser() user: AuthUser) {
    return this.geofenceSvc.list(user.tenantId);
  }

  @Query(() => [AlertType])
  alerts(
    @CurrentUser() user: AuthUser,
    @Args('deviceId', { type: () => ID, nullable: true }) deviceId?: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ) {
    return this.alertSvc.list(user.tenantId, deviceId, limit ?? 100);
  }

  @Query(() => BillingType)
  async billing(@CurrentUser() user: AuthUser): Promise<BillingType> {
    const s = await this.billingSvc.summary(user.tenantId);
    return {
      planId: s.plan.id, planName: s.plan.name, limits: s.plan.limits,
      devicesUsed: s.usage.devices, usersUsed: s.usage.users,
    };
  }

  @Mutation(() => DeviceType)
  @Roles('admin', 'operator')
  provisionDevice(
    @CurrentUser() user: AuthUser,
    @Args('imei') imei: string,
    @Args('model') model: string,
    @Args('departmentId', { type: () => ID, nullable: true }) departmentId?: string,
  ) {
    return this.deviceSvc.provision(user, imei, model, departmentId ?? undefined);
  }
}
