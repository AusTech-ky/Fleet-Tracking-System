import { Body, Controller, Get, HttpCode, Inject, Injectable, Post, Put } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsOptional, IsUrl } from 'class-validator';
import { randomBytes, randomUUID } from 'node:crypto';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth';
import { TOKENS, type NotificationConfigRepository } from '../../domain/repository';
import type { AlertEvent, AlertType, NotificationConfig } from '../../domain/entities';
import { NotificationDispatcher } from '../../notifications/dispatcher';

const ALERT_TYPES: AlertType[] = ['overspeed', 'ignition_on', 'ignition_off', 'geofence_enter', 'geofence_exit', 'device_offline'];

export class UpdateNotificationConfigDto {
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUrl({ require_tld: false }, { each: true })
  webhookUrls?: string[];

  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsEmail({}, { each: true })
  emailRecipients?: string[];

  @IsOptional() @IsArray() @IsIn(ALERT_TYPES, { each: true })
  types?: AlertType[];
}

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(TOKENS.NotificationConfigRepository) private readonly repo: NotificationConfigRepository,
    @Inject(TOKENS.NotificationDispatcher) private readonly dispatcher: NotificationDispatcher,
  ) {}

  getConfig(tenantId: string) {
    return this.repo.get(tenantId);
  }

  async setConfig(tenantId: string, patch: Partial<NotificationConfig>): Promise<NotificationConfig> {
    const current = await this.repo.get(tenantId);
    const merged: NotificationConfig = { ...current };
    if (patch.webhookUrls !== undefined) merged.webhookUrls = patch.webhookUrls;
    if (patch.emailRecipients !== undefined) merged.emailRecipients = patch.emailRecipients;
    if (patch.types !== undefined) merged.types = patch.types;
    // Generate a stable signing secret the first time webhooks are configured.
    if (merged.webhookUrls.length && !merged.webhookSecret) merged.webhookSecret = randomBytes(24).toString('hex');
    return this.repo.set(tenantId, merged);
  }

  /** Fire a synthetic alert through the dispatcher so a tenant can verify delivery. */
  async sendTest(tenantId: string): Promise<{ delivered: boolean }> {
    const alert: AlertEvent = {
      id: randomUUID(), tenantId, deviceId: 'test', imei: '000000000000000',
      type: 'geofence_enter', ts: new Date().toISOString(),
      message: 'Test notification from FleetView', meta: { test: 1 },
    };
    await this.dispatcher.dispatch(alert);
    const cfg = await this.repo.get(tenantId);
    return { delivered: cfg.webhookUrls.length + cfg.emailRecipients.length > 0 };
  }
}

@Controller('notification-config')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.notifications.getConfig(user.tenantId);
  }

  @Put()
  @Roles('admin')
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateNotificationConfigDto) {
    return this.notifications.setConfig(user.tenantId, dto);
  }

  @Post('test')
  @Roles('admin', 'operator')
  @HttpCode(200)
  test(@CurrentUser() user: AuthUser) {
    return this.notifications.sendTest(user.tenantId);
  }
}
