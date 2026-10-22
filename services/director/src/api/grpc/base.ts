import { Logger } from "@aw/logging";
import { Authenticator } from "@/internal/authenticator";
import { GRPCHandler } from "@/internal/grpc-handler";

const AUTHENTICATION_IDENTITY_CONTEXT = GRPCHandler.Context.key<Authenticator.Identity>();

export abstract class Base extends GRPCHandler.Service {
  #authenticator: Authenticator;
  #logger: Logger;

  constructor(...deps: [Authenticator, Logger]) {
    super();

    this.#authenticator = deps[0];
    this.#logger = deps[1];
  }

  protected createAuthenticationInterceptor() {
    const interceptor: GRPCHandler.Interceptor = (next) => {
      return async (request) => {
        let identity: Authenticator.Identity;

        try {
          identity = await this.#authenticator.authenticate(request.context.incomingHeaders);
        } catch (error) {
          this.#logger.warn("Authentication failed.", { err: error });

          throw GRPCHandler.Error.unauthenticated("Unauthenticated", undefined, undefined, error);
        }

        request.context.set(AUTHENTICATION_IDENTITY_CONTEXT, identity);

        return next(request);
      };
    };

    return interceptor;
  }

  protected createAccessControlInterceptor(...allowedTypes: [Authenticator.Identity["type"], ...Authenticator.Identity["type"][]]) {
    const interceptor: GRPCHandler.Interceptor = (next) => {
      return async (request) => {
        const identity = this.getAuthenticationIdentityMust(request.context);

        if (!allowedTypes.includes(identity.type)) {
          throw GRPCHandler.Error.permissionDenied("Access denied.");
        }

        return next(request);
      };
    };

    return interceptor;
  }

  // biome-ignore format: x
  protected getAuthenticationIdentity(context: GRPCHandler.Context): Authenticator.Identity | undefined;
  // biome-ignore format: x
  protected getAuthenticationIdentity<T extends [Authenticator.Identity["type"], ...Authenticator.Identity["type"][]]>(context: GRPCHandler.Context, ...types: T): Extract<Authenticator.Identity, { type: T[number] }> | undefined;

  protected getAuthenticationIdentity(ctx: GRPCHandler.Context, ...types: Authenticator.Identity["type"][]) {
    const identity = ctx.get(AUTHENTICATION_IDENTITY_CONTEXT);

    if (!identity) {
      return undefined;
    }

    if (types.length > 0 && !types.some((type) => type === identity.type)) {
      throw GRPCHandler.Error.permissionDenied("Access denied");
    }

    return identity;
  }

  // biome-ignore format: x
  protected getAuthenticationIdentityMust(context: GRPCHandler.Context): Authenticator.Identity;
  // biome-ignore format: x
  protected getAuthenticationIdentityMust<T extends [Authenticator.Identity["type"], ...Authenticator.Identity["type"][]]>(context: GRPCHandler.Context, ...types: T): Extract<Authenticator.Identity, { type: T[number] }>;

  protected getAuthenticationIdentityMust(context: GRPCHandler.Context, ...types: Authenticator.Identity["type"][]) {
    const identity = this.getAuthenticationIdentity(context);

    if (!identity) {
      throw GRPCHandler.Error.unauthenticated("Unauthenticated");
    }

    if (types.length > 0 && !types.some((type) => type === identity.type)) {
      throw GRPCHandler.Error.permissionDenied("Access denied");
    }

    return identity;
  }
}
