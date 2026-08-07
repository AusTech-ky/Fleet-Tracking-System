import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { GqlExecutionContext } from '@nestjs/graphql';

/**
 * ThrottlerGuard that also understands GraphQL requests — the base guard only
 * reads the HTTP context, so without this a GraphQL request has no request to
 * rate-limit against (and errors). Rate limiting still applies to /graphql.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  getRequestResponse(context: ExecutionContext) {
    if (context.getType<'graphql'>() === 'graphql') {
      const gql = GqlExecutionContext.create(context).getContext();
      return { req: gql.req, res: gql.req?.res };
    }
    return super.getRequestResponse(context);
  }
}
