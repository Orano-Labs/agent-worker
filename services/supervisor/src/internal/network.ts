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
      const commands = [
        `sudo ip netns add ${slot.name}`,
        `sudo ip link add ${slot.veth.host.name} type veth peer name ${slot.veth.guest.name}`,
        `sudo ip link set ${slot.veth.guest.name} netns ${slot.name}`,
        `sudo ip addr add ${slot.veth.host.ip}/30 dev ${slot.veth.host.name}`,
        `sudo ip link set ${slot.veth.host.name} up`,
        `sudo ip link set ${slot.veth.host.name} mtu 1500`,

        `sudo ip netns exec ${slot.name} ip link set ${slot.veth.guest.name} mtu 1500`,
        `sudo ip netns exec ${slot.name} ip addr add ${slot.veth.guest.ip}/30 dev ${slot.veth.guest.name}`,
        `sudo ip netns exec ${slot.name} ip link set ${slot.veth.guest.name} up`,
        `sudo ip netns exec ${slot.name} ip link set lo up`,

        `sudo ip netns exec ${slot.name} ip tuntap add ${Network.TAP} mode tap`,
        `sudo ip netns exec ${slot.name} ip addr add ${Network.TAP_NS_IP}/24 dev ${Network.TAP}`,
        `sudo ip netns exec ${slot.name} ip link set ${Network.TAP} up`,

        `sudo ip netns exec ${slot.name} ip route add default via ${slot.veth.host.ip}`,
        `sudo ip netns exec ${slot.name} sysctl -w net.ipv4.ip_forward=1`,
      ];

      const nft = `sudo ip netns exec ${slot.name} nft`;
      // 💡 修复：精简 DNS 数组拼接，去除花括号内部的空格防止 Shell 展开错误
      const dnsSet = `{${Network.DNS_RESOLVERS.join(",")}}`;

      commands.push(
        ...[
          `${nft} delete table inet ${Network.NFT_TABLE_FILTER} 2>/dev/null || true`,
          `${nft} add table inet ${Network.NFT_TABLE_FILTER}`,
          `${nft} add chain inet ${Network.NFT_TABLE_FILTER} forward '{ type filter hook forward priority 0 ; policy accept ; }'`,
          `${nft} add rule inet ${Network.NFT_TABLE_FILTER} forward ct state established,related accept`,

          // DNS 白名单及阻断规则
          `${nft} add rule inet ${Network.NFT_TABLE_FILTER} forward iifname ${Network.TAP} udp dport 53 ip daddr ${dnsSet} accept`,
          `${nft} add rule inet ${Network.NFT_TABLE_FILTER} forward iifname ${Network.TAP} tcp dport 53 ip daddr ${dnsSet} accept`,
          `${nft} add rule inet ${Network.NFT_TABLE_FILTER} forward iifname ${Network.TAP} udp dport 53 drop`,
          `${nft} add rule inet ${Network.NFT_TABLE_FILTER} forward iifname ${Network.TAP} tcp dport 53 drop`,

          // 隔离与出入网控制
          `${nft} add rule inet ${Network.NFT_TABLE_FILTER} forward iifname ${Network.TAP} oifname ${Network.TAP} drop`,
          `${nft} add rule inet ${Network.NFT_TABLE_FILTER} forward iifname ${Network.TAP} oifname ${slot.veth.guest.name} ip protocol icmp accept`,
          `${nft} add rule inet ${Network.NFT_TABLE_FILTER} forward iifname ${Network.TAP} oifname ${slot.veth.guest.name} tcp dport { 22, 80, 443, 2049 } accept`,
          `${nft} add rule inet ${Network.NFT_TABLE_FILTER} forward iifname ${slot.veth.guest.name} oifname ${Network.TAP} accept`,
        ],
      );

      commands.push(
        ...[
          `${nft} add table ip ${Network.NFT_TABLE_NAT}`,
          `${nft} add chain ip ${Network.NFT_TABLE_NAT} prerouting '{ type nat hook prerouting priority -100 ; }'`,
          `${nft} add chain ip ${Network.NFT_TABLE_NAT} postrouting '{ type nat hook postrouting priority 100 ; }'`,
          `${nft} add rule ip ${Network.NFT_TABLE_NAT} postrouting oifname ${slot.veth.guest.name} masquerade`,
          `${nft} add rule ip ${Network.NFT_TABLE_NAT} prerouting iifname ${Network.TAP} ip daddr ${Network.TAP_NS_IP} tcp dport 2049 dnat to ${slot.veth.host.ip}`,
          `${nft} add rule ip ${Network.NFT_TABLE_NAT} prerouting iifname ${slot.veth.guest.name} ip daddr ${slot.veth.guest.ip} dnat to ${Network.TAP_VM_IP}`,
        ],
      );

      for (const cmd of commands) {
        await this.#exec(cmd);
      }
    } catch (e) {
      await Promise.all([
        this.#exec(`sudo ip link del ${slot.veth.host.name}`).catch(() => {}),
        this.#exec(`sudo ip netns del ${slot.name}`).catch(() => {}),
        this.#kv.db.remove(`network-${slot.name}-locked`).catch(() => {}),
      ]);
      throw e;
    }
  }

  async release(slot: Network.Slot) {
    const commands = [`sudo ip link del ${slot.veth.host.name}`, `sudo ip netns del ${slot.name}`];

    for (const cmd of commands) {
      await this.#exec(cmd).catch(() => {});
    }

    await this.#kv.db.remove(`network-${slot.name}-locked`).catch(() => {});
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
    // init 时应该清理所有已创建的网络命名空间
    for (let s = Network.NS_MIN_SLOT; s <= Network.NS_MAX_SLOT; s++) {
      const slot = this.slot(s);
      const key = `network-${this.slot(s).name}-locked`;
      const exists = this.#kv.db.get(key) !== undefined;

      if (exists) {
        await this.release(slot);
      }
    }

    this.#logger.info("Network slots lock storage initialized.");

    const iface = await this.#findDefaultInterface();
    const exists = await this.#exec(`sudo nft list table ip ${Network.NFT_TABLE_NAT}`)
      .then(() => true)
      .catch(() => false);

    if (exists) {
      return this.#logger.info(`Nat table ${Network.NFT_TABLE_NAT} already exists, skipping init.`);
    }

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

  export const DNS_RESOLVERS = ["8.8.8.8", "8.8.4.4"];

  export const NFT_TABLE_FILTER = "aw-filter";
  export const NFT_TABLE_NAT = "aw-nat";

  export type Slot = {
    id: number;
    name: string;
    veth: Record<"host" | "guest", { name: string; ip: string }>;
  };
}
