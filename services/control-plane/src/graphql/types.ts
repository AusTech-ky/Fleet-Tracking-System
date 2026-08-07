import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';

/** GraphQL object types — a read-friendly projection of the domain for partners. */

@ObjectType('Device')
export class DeviceType {
  @Field(() => ID) id!: string;
  @Field() imei!: string;
  @Field({ nullable: true }) name?: string;
  @Field() model!: string;
  @Field() status!: string;
  @Field(() => ID, { nullable: true }) departmentId!: string | null;
  @Field(() => ID, { nullable: true }) vehicleId!: string | null;
}

@ObjectType('Position')
export class PositionType {
  @Field(() => ID) deviceId!: string;
  @Field() imei!: string;
  @Field() ts!: string;
  @Field(() => Float) latitude!: number;
  @Field(() => Float) longitude!: number;
  @Field(() => Float) speedKph!: number;
  @Field(() => Int) heading!: number;
  @Field({ nullable: true }) ignition?: boolean;
}

@ObjectType('Alert')
export class AlertType {
  @Field(() => ID) id!: string;
  @Field(() => ID) deviceId!: string;
  @Field() imei!: string;
  @Field() type!: string;
  @Field() ts!: string;
  @Field() message!: string;
}

@ObjectType('Geofence')
export class GeofenceType {
  @Field(() => ID) id!: string;
  @Field() name!: string;
  @Field() kind!: string;
  @Field(() => Float, { nullable: true }) centerLat?: number;
  @Field(() => Float, { nullable: true }) centerLon?: number;
  @Field(() => Int, { nullable: true }) radiusM?: number;
  @Field(() => [[Float]], { nullable: true }) ring?: number[][];
}

@ObjectType('Me')
export class MeType {
  @Field(() => ID) userId!: string;
  @Field(() => ID) tenantId!: string;
  @Field() email!: string;
  @Field() role!: string;
  @Field(() => ID, { nullable: true }) departmentId!: string | null;
}

@ObjectType('PlanLimits')
export class PlanLimitsType {
  @Field(() => Int) devices!: number;
  @Field(() => Int) users!: number;
}

@ObjectType('Billing')
export class BillingType {
  @Field() planId!: string;
  @Field() planName!: string;
  @Field(() => PlanLimitsType) limits!: PlanLimitsType;
  @Field(() => Int) devicesUsed!: number;
  @Field(() => Int) usersUsed!: number;
}
