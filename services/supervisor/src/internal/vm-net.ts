import { Container } from "@aw/container";
import { Logger } from "@aw/logging";
import { default as Lock } from "async-lock";
import { Shell } from "@/internal/shell";

export class VMNet extends Container.ServiceConstructable {
  #logger: Logger;
  #lock: Lock;
  #shell: Shell;

  constructor(...deps: [Logger, Shell]) {
    super();

    this.#logger = deps[0].namespace("VMNet");
    this.#shell = deps[1];
    this.#lock = new Lock();
  }

  #namespace(slot: number) {
    if (!Number.isInteger(slot) || slot < VMNet.NS_MIN_SLOT || slot > VMNet.NS_MAX_SLOT) {
      throw new Error(`Invalid slot: ${slot}. Range: ${VMNet.NS_MIN_SLOT}-${VMNet.NS_MAX_SLOT}`);
    }

    const octet = Math.floor(slot / 64);
    const start = (slot % 64) * 4;
    const hex = slot.toString(16).padStart(4, "0");

    const ns: VMNet.Namespace = {
      slot: slot,
      name: `aw-${hex}`,
      veth: {
        host: {
          name: `aw-vh-${hex}`,
          ip: `${VMNet.NS_VETH_PREFIX}.${octet}.${start + 1}`,
        },
        guest: {
          name: `aw-vg-${hex}`,
          ip: `${VMNet.NS_VETH_PREFIX}.${octet}.${start + 2}`,
        },
      },
    };

    return ns;
  }

  async #install(ns: VMNet.Namespace, signal: AbortSignal) {
    this.#logger.info(`Starting network workspace deployment for slot [${ns.slot}] (Namespace: ${ns.name})...`);

    const $ = this.#shell.session({ signal, logger: this.#logger.namespace(ns.name) });

    try {
      this.#logger.info(`Allocating topological addresses: Host VETH: ${ns.veth.host.ip}/30, Guest VETH: ${ns.veth.guest.ip}/30`);

      // 创建硬隔离的网络命名空间，并建立一对连接宿主机与该命名空间的虚拟网线（veth pair）
      // 分配 /30 精简子网 IP 并激活宿主机端网卡，将 MTU 统一设为 1500
      await $`ip netns add ${ns.name}`;
      await $`ip link add ${ns.veth.host.name} type veth peer name ${ns.veth.guest.name}`;
      await $`ip link set ${ns.veth.guest.name} netns ${ns.name}`;
      await $`ip addr add ${ns.veth.host.ip}/30 dev ${ns.veth.host.name}`;
      await $`ip link set ${ns.veth.host.name} up`;
      await $`ip link set ${ns.veth.host.name} mtu 1500`;

      // 进入命名空间内部，配置并激活虚拟网线出口端（guest）的 IP 和 MTU
      // 同时激活本地回环接口（lo），保障内部网络栈基础进程的正常运转
      await $`ip netns exec ${ns.name} ip link set ${ns.veth.guest.name} mtu 1500`;
      await $`ip netns exec ${ns.name} ip addr add ${ns.veth.guest.ip}/30 dev ${ns.veth.guest.name}`;
      await $`ip netns exec ${ns.name} ip link set ${ns.veth.guest.name} up`;
      await $`ip netns exec ${ns.name} ip link set lo up`;

      // 创建并激活二层虚拟网卡（TAP 设备）用以桥接虚机，并分配 /24 子网 IP 作为其内网网关
      await $`ip netns exec ${ns.name} ip tuntap add ${VMNet.TAP} mode tap`;
      await $`ip netns exec ${ns.name} ip addr add ${VMNet.TAP_NS_IP}/24 dev ${VMNet.TAP}`;
      await $`ip netns exec ${ns.name} ip link set ${VMNet.TAP} up`;

      // 配置全局默认路由，将命名空间内所有去往外网的流量定向到虚拟网线的宿主机端
      await $`ip netns exec ${ns.name} ip route add default via ${ns.veth.host.ip}`;

      // 开启内核 IP 转发使其具备路由能力，并启用严格的反向路径过滤（rp_filter）防范 IP 欺骗
      await $`ip netns exec ${ns.name} sysctl -w net.ipv4.ip_forward=1`;
      // await $`ip netns exec ${ns.name} sysctl -w net.ipv4.conf.all.rp_filter=1`;
      // await $`ip netns exec ${ns.name} sysctl -w net.ipv4.conf.default.rp_filter=1`;

      const dnsSet = `{ ${VMNet.DNS_RESOLVERS.join(", ")} }`;
      const privateCIDRSet = `{ ${VMNet.PRIVATE_CIDRS.join(", ")} }`;

      this.#logger.info(`Compiling security isolation firewalls for ${ns.name} (Table: ${VMNet.NFT_TABLE_FILTER})...`);

      // 初始化 nftables 过滤表并挂载转发链，优先放行已建立或关联的连接回包以提升吞吐
      await $`ip netns exec ${ns.name} nft delete table inet ${VMNet.NFT_TABLE_FILTER} 2>/dev/null || true`;
      await $`ip netns exec ${ns.name} nft add table inet ${VMNet.NFT_TABLE_FILTER}`;
      await $`ip netns exec ${ns.name} nft add chain inet ${VMNet.NFT_TABLE_FILTER} forward '{ type filter hook forward priority 0; policy drop; }'`;

      // 放行所有已建立连接及其回包
      await $`ip netns exec ${ns.name} nft add rule inet ${VMNet.NFT_TABLE_FILTER} forward ct state established,related accept`;

      // 硬拦截去往宿主机及物理私网的所有流量，彻底斩断对内网的窥探
      await $`ip netns exec ${ns.name} nft add rule inet ${VMNet.NFT_TABLE_FILTER} forward iifname ${VMNet.TAP} ip daddr ${privateCIDRSet} drop`;

      // 仅允许虚机访问白名单中的 DNS 服务器
      await $`ip netns exec ${ns.name} nft add rule inet ${VMNet.NFT_TABLE_FILTER} forward iifname ${VMNet.TAP} udp dport 53 ip daddr ${dnsSet} accept`;

      // 出网放行
      await $`ip netns exec ${ns.name} nft add rule inet ${VMNet.NFT_TABLE_FILTER} forward iifname ${VMNet.TAP} accept`;

      // 入网放行，无条件接受外部流向虚机（TAP）的所有合法响应流量
      await $`ip netns exec ${ns.name} nft add rule inet ${VMNet.NFT_TABLE_FILTER} forward iifname ${ns.veth.guest.name} oifname ${VMNet.TAP} accept`;

      this.#logger.info(`Compiling dynamic NAT topology rules for ${ns.name} (Table: ${VMNet.NFT_TABLE_NAT})...`);

      // 初始化 NAT 表并挂载路由前/后钩子链，用于后续处理虚机的出网伪装与入网映射
      await $`ip netns exec ${ns.name} nft add table ip ${VMNet.NFT_TABLE_NAT}`;
      await $`ip netns exec ${ns.name} nft add chain ip ${VMNet.NFT_TABLE_NAT} prerouting '{ type nat hook prerouting priority -100 ; }'`;
      await $`ip netns exec ${ns.name} nft add chain ip ${VMNet.NFT_TABLE_NAT} postrouting '{ type nat hook postrouting priority 100 ; }'`;

      // 出网执行 Masquerade (SNAT) 隐蔽虚机内网，入网执行 DNAT 将外网流量映射至虚机真实 IP
      await $`ip netns exec ${ns.name} nft add rule ip ${VMNet.NFT_TABLE_NAT} postrouting oifname ${ns.veth.guest.name} masquerade`;
      await $`ip netns exec ${ns.name} nft add rule ip ${VMNet.NFT_TABLE_NAT} prerouting iifname ${ns.veth.guest.name} ip daddr ${ns.veth.guest.ip} dnat to ${VMNet.TAP_VM_IP}`;

      // 向虚拟机暴露宿主机上的 TCP / UDP 端口
      // 1. 在 PREROUTING 阶段将发往网关固定 IP (10.123.0.1) 的流量，重定向到宿主机专属 veth IP
      // 2. 在 FORWARD 阶段通过 insert 强行置顶，确保被改写目的地后的私网流量不被后续的私网硬拦截规则杀掉

      if (VMNet.EXPOSED_HOST_TCP_PORTS.length > 0) {
        const ports = `{ ${VMNet.EXPOSED_HOST_TCP_PORTS.join(", ")} }`;

        this.#logger.info(`Injecting host TCP port safe-exposure hooks: ${ports} -> ${ns.veth.host.ip}`);

        await $`ip netns exec ${ns.name} nft add rule ip ${VMNet.NFT_TABLE_NAT} prerouting iifname ${VMNet.TAP} ip daddr ${VMNet.TAP_NS_IP} tcp dport ${ports} dnat to ${ns.veth.host.ip}`;
        await $`ip netns exec ${ns.name} nft insert rule inet ${VMNet.NFT_TABLE_FILTER} forward iifname ${VMNet.TAP} ip daddr ${ns.veth.host.ip} tcp dport ${ports} accept`;
      }

      if (VMNet.EXPOSED_HOST_UDP_PORTS.length > 0) {
        const ports = `{ ${VMNet.EXPOSED_HOST_UDP_PORTS.join(", ")} }`;

        this.#logger.info(`Injecting host UDP port safe-exposure hooks: ${ports} -> ${ns.veth.host.ip}`);

        await $`ip netns exec ${ns.name} nft add rule ip ${VMNet.NFT_TABLE_NAT} prerouting iifname ${VMNet.TAP} ip daddr ${VMNet.TAP_NS_IP} udp dport ${ports} dnat to ${ns.veth.host.ip}`;
        await $`ip netns exec ${ns.name} nft insert rule inet ${VMNet.NFT_TABLE_FILTER} forward iifname ${VMNet.TAP} ip daddr ${ns.veth.host.ip} udp dport ${ports} accept`;
      }

      this.#logger.info(`Network pipeline for slot [${ns.slot}] has been successfully established and locked.`);
    } catch (err) {
      this.#logger.error(`Critical failure deploying network slot [${ns.slot}]. Initiating rollback recovery...`, { err });

      await Promise.all([
        //
        $`ip link del ${ns.veth.host.name}`.catch(() => {}),
        $`ip netns del ${ns.name}`.catch(() => {}),
      ]);

      throw err;
    }
  }

  async #release(ns: VMNet.Namespace, signal: AbortSignal) {
    this.#logger.info(`Decommissioning network pipeline for slot [${ns.slot}] (${ns.name})...`);

    const $ = this.#shell.session({ signal, logger: this.#logger.namespace(ns.name) });

    await $`ip link del ${ns.veth.host.name}`.catch((err) => {
      this.#logger.warn(`Non-fatal warning during command teardown [ip link del ${ns.veth.host.name}]`, { err });
    });

    await $`ip netns del ${ns.name}`.catch((err) => {
      this.#logger.warn(`Non-fatal warning during command teardown [ip netns del ${ns.name}]`, { err });
    });

    this.#logger.info(`Slot [${ns.slot}] sandbox environment cleanly deleted.`);
  }

  async #getExistingNamespaces(signal: AbortSignal) {
    const $ = this.#shell.session({ signal, logger: this.#logger });

    return Promise.resolve($`ip netns list`).then(({ stdout }) => {
      return stdout
        .split("\n")
        .map((line) => line.trim().split(/\s+/)[0])
        .filter((name) => name.startsWith("aw-") && name.length > 0)
        .map((name) => {
          const hex = name.replace("aw-", "");
          const slot = parseInt(hex, 16);

          if (!Number.isNaN(slot) && slot >= VMNet.NS_MIN_SLOT && slot <= VMNet.NS_MAX_SLOT) {
            return this.#namespace(slot);
          }

          return null;
        })
        .filter(Boolean) as VMNet.Namespace[];
    });
  }

  async release(ns: VMNet.Namespace) {
    const signal = new AbortController().signal;

    await this.#lock.acquire("__global__", async () => {
      return this.#release(ns, signal);
    });
  }

  async random() {
    const signal = new AbortController().signal;

    let attempt = 0;

    return this.#lock.acquire("__global__", async () => {
      const existing = await this.#getExistingNamespaces(signal);

      for (let s = VMNet.NS_MIN_SLOT; s <= VMNet.NS_MAX_SLOT; s++) {
        const current = this.#namespace(s);

        if (!existing.find((ns) => ns.name === current.name)) {
          try {
            return await this.#install(current, signal).then(() => current);
          } catch (error) {
            if (attempt <= 10) {
              attempt += 1;
              continue;
            }

            throw error;
          }
        }
      }

      throw new Error("No available network namespace left.");
    });
  }

  protected override async initialize(signal: AbortSignal) {
    await this.#lock.acquire("__global__", async () => {
      this.#logger.info("Initializing global host network fabric...");

      let cleanCount = 0;

      for (const ns of await this.#getExistingNamespaces(signal)) {
        await this.#release(ns, signal).then(() => {
          cleanCount++;
        });
      }

      if (cleanCount > 0) {
        this.#logger.info(`Purged ${cleanCount} legacy/stale network namespaces during bootstrap initialization.`);
      }

      const $ = this.#shell.session({ signal, logger: this.#logger });

      const iface = await Promise.resolve($`ip route show default`).then(({ stdout }) => {
        const match = stdout.match(/dev\s+(\S+)/);

        if (match?.[1]) {
          return match[1];
        }

        return null;
      });

      if (iface === null) {
        throw new Error("Unable to find default WAN interface. Please check network configuration.");
      }

      const exists = await Promise.resolve($`nft list table ip ${VMNet.NFT_TABLE_NAT}`).then(
        () => true,
        () => false,
      );

      if (exists) {
        return this.#logger.info(`Root nat table ${VMNet.NFT_TABLE_NAT} already exists, skipping init.`);
      }

      this.#logger.info(`Compiling root host routing masquerade tables bound to WAN interface: [${iface}]...`);

      await $`sysctl -w net.ipv4.ip_forward=1`; // 启用宿主机的内核参数 IP 转发功能
      await $`nft delete table ip ${VMNet.NFT_TABLE_NAT} 2>/dev/null || true`; // 强制删除已存在的 NAT 表及其所有关联规则，确保网络策略从零开始构建
      await $`nft add table ip ${VMNet.NFT_TABLE_NAT}`; // 重新创建 IPv4 类型的 nftables NAT 表，用于集中处理虚拟网段的地址转换
      await $`nft add chain ip ${VMNet.NFT_TABLE_NAT} postrouting { type nat hook postrouting priority 100 \\; }`; // 在 NAT 表中建立 postrouting 链，作为数据包发出前最后一步的挂载点
      await $`nft add rule ip ${VMNet.NFT_TABLE_NAT} postrouting ip saddr ${VMNet.NS_VETH_PREFIX}.0.0/16 oifname ${iface} masquerade`; // 配置网段级 MASQUERADE 规则：凡是源地址属于虚拟子网的包，统一伪装为物理网卡 IP 外发

      this.#logger.info("Global host network infrastructure ready. Sandboxing fabric initialized.");
    });
  }

  protected override async dispose() {
    const signal = new AbortController().signal;

    await this.#lock.acquire("__global__", async () => {
      this.#logger.info("Disposing global host network fabric...");

      let cleanCount = 0;

      for (const ns of await this.#getExistingNamespaces(signal)) {
        await this.#release(ns, signal).then(() => {
          cleanCount++;
        });
      }

      if (cleanCount > 0) {
        this.#logger.info(`Purged ${cleanCount} legacy/stale network namespaces during disposal.`);
      }
    });
  }
}

export namespace VMNet {
  export const NS_VETH_OCTET_FIRST = 172;
  export const NS_VETH_OCTET_SECOND = 28;

  export const NS_VETH_SUBNET_MASK = "255.255.255.252";
  export const NS_VETH_SUBNET_MASK_SHORT = "/30";

  export const NS_VETH_PREFIX = `${NS_VETH_OCTET_FIRST}.${NS_VETH_OCTET_SECOND}`;

  export const NS_MIN_SLOT = 0;
  export const NS_MAX_SLOT = 16383;

  export const TAP = "aw-tap";
  export const TAP_NS_IP = "10.123.0.1";
  export const TAP_VM_IP = "10.123.0.2";

  export const DNS_RESOLVERS = ["8.8.8.8", "8.8.4.4", "114.114.114.114"];

  export const NFT_TABLE_FILTER = "aw-filter";
  export const NFT_TABLE_NAT = "aw-nat";

  /**
   * 私有网段
   */
  export const PRIVATE_CIDRS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10", "127.0.0.0/8"];

  /**
   * 需要开放给虚机的宿主机 TCP 服务端口
   */
  export const EXPOSED_HOST_TCP_PORTS = [26088 /** NFS */];

  /**
   * 需要开放给虚机的宿主机 UDP 服务端口
   */
  export const EXPOSED_HOST_UDP_PORTS = [];

  /**
   * 表示一个命名空间
   */
  export type Namespace = {
    readonly slot: number;
    readonly name: string;
    readonly veth: Readonly<Record<"host" | "guest", Readonly<Record<"ip" | "name", string>>>>;
  };
}
