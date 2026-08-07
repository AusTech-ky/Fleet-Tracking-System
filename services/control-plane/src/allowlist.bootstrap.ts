import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { TOKENS, type DeviceRepository } from './domain/repository';
import type { AllowListPublisher } from './integrations/ports';

/**
 * On boot, resync the ingestion allow-list from the source of truth (the device
 * table). This makes the shared Redis set self-healing after a flush or a new
 * ingestion cluster, independent of the incremental add/remove on each mutation.
 */
@Injectable()
export class AllowListBootstrap implements OnModuleInit {
  private readonly log = new Logger(AllowListBootstrap.name);
  constructor(
    @Inject(TOKENS.DeviceRepository) private readonly devices: DeviceRepository,
    @Inject(TOKENS.AllowListPublisher) private readonly allowList: AllowListPublisher,
  ) {}
  async onModuleInit() {
    const imeis = await this.devices.activeImeis();
    await this.allowList.replaceAll(imeis);
    this.log.log(`allow-list resynced: ${imeis.length} IMEIs`);
  }
}
