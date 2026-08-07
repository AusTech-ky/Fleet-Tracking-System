import { Body, Controller, Post, HttpCode } from '@nestjs/common';
import { CurrentUser, Public, type AuthUser } from '../../common/auth';
import { AuthService } from './auth.service';
import { RegisterTenantDto, LoginDto, MfaVerifyDto, MfaCodeDto } from './dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register-tenant')
  register(@Body() dto: RegisterTenantDto) {
    return this.auth.registerTenant(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(200)
  verifyMfa(@Body() dto: MfaVerifyDto) {
    return this.auth.verifyMfa(dto.mfaToken, dto.code);
  }

  // The following require a valid access token (global guard applies).

  @Post('mfa/setup')
  @HttpCode(200)
  setupMfa(@CurrentUser() user: AuthUser) {
    return this.auth.setupMfa(user.userId);
  }

  @Post('mfa/enable')
  @HttpCode(200)
  enableMfa(@CurrentUser() user: AuthUser, @Body() dto: MfaCodeDto) {
    return this.auth.enableMfa(user.userId, dto.code);
  }

  @Post('mfa/disable')
  @HttpCode(200)
  disableMfa(@CurrentUser() user: AuthUser, @Body() dto: MfaCodeDto) {
    return this.auth.disableMfa(user.userId, dto.code);
  }
}
