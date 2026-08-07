import { Inject, Injectable, ConflictException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TOKENS, type DeviceRepository, type OrgUnitRepository } from '../../domain/repository';
import type { AllowListPublisher } from '../../integrations/ports';
import type { Device, DeviceStatus } from '../../domain/entities';
import type { AuthUser } from '../../common/auth';
import { descendantIds } from '../../engine/org';
import { BillingService } from '../billing/billing';

/** A device may send data only while provisioned or active. */
const SENDING_STATUSES: DeviceStatus[] = ['provisioned', 'active'];

@Injectable()
export class DevicesService {
  constructor(
    @Inject(TOKENS.DeviceRepository) private readonly devices: DeviceRepository,
    @Inject(TOKENS.AllowListPublisher) private readonly allowList: AllowListPublisher,
    @Inject(TOKENS.OrgUnitRepository) private readonly orgUnits: OrgUnitRepository,
    private readonly billing: BillingService,
  ) {}

  /** Department ids a user may access (their subtree), or null for tenant-wide. */
  private async scopeFor(user: AuthUser): Promise<string[] | null> {
    if (!user.departmentId) return null;
    const units = await this.orgUnits.list(user.tenantId);
    return [...descendantIds(units, user.departmentId)];
  }

  async provision(user: AuthUser, imei: string, model: string, departmentId?: string | null, name?: string | null): Promise<Device> {
    if (await this.devices.findByImei(imei)) {
      throw new ConflictException(`Device with IMEI ${imei} already exists`);
    }
    await this.billing.assertCanAddDevice(user.tenantId); // plan quota
    // Default to the provisioner's own department; validate it's within scope.
    const dept = departmentId !== undefined ? departmentId : user.departmentId;
    await this.assertDepartmentInScope(user, dept);

    const device = await this.devices.create({
      id: randomUUID(), tenantId: user.tenantId, imei, name: name ?? null, model,
      status: 'provisioned', vehicleId: null, departmentId: dept ?? null,
    });
    await this.allowList.add(imei); // ingestion accepts it immediately
    return device;
  }

  async rename(user: AuthUser, id: string, name: string | null): Promise<Device> {
    await this.get(user, id); // tenant + department scope check
    const updated = await this.devices.update(user.tenantId, id, { name });
    if (!updated) throw new NotFoundException('Device not found');
    return updated;
  }

  async list(user: AuthUser): Promise<Device[]> {
    const scope = await this.scopeFor(user);
    return this.devices.list(user.tenantId, scope ?? undefined);
  }

  /** Fetch a device, enforcing tenant + department scope (404 if out of scope). */
  async get(user: AuthUser, id: string): Promise<Device> {
    const d = await this.devices.findById(user.tenantId, id);
    if (!d) throw new NotFoundException('Device not found');
    const scope = await this.scopeFor(user);
    if (scope && (d.departmentId === null || !scope.includes(d.departmentId))) {
      throw new NotFoundException('Device not found'); // don't reveal existence outside scope
    }
    return d;
  }

  async setStatus(user: AuthUser, id: string, status: DeviceStatus): Promise<Device> {
    const existing = await this.get(user, id);
    const updated = await this.devices.update(user.tenantId, id, { status });
    if (!updated) throw new NotFoundException('Device not found');
    if (SENDING_STATUSES.includes(status)) await this.allowList.add(existing.imei);
    else await this.allowList.remove(existing.imei);
    return updated;
  }

  async assignDepartment(user: AuthUser, id: string, departmentId: string | null): Promise<Device> {
    await this.get(user, id); // scope check on the device
    await this.assertDepartmentInScope(user, departmentId);
    const updated = await this.devices.update(user.tenantId, id, { departmentId });
    if (!updated) throw new NotFoundException('Device not found');
    return updated;
  }

  async remove(user: AuthUser, id: string): Promise<void> {
    const existing = await this.get(user, id);
    await this.devices.remove(user.tenantId, id);
    await this.allowList.remove(existing.imei);
  }

  /** Validate a target department exists in the tenant and is within the user's scope. */
  private async assertDepartmentInScope(user: AuthUser, departmentId: string | null | undefined) {
    if (departmentId == null) {
      // Only tenant-wide users may leave a device unassigned.
      if (user.departmentId) throw new ForbiddenException('You must assign the device to your department');
      return;
    }
    if (!(await this.orgUnits.findById(user.tenantId, departmentId))) {
      throw new NotFoundException('Department not found');
    }
    const scope = await this.scopeFor(user);
    if (scope && !scope.includes(departmentId)) {
      throw new ForbiddenException('Department is outside your scope');
    }
  }
}
