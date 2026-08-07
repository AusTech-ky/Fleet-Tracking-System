import { Controller, Get } from '@nestjs/common';
import { Public } from './common/auth';

@Controller()
export class HealthController {
  @Public()
  @Get('healthz')
  healthz() {
    return { status: 'ok' };
  }
}
