import { IsEmail, IsString, MinLength } from 'class-validator';

export class RegisterTenantDto {
  @IsString()
  @MinLength(2)
  tenantName!: string;

  @IsEmail()
  adminEmail!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}

export class MfaVerifyDto {
  @IsString()
  mfaToken!: string;

  @IsString()
  @MinLength(6)
  code!: string;
}

export class MfaCodeDto {
  @IsString()
  @MinLength(6)
  code!: string;
}
