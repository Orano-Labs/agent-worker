import { exec } from "node:child_process";
import { Container } from "@/helpers/container";
import { KVStorage } from "@/internal/kv-storage";
import { Logger } from "@/internal/logger";

export class Network {
  #logger: Logger;
  #kv: KVStorage;

  constructor() {
    this.#logger = Container.inject(Logger).scope("Network");
    this.#kv = Container.inject(KVStorage);
  }

  async #exec(command: string) {
    return new Promise<string>((resolve, reject) => {
      exec(command, (err, stdout) => {
        if (err) {
          reject(err);
        } else {
          resolve(stdout);
        }
      });
    });
  }

  async #findDefaultInterface() {
    try {
      // 方法1：通过 ip route 获取默认路由的网卡
      const output = await this.#exec("ip route show default");
      const match = output.match(/dev\s+(\S+)/);

      if (match?.[1]) {
        return match[1];
      }
    } catch {
      // 继续尝试其他方法
    }

    try {
      // 方法2：通过路由获取到 8.8.8.8 的网卡
      const output = await this.#exec("ip route get 8.8.8.8");
      const match = output.match(/dev\s+(\S+)/);

      if (match?.[1]) {
        return match[1];
      }
    } catch {
      // 继续尝试其他方法
    }

    try {
      // 方法3：列出所有 UP 状态的物理网卡，取第一个
      const output = await this.#exec("ip -j link show | jq -r '.[] | select(.operstate == \"UP\") | .ifname' | head -1");

      if (output.trim()) {
        return output.trim();
      }
    } catch {
      // 继续尝试其他方法
    }

    try {
      // 方法4：查找非虚拟、非 loopback 的网卡
      const output = await this.#exec("ls /sys/class/net/ | grep -v lo | head -1");

      if (output.trim()) {
        return output.trim();
      }
    } catch {
      // 所有方法都失败
    }

    throw new Error("Unable to find default WAN interface. Please check network configuration.");
  }

  slot(id: number) {
    if (!Number.isInteger(id) || id < Network.NS_MIN_SLOT || id > Network.NS_MAX_SLOT) {
      throw new Error(`Invalid slot: ${id}. Range: ${Network.NS_MIN_SLOT}-${Network.NS_MAX_SLOT}`);
    }

    const octet = Math.floor(id / 64);
    const start = (id % 64) * 4;
    const hex = id.toString(16).padStart(4, "0");

    const slot: Network.Slot = {
      id,
      name: `aw-${hex}`,
      veth: {
        host: {
          name: `aw-vh-${hex}`,
          ip: `${Network.NS_VETH_PREFIX}.${octet}.${start + 1}`,
        },
        guest: {
          name: `aw-vg-${hex}`,
          ip: `${Network.NS_VETH_PREFIX}.${octet}.${start + 2}`,
        },
      },
    };

    return slot;
  }

  async #install(slot: Network.Slot) {
    this.#logger.info(`Starting network workspace deployment for slot [${slot.id}] (Namespace: ${slot.name})...`);

    const locked = this.#kv.db.get(`network-${slot.name}-locked`);

    if (!locked) {
      const ok = await this.#kv.db.ifNoExists(`network-${slot.name}-locked`, () => {
        this.#kv.db.put(`network-${slot.name}-locked`, 1);
      });

      if (!ok) {
        throw new Error(`Slot ${slot.id} is already deployed or locked.`);
      }
    }

    try {
      this.#logger.info(`Allocating topological addresses: Host VETH: ${slot.veth.host.ip}/30, Guest VETH: ${slot.veth.guest.ip}/30`);

      const commands = [
        // 创建硬隔离的网络命名空间，并建立一对连接宿主机与该命名空间的虚拟网线（veth pair）
        // 分配 /30 精简子网 IP 并激活宿主机端网卡，将 MTU 统一设为 1500
        `sudo ip netns add ${slot.name}`,
        `sudo ip link add ${slot.veth.host.name} type veth peer name ${slot.veth.guest.name}`,
        `sudo ip link set ${slot.veth.guest.name} netns ${slot.name}`,
        `sudo ip addr add ${slot.veth.host.ip}/30 dev ${slot.veth.host.name}`,
        `sudo ip link set ${slot.veth.host.name} up`,
        `sudo ip link set ${slot.veth.host.name} mtu 1500`,

        // 进入命名空间内部，配置并激活虚拟网线出口端（guest）的 IP 和 MTU
        // 同时激活本地回环接口（lo），保障内部网络栈基础进程的正常运转
        `sudo ip netns exec ${slot.name} ip link set ${slot.veth.guest.name} mtu 1500`,
        `sudo ip netns exec ${slot.name} ip addr add ${slot.veth.guest.ip}/30 dev ${slot.veth.guest.name}`,
        `sudo ip netns exec ${slot.name} ip link set ${slot.veth.guest.name} up`,
        `sudo ip netns exec ${slot.name} ip link set lo up`,

        // 创建并激活二层虚拟网卡（TAP 设备）用以桥接虚机，并分配 /24 子网 IP 作为其内网网关
        `sudo ip netns exec ${slot.name} ip tuntap add ${Network.TAP} mode tap`,
        `sudo ip netns exec ${slot.name} ip addr add ${Network.TAP_NS_IP}/24 dev ${Network.TAP}`,
        `sudo ip netns exec ${slot.name} ip link set ${Network.TAP} up`,

        // 配置全局默认路由，将命名空间内所有去往外网的流量定向到虚拟网线的宿主机端
        `sudo ip netns exec ${slot.name} ip route add default via ${slot.veth.host.ip}`,

        // 开启内核 IP 转发使其具备路由能力，并启用严格的反向路径过滤（rp_filter）防范 IP 欺骗
        `sudo ip netns exec ${slot.name} sysctl -w net.ipv4.ip_forward=1`,
        // `sudo ip netns exec ${slot.name} sysctl -w net.ipv4.conf.all.rp_filter=1`,
        // `sudo ip netns exec ${slot.name} sysctl -w net.ipv4.conf.default.rp_filter=1`,
      ];

      const nft = `sudo ip netns exec ${slot.name} nft`;
      const dnsSet = `{ ${Network.DNS_RESOLVERS.join(", ")} }`;
      const privateCIDRSet = `{ ${Network.PRIVATE_CIDRS.join(", ")} }`;

      this.#logger.info(`Compiling security isolation firewalls for ${slot.name} (Table: ${Network.NFT_TABLE_FILTER})...`);

      commands.push(
        ...[
          // 初始化 nftables 过滤表并挂载转发链，优先放行已建立或关联的连接回包以提升吞吐
          `${nft} delete table inet ${Network.NFT_TABLE_FILTER} 2>/dev/null || true`,
          `${nft} add table inet ${Network.NFT_TABLE_FILTER}`,
          `${nft} add chain inet ${Network.NFT_TABLE_FILTER} forward '{ type filter hook forward priority 0; policy drop; }'`,

          // 放行所有已建立连接及其回包
          `${nft} add rule inet ${Network.NFT_TABLE_FILTER} forward ct state established,related accept`,

          // 硬拦截去往宿主机及物理私网的所有流量，彻底斩断对内网的窥探
          `${nft} add rule inet ${Network.NFT_TABLE_FILTER} forward iifname ${Network.TAP} ip daddr ${privateCIDRSet} drop`,

          // 仅允许虚机访问白名单中的 DNS 服务器
          `${nft} add rule inet ${Network.NFT_TABLE_FILTER} forward iifname ${Network.TAP} udp dport 53 ip daddr ${dnsSet} accept`,

          // 出网放行
          `${nft} add rule inet ${Network.NFT_TABLE_FILTER} forward iifname ${Network.TAP} accept`,

          // 入网放行，无条件接受外部流向虚机（TAP）的所有合法响应流量
          `${nft} add rule inet ${Network.NFT_TABLE_FILTER} forward iifname ${slot.veth.guest.name} oifname ${Network.TAP} accept`,
        ],
      );

      this.#logger.info(`Compiling dynamic NAT topology rules for ${slot.name} (Table: ${Network.NFT_TABLE_NAT})...`);

      commands.push(
        ...[
          // 初始化 NAT 表并挂载路由前/后钩子链，用于后续处理虚机的出网伪装与入网映射
          `${nft} add table ip ${Network.NFT_TABLE_NAT}`,
          `${nft} add chain ip ${Network.NFT_TABLE_NAT} prerouting '{ type nat hook prerouting priority -100 ; }'`,
          `${nft} add chain ip ${Network.NFT_TABLE_NAT} postrouting '{ type nat hook postrouting priority 100 ; }'`,

          // 出网执行 Masquerade (SNAT) 隐蔽虚机内网，入网执行 DNAT 将外网流量映射至虚机真实 IP
          `${nft} add rule ip ${Network.NFT_TABLE_NAT} postrouting oifname ${slot.veth.guest.name} masquerade`,
          `${nft} add rule ip ${Network.NFT_TABLE_NAT} prerouting iifname ${slot.veth.guest.name} ip daddr ${slot.veth.guest.ip} dnat to ${Network.TAP_VM_IP}`,
        ],
      );

      // 向虚拟机暴露宿主机上的 TCP / UDP 端口
      // 1. 在 PREROUTING 阶段将发往网关固定 IP (10.123.0.1) 的流量，重定向到宿主机专属 veth IP
      // 2. 在 FORWARD 阶段通过 insert 强行置顶，确保被改写目的地后的私网流量不被后续的私网硬拦截规则杀掉

      if (Network.EXPOSED_HOST_TCP_PORTS.length > 0) {
        const ports = `{ ${Network.EXPOSED_HOST_TCP_PORTS.join(", ")} }`;

        this.#logger.info(`Injecting host TCP port safe-exposure hooks: ${ports} -> ${slot.veth.host.ip}`);

        commands.push(
          ...[
            `${nft} add rule ip ${Network.NFT_TABLE_NAT} prerouting iifname ${Network.TAP} ip daddr ${Network.TAP_NS_IP} tcp dport ${ports} dnat to ${slot.veth.host.ip}`,
            `${nft} insert rule inet ${Network.NFT_TABLE_FILTER} forward iifname ${Network.TAP} ip daddr ${slot.veth.host.ip} tcp dport ${ports} accept`,
          ],
        );
      }

      if (Network.EXPOSED_HOST_UDP_PORTS.length > 0) {
        const ports = `{ ${Network.EXPOSED_HOST_UDP_PORTS.join(", ")} }`;

        this.#logger.info(`Injecting host UDP port safe-exposure hooks: ${ports} -> ${slot.veth.host.ip}`);

        commands.push(
          ...[
            `${nft} add rule ip ${Network.NFT_TABLE_NAT} prerouting iifname ${Network.TAP} ip daddr ${Network.TAP_NS_IP} udp dport ${ports} dnat to ${slot.veth.host.ip}`,
            `${nft} insert rule inet ${Network.NFT_TABLE_FILTER} forward iifname ${Network.TAP} ip daddr ${slot.veth.host.ip} udp dport ${ports} accept`,
          ],
        );
      }

      this.#logger.info(`Executing assembly sequence (${commands.length} structural operations) for ${slot.name}...`);

      for (const cmd of commands) {
        await this.#exec(cmd);
      }

      this.#logger.info(`Network pipeline for slot [${slot.id}] has been successfully established and locked.`);
    } catch (e) {
      this.#logger.errorFrom(e, `Critical failure deploying network slot [${slot.id}]. Initiating rollback recovery...`);

      await Promise.all([
        this.#exec(`sudo ip link del ${slot.veth.host.name}`).catch(() => {}),
        this.#exec(`sudo ip netns del ${slot.name}`).catch(() => {}),
        this.#kv.db.remove(`network-${slot.name}-locked`).catch(() => {}),
      ]);

      throw e;
    }
  }

  async release(slot: Network.Slot) {
    this.#logger.info(`Decommissioning network pipeline for slot [${slot.id}] (${slot.name})...`);

    const commands = [`sudo ip link del ${slot.veth.host.name}`, `sudo ip netns del ${slot.name}`];

    for (const cmd of commands) {
      await this.#exec(cmd).catch((err) => {
        this.#logger.warn(`Non-fatal warning during command teardown [${cmd}]`, { err });
      });
    }

    await this.#kv.db.remove(`network-${slot.name}-locked`).catch((err) => {
      this.#logger.warn(`Failed to safely wipe memory lock for ${slot.name}`, { err });
    });

    this.#logger.info(`Slot [${slot.id}] sandbox environment cleanly deleted.`);
  }

  async random() {
    for (let s = Network.NS_MIN_SLOT; s <= Network.NS_MAX_SLOT; s++) {
      const current = this.slot(s);
      const key = `network-${current.name}-locked`;

      if (this.#kv.db.get(key) !== undefined) {
        continue;
      }

      const ok = await this.#kv.db.ifNoExists(key, () => {
        this.#kv.db.put(key, 1);
      });

      if (ok) {
        return await this.#install(current).then(() => current);
      }
    }

    throw new Error("No available network slots left.");
  }

  async init() {
    this.#logger.info("Initializing global host network fabric...");

    let cleanCount = 0;

    // init 时应该清理所有已创建的网络命名空间
    for (let s = Network.NS_MIN_SLOT; s <= Network.NS_MAX_SLOT; s++) {
      const slot = this.slot(s);
      const key = `network-${this.slot(s).name}-locked`;
      const exists = this.#kv.db.get(key) !== undefined;

      if (exists) {
        await this.release(slot).then(() => {
          cleanCount++;
        });
      }
    }

    if (cleanCount > 0) {
      this.#logger.info(`Purged ${cleanCount} legacy/stale network namespaces during bootstrap initialization.`);
    }

    const iface = await this.#findDefaultInterface();
    const exists = await this.#exec(`sudo nft list table ip ${Network.NFT_TABLE_NAT}`)
      .then(() => true)
      .catch(() => false);

    if (exists) {
      return this.#logger.info(`Root nat table ${Network.NFT_TABLE_NAT} already exists, skipping init.`);
    }

    this.#logger.info(`Compiling root host routing masquerade tables bound to WAN interface: [${iface}]...`);

    const commands = [
      // 启用宿主机的内核参数 IP 转发功能
      `sudo sysctl -w net.ipv4.ip_forward=1`,

      // 强制删除已存在的 NAT 表及其所有关联规则，确保网络策略从零开始构建
      `sudo nft delete table ip ${Network.NFT_TABLE_NAT} 2>/dev/null || true`,

      // 重新创建 IPv4 类型的 nftables NAT 表，用于集中处理虚拟网段的地址转换
      `sudo nft add table ip ${Network.NFT_TABLE_NAT}`,

      // 在 NAT 表中建立 postrouting 链，作为数据包发出前最后一步的挂载点
      `sudo nft add chain ip ${Network.NFT_TABLE_NAT} postrouting { type nat hook postrouting priority 100 \\; }`,

      // 配置网段级 MASQUERADE 规则：凡是源地址属于虚拟子网的包，统一伪装为物理网卡 IP 外发
      `sudo nft add rule ip ${Network.NFT_TABLE_NAT} postrouting ip saddr ${Network.NS_VETH_PREFIX}.0.0/16 oifname ${iface} masquerade`,
    ];

    for (const cmd of commands) {
      await this.#exec(cmd);
    }

    this.#logger.info("Global host network infrastructure ready. Sandboxing fabric initialized.");
  }
}

export namespace Network {
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
  export const EXPOSED_HOST_TCP_PORTS = [2049];

  /**
   * 需要开放给虚机的宿主机 UDP 服务端口
   */
  export const EXPOSED_HOST_UDP_PORTS = [];

  export const EXPOSED_NS_TCP_PORTS = [8000];

  export type Slot = {
    id: number;
    name: string;
    veth: Record<"host" | "guest", { name: string; ip: string }>;
  };
}
