/** biome-ignore-all lint/style/noNonNullAssertion: x */
/** biome-ignore-all lint/suspicious/noExplicitAny: x */

export class Container<T extends Container.Service> {
  #services: Map<Container.Injectable, Container.Entry>;
  #entry: Container.Entry<T>;
  #resolved: boolean;

  #onDisposeError: (injectable: Container.Injectable, instance: Container.Service, error: unknown) => void;

  constructor(injectable: Container.Injectable<T>, factory: (injector: Container.Injector) => T, options?: Container.Options) {
    this.#services = new Map();
    this.#entry = this.#create(injectable, factory);
    this.#services.set(injectable, this.#entry);
    this.#resolved = false;

    this.#onDisposeError = options?.onDisposeError || (() => {});
  }

  provide<T extends Container.Service>(injectable: Container.Injectable<T>, factory: (injector: Container.Injector) => T) {
    if (this.#resolved) {
      throw new Error(`Cannot provide new services after container has been resolved.`);
    }

    if (this.#services.has(injectable)) {
      throw new Error(`Service ${injectable.name} already provided`);
    }

    this.#services.set(injectable, this.#create(injectable, factory));
  }

  resolve() {
    const instance = this.#resolve(this.#entry.injectable, []);

    for (const entry of this.#services.values()) {
      if (entry !== this.#entry && entry.dependents.size === 0) {
        this.#services.delete(entry.injectable);
      }
    }

    this.#resolved = true;

    return instance as T;
  }

  async initialize(signal: AbortSignal) {
    if (!this.#resolved) {
      throw new Error("Container has not been resolved");
    }

    if (signal.aborted) {
      throw signal.reason;
    }

    try {
      await this.#initialize(this.#entry, signal);
    } catch (error) {
      // When initialization is aborted (or fails for any other reason),
      // we must release every resource that has already been created.
      try {
        await this.dispose(error);
      } catch {
        // Preserve the original error over any rollback failure.
      }

      throw error;
    }
  }

  async dispose(reason?: unknown) {
    if (!this.#resolved) {
      throw new Error("Container has not been resolved");
    }

    for (const entry of this.#services.values()) {
      if (entry.dependencies.size === 0) {
        await this.#dispose(entry, reason);
      }
    }
  }

  #create<T extends Container.Service>(injectable: Container.Injectable<T>, factory: (injector: Container.Injector) => T) {
    return {
      injectable,
      dependencies: new Set(),
      dependents: new Set(),
      instance: null,
      factory,
      initialized: false,
      initializing: null,
      disposed: false,
      disposing: null,
    } satisfies Container.Entry<T> as Container.Entry<T>;
  }

  #resolve<T extends Container.Service>(injectable: Container.Injectable<T>, stack: Container.Injectable[]): T {
    const index = stack.indexOf(injectable);

    if (index !== -1) {
      throw new Error(`Circular dependency detected: ${[...stack.slice(index), injectable].map((item) => item.name).join(" -> ")}`);
    }

    const entry = this.#services.get(injectable);

    if (!entry) {
      throw new Error(`Service ${injectable.name} not provided`);
    }

    if (entry.instance !== null) {
      return entry.instance as T;
    }

    const nextStack = [...stack, injectable];
    const dependencies = new Set<Container.Entry>();

    let active = true;

    const injector: Container.Injector = {
      inject: <U extends Container.Service>(dependency: Container.Injectable<U>): U | null => {
        if (!active) {
          throw new Error("Injector is no longer active. inject() can only be called during factory execution.");
        }

        const dependencyEntry = this.#services.get(dependency);

        if (!dependencyEntry) {
          return null;
        }

        const instance = this.#resolve(dependency, nextStack);

        dependencies.add(dependencyEntry);

        return instance;
      },

      injectMust: <U extends Container.Service>(dependency: Container.Injectable<U>): U => {
        const instance = injector.inject(dependency);

        if (!instance) {
          throw new Error(`Service ${dependency.name} not provided`);
        }

        return instance;
      },

      injectAny: <U extends Container.Service>(dependency: Container.Injectable<U>): U[] => {
        if (!active) {
          throw new Error("Injector is no longer active. injectAny() can only be called during factory execution.");
        }

        const instances: U[] = [];

        for (const candidate of this.#services.values()) {
          if (candidate.injectable === dependency) {
            continue;
          }

          if (!(candidate.injectable.prototype instanceof dependency)) {
            continue;
          }

          const instance = this.#resolve(candidate.injectable, nextStack);

          dependencies.add(candidate);
          instances.push(instance as U);
        }

        return instances;
      },
    };

    try {
      const instance = entry.factory(injector);

      if (!(instance instanceof entry.injectable)) {
        throw new Error(`Factory for ${entry.injectable.name} returned an invalid instance`);
      }

      entry.instance = instance;

      /*
       * Commit dependency relationships only after
       * the factory has successfully completed.
       */
      for (const dependency of dependencies) {
        entry.dependencies.add(dependency);
        dependency.dependents.add(entry);
      }

      return instance as T;
    } finally {
      active = false;
    }
  }

  async #initialize(entry: Container.Entry, signal: AbortSignal) {
    if (entry.disposed) {
      throw new Error(`Cannot initialize disposed service ${entry.injectable.name}`);
    }

    if (entry.disposing) {
      throw new Error(`Cannot initialize service ${entry.injectable.name} while it is disposing`);
    }

    if (entry.initialized) {
      return;
    }

    if (entry.initializing) {
      return entry.initializing;
    }

    if (signal.aborted) {
      throw signal.reason;
    }

    entry.initializing = Promise.resolve()
      .then(async () => {
        for (const dependency of entry.dependencies) {
          if (signal.aborted) {
            throw signal.reason;
          }

          await this.#initialize(dependency, signal);
        }

        if (signal.aborted) {
          throw signal.reason;
        }

        await entry.instance![Container.SymbolInitialize]?.(signal);

        entry.initialized = true;

        if (signal.aborted) {
          throw signal.reason;
        }
      })
      .finally(() => {
        entry.initializing = null;
      });

    return entry.initializing;
  }

  async #dispose(entry: Container.Entry, reason?: unknown) {
    if (entry.disposed) {
      return;
    }

    if (entry.disposing) {
      return entry.disposing;
    }

    if (entry.initializing) {
      await entry.initializing.catch(() => {});
    }

    if (!entry.initialized) {
      entry.disposed = true;
      return;
    }

    entry.disposing = Promise.resolve()
      .then(async () => {
        for (const dependent of entry.dependents) {
          await this.#dispose(dependent, reason);
        }

        try {
          await entry.instance![Container.SymbolDispose]?.(reason);
        } catch (error) {
          this.#onDisposeError(entry.injectable, entry.instance!, error);
        }

        entry.disposed = true;
      })
      .finally(() => {
        entry.disposing = null;
      });

    return entry.disposing;
  }
}

export namespace Container {
  export interface Service {
    [SymbolInitialize]?: (signal: AbortSignal) => Promise<void>;
    [SymbolDispose]?: (reason?: unknown) => Promise<void>;
  }

  export interface Injector {
    inject<T extends Service>(injectable: Injectable<T>): T | null;
    injectMust<T extends Service>(injectable: Injectable<T>): T;
    injectAny<T extends Service>(injectable: Injectable<T>): T[];
  }

  export const SymbolDispose = Symbol("Container.ServiceDispose");
  export const SymbolInitialize = Symbol("Container.ServiceInitialize");

  export type AbstractConstructable<T = unknown> = abstract new (...args: any[]) => T;
  export type Constructable<T = unknown> = new (...args: any[]) => T;
  export type Injectable<T extends Service = Service> = AbstractConstructable<T> | Constructable<T>;

  export type Entry<T extends Service = Service> = {
    injectable: Injectable<T>;
    dependencies: Set<Entry>;
    dependents: Set<Entry>;
    instance: T | null;
    factory: (injector: Injector) => T;
    disposing: Promise<void> | null;
    initializing: Promise<void> | null;
    initialized: boolean;
    disposed: boolean;
  };

  export class ServiceConstructable implements Service {
    // biome-ignore lint/correctness/noUnusedFunctionParameters: x
    protected async initialize(signal: AbortSignal) {}
    // biome-ignore lint/correctness/noUnusedFunctionParameters: x
    protected async dispose(reason?: unknown) {}

    get [SymbolInitialize]() {
      return this.initialize.bind(this);
    }

    get [SymbolDispose]() {
      return this.dispose.bind(this);
    }
  }

  export type Options = {
    onDisposeError?: (injectable: Injectable, instance: Service, error: unknown) => void;
  };
}
