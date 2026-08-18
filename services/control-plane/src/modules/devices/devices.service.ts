import { Inject, Injectable, ConflictException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { TelemetryConsumer } from '../telemetry/telemetry.consumer';
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
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Tell the telemetry consumer to forget an IMEI right now, so a deleted
   * device stops receiving positions immediately instead of after its cache
   * TTL. Looked up lazily via ModuleRef: the consumer depends on the device
   * repository, so injecting it here directly would be a cycle.
   */
  private forgetImei(imei: string) {
    try {
      this.moduleRef.get(TelemetryConsumer, { strict: false })?.forgetImei(imei);
    } catch {
      /* consumer not registered (e.g. a slim test module) — the TTL still bounds it */
    }
  }

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
    return this.getScoped(user, id, false);
  }

  /**
   * Same tenant + department scope check, but a soft-deleted device is still
   * found. For read-only HISTORY paths: deleting a device must not make its
   * past positions, trips and alerts unreadable — preserving history is the
   * whole point of soft delete. Never use this for anything that mutates or
   * that feeds the live map.
   */
  async getIncludingDeleted(user: AuthUser, id: string): Promise<Device> {
    return this.getScoped(user, id, true);
  }

  private async getScoped(user: AuthUser, id: string, includeDeleted: boolean): Promise<Device> {
    const d = await this.devices.findById(user.tenantId, id, { includeDeleted });
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

  /**
   * Soft delete. The device disappears from every list, count, and lookup,
   * and ingestion stops accepting its IMEI — but the row stays, so every
   * position, trip and alert keyed on its id remains readable and restorable.
   * Nothing is ever hard-deleted from here.
   */
  async remove(user: AuthUser, id: string): Promise<void> {
    const existing = await this.get(user, id); // live + in scope, else 404
    await this.devices.softDelete(user.tenantId, id, new Date().toISOString());
    // Stop ingestion accepting this tracker (its live socket, if any, is
    // dropped on next login) and stop the consumer attaching anything more to
    // this row — both immediately.
    await this.allowList.remove(existing.imei);
    this.forgetImei(existing.imei);
  }

  /** Soft-deleted devices in the caller's tenant (and department scope). */
  async listDeleted(user: AuthUser): Promise<Device[]> {
    const scope = await this.scopeFor(user);
    const all = await this.devices.listDeleted(user.tenantId);
    return scope ? all.filter((d) => d.departmentId !== null && scope.includes(d.departmentId)) : all;
  }

  /**
   * Undo a soft delete. Fails (409) if the IMEI has since been provisioned
   * again as a live device — two live rows can't share a tracker.
   */
  async restore(user: AuthUser, id: string): Promise<Device> {
    const d = await this.devices.findById(user.tenantId, id, { includeDeleted: true });
    if (!d || d.deletedAt === null) throw new NotFoundException('No deleted device with that id');
    const scope = await this.scopeFor(user);
    if (scope && (d.departmentId === null || !scope.includes(d.departmentId))) throw new NotFoundException('No deleted device with that id');
    await this.billing.assertCanAddDevice(user.tenantId); // restoring counts against the plan again
    const ok = await this.devices.restore(user.tenantId, id);
    if (!ok) throw new ConflictException(`IMEI ${d.imei} is now used by another live device — cannot restore`);
    const restored = (await this.devices.findById(user.tenantId, id))!;
    if (SENDING_STATUSES.includes(restored.status)) await this.allowList.add(restored.imei);
    this.forgetImei(restored.imei); // drop any cached "no device" from while it was deleted
    return restored;
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
