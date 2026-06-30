export class Authenticator {
  async init() {}
}

export namespace Authenticator {
  export type AuthenticatedUser = {
    identity: "user";
    id: string;
  };
  export type AuthenticatedWorker = {
    identity: "worker";
    id: string;
  };
  export type AuthenticatedManager = {
    identity: "manager";
  };

  export type Authenticated = AuthenticatedUser | AuthenticatedWorker | AuthenticatedManager;
}
