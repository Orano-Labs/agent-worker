import { describe, expect, it, vi } from "vitest";
import { Container } from "./index";

// ---------------------------------------------------------------------------
// 通用测试用服务
// ---------------------------------------------------------------------------

class RootService extends Container.ServiceConstructable {
  name = "RootService";
  initialized = false;
  disposed = false;
  signalAborted = false;

  constructor(public dep?: SubServiceA) {
    super();
  }

  override async initialize(signal: AbortSignal) {
    if (signal.aborted) this.signalAborted = true;
    this.initialized = true;
  }

  override async dispose() {
    this.disposed = true;
  }
}

class SubServiceA extends Container.ServiceConstructable {
  name = "SubServiceA";
  initialized = false;
  disposed = false;

  constructor(public dep?: SubServiceB) {
    super();
  }

  override async initialize(_signal: AbortSignal) {
    this.initialized = true;
  }

  override async dispose() {
    this.disposed = true;
  }
}

class SubServiceB extends Container.ServiceConstructable {
  name = "SubServiceB";
  initialized = false;
  disposed = false;

  override async initialize(_signal: AbortSignal) {
    this.initialized = true;
  }

  override async dispose() {
    this.disposed = true;
  }
}

class CircularA extends Container.ServiceConstructable {
  name = "CircularA";
}

class CircularB extends Container.ServiceConstructable {
  name = "CircularB";
}

describe("Container", () => {
  describe("Provide & Resolve", () => {
    it("should successfully resolve entry service as singleton", () => {
      const container = new Container(RootService, () => new RootService());
      const instance1 = container.resolve();
      const instance2 = container.resolve();

      expect(instance1).toBeInstanceOf(RootService);
      expect(instance1).toBe(instance2);
    });

    it("should allow providing dependencies and injecting them into root service", () => {
      const container = new Container(RootService, (injector) => {
        const subA = injector.injectMust(SubServiceA);
        return new RootService(subA);
      });

      container.provide(SubServiceA, () => new SubServiceA());

      const root = container.resolve();
      expect(root.dep).toBeInstanceOf(SubServiceA);
    });

    it("should throw error when providing the same service twice", () => {
      const container = new Container(RootService, () => new RootService());
      container.provide(SubServiceA, () => new SubServiceA());

      expect(() => {
        container.provide(SubServiceA, () => new SubServiceA());
      }).toThrow("Service SubServiceA already provided");
    });

    it("should throw error when providing a service after resolution", () => {
      const container = new Container(RootService, () => new RootService());
      container.resolve();

      expect(() => {
        container.provide(SubServiceA, () => new SubServiceA());
      }).toThrow("Cannot provide new services after container has been resolved.");
    });

    it("should return null when using inject for unprovided optional service", () => {
      let injectedValue: SubServiceA | null = new SubServiceA();

      const container = new Container(RootService, (injector) => {
        injectedValue = injector.inject(SubServiceA);
        return new RootService();
      });

      container.resolve();
      expect(injectedValue).toBeNull();
    });

    it("should throw error when using injectMust for unprovided service", () => {
      const container = new Container(RootService, (injector) => {
        injector.injectMust(SubServiceA);
        return new RootService();
      });

      expect(() => container.resolve()).toThrow("Service SubServiceA not provided");
    });

    it("should throw error if factory returns an invalid instance", () => {
      // @ts-expect-error Intentionally returning invalid object to test runtime validation
      const container = new Container(RootService, () => ({ name: "RootService" }));

      expect(() => container.resolve()).toThrow("Factory for RootService returned an invalid instance");
    });

    it("should propagate an arbitrary error thrown by a factory", () => {
      const boom = new Error("factory boom");
      const container = new Container(RootService, () => {
        throw boom;
      });

      expect(() => container.resolve()).toThrow(boom);
    });
  });

  describe("Circular Dependency Detection", () => {
    it("should throw error showing precise resolution path on circular dependencies", () => {
      const container = new Container(CircularA, (injector) => {
        injector.injectMust(CircularB);
        return new CircularA();
      });

      container.provide(CircularB, (injector) => {
        injector.injectMust(CircularA);
        return new CircularB();
      });

      expect(() => container.resolve()).toThrow("Circular dependency detected: CircularA -> CircularB -> CircularA");
    });
  });

  describe("Injector Scope Guard", () => {
    it("should disallow asynchronous calling of injector.inject after factory completes", async () => {
      let leakedInjector: Container.Injector;

      const container = new Container(RootService, (injector) => {
        leakedInjector = injector;
        return new RootService();
      });

      container.provide(SubServiceA, () => new SubServiceA());
      container.resolve();

      expect(() => leakedInjector.inject(SubServiceA)).toThrow(
        "Injector is no longer active. inject() can only be called during factory execution.",
      );
    });
  });

  describe("Initialization Lifecycle", () => {
    it("should throw error when calling initialize before container is resolved", async () => {
      const container = new Container(RootService, () => new RootService());
      const controller = new AbortController();

      await expect(container.initialize(controller.signal)).rejects.toThrow("Container has not been resolved");
    });

    it("should initialize dependencies in topological order (dependencies first)", async () => {
      const initOrder: string[] = [];

      class ServiceA extends Container.ServiceConstructable {
        name = "ServiceA";
        override async initialize() {
          initOrder.push("ServiceA");
        }
      }

      class ServiceB extends Container.ServiceConstructable {
        name = "ServiceB";
        constructor(public a: ServiceA) {
          super();
        }
        override async initialize() {
          initOrder.push("ServiceB");
        }
      }

      const container = new Container(ServiceB, (injector) => {
        return new ServiceB(injector.injectMust(ServiceA));
      });
      container.provide(ServiceA, () => new ServiceA());

      container.resolve();

      const controller = new AbortController();
      await container.initialize(controller.signal);

      expect(initOrder).toEqual(["ServiceA", "ServiceB"]);
    });

    it("should reject initialize if AbortSignal is already aborted", async () => {
      const container = new Container(RootService, () => new RootService());
      container.resolve();

      const controller = new AbortController();
      controller.abort(new Error("Operation aborted"));

      await expect(container.initialize(controller.signal)).rejects.toThrow("Operation aborted");
    });

    it("should not re-trigger instance initialize method on redundant initialize calls", async () => {
      const container = new Container(RootService, () => new RootService());
      const root = container.resolve();

      const spy = vi.spyOn(root, "initialize");
      const controller = new AbortController();

      await container.initialize(controller.signal);
      await container.initialize(controller.signal);

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("should forward the same AbortSignal to every service's SymbolInitialize", async () => {
      const received: AbortSignal[] = [];

      class ServiceA extends Container.ServiceConstructable {
        override async initialize(signal: AbortSignal) {
          received.push(signal);
        }
      }

      class Root extends Container.ServiceConstructable {
        constructor(public a: ServiceA) {
          super();
        }
        override async initialize(signal: AbortSignal) {
          received.push(signal);
        }
      }

      const container = new Container(Root, (injector) => new Root(injector.injectMust(ServiceA)));
      container.provide(ServiceA, () => new ServiceA());
      container.resolve();

      const controller = new AbortController();
      await container.initialize(controller.signal);

      // 依赖先被初始化 -> 顺序是 [ServiceA, Root]
      expect(received).toHaveLength(2);
      expect(received[0]).toBe(controller.signal);
      expect(received[1]).toBe(controller.signal);
    });

    it("should initialize a shared dependency (diamond) exactly once", async () => {
      const calls = { c: 0, a: 0, b: 0, root: 0 };

      class ServiceC extends Container.ServiceConstructable {
        override async initialize() {
          calls.c++;
        }
      }

      class ServiceA extends Container.ServiceConstructable {
        constructor(public c: ServiceC) {
          super();
        }
        override async initialize() {
          calls.a++;
        }
      }

      class ServiceB extends Container.ServiceConstructable {
        constructor(public c: ServiceC) {
          super();
        }
        override async initialize() {
          calls.b++;
        }
      }

      class Root extends Container.ServiceConstructable {
        constructor(
          public a: ServiceA,
          public b: ServiceB,
        ) {
          super();
        }
        override async initialize() {
          calls.root++;
        }
      }

      const container = new Container(Root, (injector) => new Root(injector.injectMust(ServiceA), injector.injectMust(ServiceB)));
      container.provide(ServiceA, (injector) => new ServiceA(injector.injectMust(ServiceC)));
      container.provide(ServiceB, (injector) => new ServiceB(injector.injectMust(ServiceC)));
      container.provide(ServiceC, () => new ServiceC());

      container.resolve();
      await container.initialize(new AbortController().signal);

      expect(calls).toEqual({ c: 1, a: 1, b: 1, root: 1 });
    });

    it("should roll back all already-initialized services when initialization is aborted", async () => {
      const controller = new AbortController();
      const events: string[] = [];

      class ServiceC extends Container.ServiceConstructable {
        override async initialize() {
          events.push("init-C");
        }
        override async dispose() {
          events.push("dispose-C");
        }
      }

      class ServiceB extends Container.ServiceConstructable {
        constructor(public c: ServiceC) {
          super();
        }
        override async initialize() {
          events.push("init-B");
          // 在 B 初始化时中止 -> 上层检查 signal.aborted 时会抛错
          controller.abort(new Error("aborted during B"));
        }
        override async dispose() {
          events.push("dispose-B");
        }
      }

      class ServiceA extends Container.ServiceConstructable {
        constructor(public b: ServiceB) {
          super();
        }
        override async initialize() {
          events.push("init-A");
        }
        override async dispose() {
          events.push("dispose-A");
        }
      }

      class Root extends Container.ServiceConstructable {
        constructor(public a: ServiceA) {
          super();
        }
        override async initialize() {
          events.push("init-root");
        }
        override async dispose() {
          events.push("dispose-root");
        }
      }

      const container = new Container(Root, (injector) => new Root(injector.injectMust(ServiceA)));
      container.provide(ServiceA, (injector) => new ServiceA(injector.injectMust(ServiceB)));
      container.provide(ServiceB, (injector) => new ServiceB(injector.injectMust(ServiceC)));
      container.provide(ServiceC, () => new ServiceC());

      container.resolve();

      await expect(container.initialize(controller.signal)).rejects.toThrow("aborted during B");

      // 成功初始化的是 C、B；A 和 Root 都没有进入初始化。
      // rollback 必须释放 C 和 B，且顺序是先 B 后 C。
      expect(events).toEqual(["init-C", "init-B", "dispose-B", "dispose-C"]);
    });

    it("should skip SymbolDispose for entries that never finished initializing during rollback", async () => {
      const controller = new AbortController();
      const disposed: string[] = [];

      class ServiceC extends Container.ServiceConstructable {
        override async initialize() {
          /* 正常完成 */
        }
        override async dispose() {
          disposed.push("C");
        }
      }

      class ServiceB extends Container.ServiceConstructable {
        constructor(public c: ServiceC) {
          super();
        }
        override async initialize() {
          controller.abort(new Error("abort during B"));
          // 初始化过程中抛错 -> B 永远不会被标记为 initialized
          throw new Error("B failed");
        }
        override async dispose() {
          disposed.push("B");
        }
      }

      class Root extends Container.ServiceConstructable {
        constructor(public b: ServiceB) {
          super();
        }
        override async initialize() {
          /* 不会被调用 */
        }
        override async dispose() {
          disposed.push("Root");
        }
      }

      const container = new Container(Root, (injector) => new Root(injector.injectMust(ServiceB)));
      container.provide(ServiceB, (injector) => new ServiceB(injector.injectMust(ServiceC)));
      container.provide(ServiceC, () => new ServiceC());

      container.resolve();

      await expect(container.initialize(controller.signal)).rejects.toThrow("B failed");

      // B 从未 initialize 成功 -> 不能调用它的 SymbolDispose；
      // 但 C 已经初始化了 -> 必须释放。
      expect(disposed).toEqual(["C"]);
    });

    it("should reject a second initialize call after a rollback has disposed the graph", async () => {
      const controller = new AbortController();

      class Root extends Container.ServiceConstructable {
        override async initialize() {
          controller.abort(new Error("abort during root"));
        }
      }

      const container = new Container(Root, () => new Root());
      container.resolve();

      // 第一次 initialize: 中止 -> rollback -> 整个图标记 disposed。
      await expect(container.initialize(controller.signal)).rejects.toThrow("abort during root");

      // 第二次 initialize: 因为 entry 已经被 rollback 标记 disposed，必须抛错。
      await expect(container.initialize(new AbortController().signal)).rejects.toThrow("Cannot initialize disposed service Root");
    });

    it("should be a no-op to dispose again after a rollback", async () => {
      const controller = new AbortController();

      class Root extends Container.ServiceConstructable {
        override async initialize() {
          controller.abort(new Error("abort during root"));
        }
      }

      const container = new Container(Root, () => new Root());
      container.resolve();

      await expect(container.initialize(controller.signal)).rejects.toThrow("abort during root");

      // rollback 已经把服务都 disposed，重复 dispose 必须是无操作。
      await expect(container.dispose()).resolves.toBeUndefined();
    });
  });

  describe("Disposal Lifecycle", () => {
    it("should throw error when calling dispose before container is resolved", async () => {
      const container = new Container(RootService, () => new RootService());

      await expect(container.dispose()).rejects.toThrow("Container has not been resolved");
    });

    it("should dispose dependencies in reverse topological order (dependents first)", async () => {
      const disposeOrder: string[] = [];

      class ServiceA extends Container.ServiceConstructable {
        name = "ServiceA";
        override async dispose() {
          disposeOrder.push("ServiceA");
        }
      }

      class ServiceB extends Container.ServiceConstructable {
        name = "ServiceB";
        constructor(public a: ServiceA) {
          super();
        }
        override async dispose() {
          disposeOrder.push("ServiceB");
        }
      }

      const container = new Container(ServiceB, (injector) => {
        return new ServiceB(injector.injectMust(ServiceA));
      });

      container.provide(ServiceA, () => new ServiceA());
      container.resolve();

      const controller = new AbortController();
      await container.initialize(controller.signal);
      await container.dispose();

      expect(disposeOrder).toEqual(["ServiceB", "ServiceA"]);
    });

    it("should not re-trigger instance dispose method on redundant dispose calls", async () => {
      const container = new Container(RootService, () => new RootService());
      const root = container.resolve();

      const spy = vi.spyOn(root, "dispose");
      const controller = new AbortController();

      await container.initialize(controller.signal);
      await container.dispose();
      await container.dispose();

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("should dispose a shared dependency only after all its dependents (diamond)", async () => {
      const order: string[] = [];

      class ServiceC extends Container.ServiceConstructable {
        override async dispose() {
          order.push("C");
        }
      }

      class ServiceA extends Container.ServiceConstructable {
        constructor(public c: ServiceC) {
          super();
        }
        override async dispose() {
          order.push("A");
        }
      }

      class ServiceB extends Container.ServiceConstructable {
        constructor(public c: ServiceC) {
          super();
        }
        override async dispose() {
          order.push("B");
        }
      }

      class Root extends Container.ServiceConstructable {
        constructor(
          public a: ServiceA,
          public b: ServiceB,
        ) {
          super();
        }
        override async dispose() {
          order.push("Root");
        }
      }

      const container = new Container(Root, (injector) => new Root(injector.injectMust(ServiceA), injector.injectMust(ServiceB)));
      container.provide(ServiceA, (injector) => new ServiceA(injector.injectMust(ServiceC)));
      container.provide(ServiceB, (injector) => new ServiceB(injector.injectMust(ServiceC)));
      container.provide(ServiceC, () => new ServiceC());

      container.resolve();
      await container.initialize(new AbortController().signal);
      await container.dispose();

      // C 必须最后被释放，且 A、B 在 C 之前。
      expect(order).toContain("Root");
      expect(order.indexOf("A")).toBeLessThan(order.indexOf("C"));
      expect(order.indexOf("B")).toBeLessThan(order.indexOf("C"));
      expect(order[order.length - 1]).toBe("C");
    });

    it("should invoke onDisposeError when a service's dispose throws", async () => {
      const captured: Array<{ injectable: unknown; instance: unknown; error: unknown }> = [];

      class FailingDispose extends Container.ServiceConstructable {
        override async dispose() {
          throw new Error("dispose boom");
        }
      }

      const container = new Container(FailingDispose, () => new FailingDispose(), {
        onDisposeError: (injectable, instance, error) => {
          captured.push({ injectable, instance, error });
        },
      });

      container.resolve();
      await container.initialize(new AbortController().signal);
      await container.dispose();

      expect(captured).toHaveLength(1);
      expect(captured[0].injectable).toBe(FailingDispose);
      expect(captured[0].instance).toBeInstanceOf(FailingDispose);
      expect((captured[0].error as Error).message).toBe("dispose boom");
    });

    it("should continue disposing remaining services even if one dispose throws", async () => {
      const disposed: string[] = [];

      class FailingService extends Container.ServiceConstructable {
        override async dispose() {
          throw new Error("boom");
        }
      }

      class OkService extends Container.ServiceConstructable {
        override async dispose() {
          disposed.push("Ok");
        }
      }

      class Root extends Container.ServiceConstructable {
        constructor(
          public bad: FailingService,
          public ok: OkService,
        ) {
          super();
        }
        override async dispose() {
          disposed.push("Root");
        }
      }

      const container = new Container(Root, (injector) => new Root(injector.injectMust(FailingService), injector.injectMust(OkService)), {
        onDisposeError: () => {},
      });
      container.provide(FailingService, () => new FailingService());
      container.provide(OkService, () => new OkService());

      container.resolve();
      await container.initialize(new AbortController().signal);
      await container.dispose();

      // 即使 FailingService.dispose 抛错，其他服务仍必须被释放。
      expect(disposed).toContain("Root");
      expect(disposed).toContain("Ok");
    });

    it("should not throw when disposing a service that was never initialized", async () => {
      // 通过 rollback 让一个已 resolve 但未初始化的图被释放，
      // 然后再次显式 dispose —— 必须保持 no-op。
      const controller = new AbortController();

      class Root extends Container.ServiceConstructable {
        override async initialize() {
          controller.abort(new Error("abort"));
        }
      }

      const container = new Container(Root, () => new Root());
      container.resolve();

      await expect(container.initialize(controller.signal)).rejects.toThrow("abort");

      // 二次 dispose 是 no-op，不应抛 "Cannot dispose ... before initialized"。
      await expect(container.dispose()).resolves.toBeUndefined();
    });
  });
});
