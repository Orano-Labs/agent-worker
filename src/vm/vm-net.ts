import { exec } from "node:child_process";

export class VMNet {
  #name: string;
  #veth: Record<"host" | "guest", { name: string; ip: string }>;
  #slot: number;
  #bandwidth?: number;

  constructor(slot: number, bandwidth?: number) {
    if (!Number.isInteger(slot) || slot < VMNet.NS_MIN_SLOT || slot > VMNet.NS_MAX_SLOT) {
      throw new Error(`Invalid slot: ${slot}. Range: ${VMNet.NS_MIN_SLOT}-${VMNet.NS_MAX_SLOT}`);
    }

    const octet = Math.floor(slot / 64);
    const start = (slot % 64) * 4;
    const hex = slot.toString(16).padStart(4, "0");

    this.#slot = slot;
    this.#bandwidth = bandwidth;
    this.#name = `cc-w-${hex}`;
    this.#veth = Object.freeze({
      host: { name: `cc-w-vh-${hex}`, ip: `${VMNet.NS_VETH_PREFIX}.${octet}.${start + 1}` },
      guest: { name: `cc-w-vg-${hex}`, ip: `${VMNet.NS_VETH_PREFIX}.${octet}.${start + 2}` },
    });
  }

  get name() {
    return this.#name;
  }

  get slot() {
    return this.#slot;
  }

  get veth() {
    return this.#veth;
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

      if (match && match[1]) {
        return match[1];
      }
    } catch {
      // 继续尝试其他方法
    }

    try {
      // 方法2：通过路由获取到 8.8.8.8 的网卡
      const output = await this.#exec("ip route get 8.8.8.8");
      const match = output.match(/dev\s+(\S+)/);
      if (match && match[1]) {
        return match[1];
      }
    } catch {
      // 继续尝试其他方法
    }

    try {
      // 方法3：列出所有 UP 状态的物理网卡，取第一个
      const output = await this.#exec(
        "ip -j link show | jq -r '.[] | select(.operstate == \"UP\") | .ifname' | head -1",
      );
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

  async #setup() {
    const iface = await this.#findDefaultInterface();
    const exists = await this.#exec(`sudo nft list table ip ${VMNet.NFT_TABLE_NAT}`)
      .then(() => true)
      .catch(() => false);

    if (exists) {
      return;
    }

    const commands = [
      // 启用宿主机的内核参数 IP 转发功能
      `sudo sysctl -w net.ipv4.ip_forward=1`,

      // 强制删除已存在的 NAT 表及其所有关联规则，确保网络策略从零开始构建
      `sudo nft delete table ip ${VMNet.NFT_TABLE_NAT} 2>/dev/null || true`,

      // 重新创建 IPv4 类型的 nftables NAT 表，用于集中处理虚拟网段的地址转换
      `sudo nft add table ip ${VMNet.NFT_TABLE_NAT}`,

      // 在 NAT 表中建立 postrouting 链，作为数据包发出前最后一步的挂载点
      `sudo nft add chain ip ${VMNet.NFT_TABLE_NAT} postrouting { type nat hook postrouting priority 100 \\; }`,

      // 配置网段级 MASQUERADE 规则：凡是源地址属于虚拟子网的包，统一伪装为物理网卡 IP 外发
      `sudo nft add rule ip ${VMNet.NFT_TABLE_NAT} postrouting ip saddr ${VMNet.NS_VETH_PREFIX}.0.0/16 oifname ${iface} masquerade`,
    ];

    // 顺序执行初始化指令，将宿主机网络切换至全局网段转发模式
    for (const cmd of commands) {
      await this.#exec(cmd);
    }
  }

  async install() {
    await this.#setup();

    try {
      const commands = [
        // 创建指定的网络命名空间
        `sudo ip netns add ${this.name}`,

        // 创建一对虚拟以太网设备（veth pair），一端在宿主机，一端将移至命名空间
        `sudo ip link add ${this.veth.host.name} type veth peer name ${this.veth.guest.name}`,

        // 将 veth 对的 guest 端移动到指定的网络命名空间
        `sudo ip link set ${this.veth.guest.name} netns ${this.name}`,

        // 为宿主机端的 veth 设备分配 IP 地址（/30 子网掩码，点对点链路）
        `sudo ip addr add ${this.veth.host.ip}/30 dev ${this.veth.host.name}`,

        // 启用宿主机端的 veth 设备（使其处于 UP 状态）
        `sudo ip link set ${this.veth.host.name} up`,

        // 设置宿主机端 veth 设备的最大传输单元（MTU），确保数据包分片一致
        `sudo ip link set ${this.veth.host.name} mtu 1500`,

        // 在命名空间内设置 guest 端 veth 设备的 MTU 值
        `sudo ip netns exec ${this.name} ip link set ${this.veth.guest.name} mtu 1500`,

        // 在命名空间内为 guest 端 veth 设备分配 IP 地址
        `sudo ip netns exec ${this.name} ip addr add ${this.veth.guest.ip}/30 dev ${this.veth.guest.name}`,

        // 启用命名空间内的 guest 端 veth 设备
        `sudo ip netns exec ${this.name} ip link set ${this.veth.guest.name} up`,

        // 启用命名空间内的本地回环接口（lo），确保内部进程通信正常
        `sudo ip netns exec ${this.name} ip link set lo up`,

        // 在命名空间内创建 TAP 设备（提供给 Firecracker 虚拟机使用）
        `sudo ip netns exec ${this.name} ip tuntap add ${VMNet.TAP} mode tap`,

        // 为命名空间内的 TAP 设备分配 IP 地址
        `sudo ip netns exec ${this.name} ip addr add ${VMNet.TAP_NS_IP}/24 dev ${VMNet.TAP}`,

        // 启用命名空间内刚创建的 TAP 设备
        `sudo ip netns exec ${this.name} ip link set ${VMNet.TAP} up`,

        // 在命名空间内添加默认路由，所有出网流量通过宿主机端 veth 网关转发
        `sudo ip netns exec ${this.name} ip route add default via ${this.veth.host.ip}`,

        // 在命名空间内启用内核参数 IP 转发功能，允许 TAP 和 veth 间通信
        `sudo ip netns exec ${this.name} sysctl -w net.ipv4.ip_forward=1`,
      ];

      const nft = `sudo ip netns exec ${this.name} nft`;

      // Namespace 内部的 FILTER 配置
      commands.push(
        ...[
          // 清理指定的网络命名空间内可能已存在的过滤表，避免规则冲突并忽略错误（如果表不存在）
          `${nft} delete table inet ${VMNet.NFT_TABLE_FILTER} 2>/dev/null || true`,

          // 在命名空间内创建一个 inet 类型的过滤表，用于同时管理 IPv4 和 IPv6 的安全策略
          `${nft} add table inet ${VMNet.NFT_TABLE_FILTER}`,

          // 在过滤表中创建 forward 转发链，绑定到内核转发钩子并初始化默认通行策略
          `${nft} add chain inet ${VMNet.NFT_TABLE_FILTER} forward { type filter hook forward priority 0 \\; policy accept \\; }`,

          // 允许状态为已建立或相关联的回程流量通过，确保双向通信的响应包不被拦截
          `${nft} add rule inet ${VMNet.NFT_TABLE_FILTER} forward ct state established,related accept`,

          // 允许从 TAP 设备发出的 UDP 53 端口流量，但仅限于访问预设的白名单 DNS 服务器
          `${nft} add rule inet ${VMNet.NFT_TABLE_FILTER} forward iifname ${VMNet.TAP} udp dport 53 ip daddr { ${VMNet.DNS_RESOLVERS.join(", ")} } accept`,

          // 允许从 TAP 设备发出的 TCP 53 端口流量，用于处理大包或特定协议的 DNS 解析请求
          `${nft} add rule inet ${VMNet.NFT_TABLE_FILTER} forward iifname ${VMNet.TAP} tcp dport 53 ip daddr { ${VMNet.DNS_RESOLVERS.join(", ")} } accept`,

          // 显式丢弃来自 TAP 设备且不在白名单内的所有 UDP 53 端口 DNS 请求
          `${nft} add rule inet ${VMNet.NFT_TABLE_FILTER} forward iifname ${VMNet.TAP} udp dport 53 drop`,

          // 显式丢弃来自 TAP 设备且不在白名单内的所有 TCP 53 端口 DNS 请求
          `${nft} add rule inet ${VMNet.NFT_TABLE_FILTER} forward iifname ${VMNet.TAP} tcp dport 53 drop`,

          // 限制流量路径，禁止同一个命名空间内不同 TAP 设备（即虚拟机）之间的直接二层/三层通信
          `${nft} add rule inet ${VMNet.NFT_TABLE_FILTER} forward iifname ${VMNet.TAP} oifname ${VMNet.TAP} drop`,

          // 允许虚拟机通过 veth 接口向外部发送 ICMP 协议数据包，支持常用的 ping 连通性测试
          `${nft} add rule inet ${VMNet.NFT_TABLE_FILTER} forward iifname ${VMNet.TAP} oifname ${this.veth.guest.name} ip protocol icmp accept`,

          // 允许虚拟机访问外部网络中常用的标准服务端口：SSH (22)、HTTP (80) 以及 HTTPS (443)
          `${nft} add rule inet ${VMNet.NFT_TABLE_FILTER} forward iifname ${VMNet.TAP} oifname ${this.veth.guest.name} tcp dport { 22, 80, 443 } accept`,

          // 允许从宿主机方向（经由 veth 接口）进入并流向虚拟机 TAP 设备的所有网络流量
          `${nft} add rule inet ${VMNet.NFT_TABLE_FILTER} forward iifname ${this.veth.guest.name} oifname ${VMNet.TAP} accept`,
        ],
      );

      // Namespace 内部的 NAT 配置
      commands.push(
        ...[
          // 在命名空间内创建一个名为 ${VMNet.NFT_TABLE_NAT} 的 IPv4 表，用于管理 NAT 地址转换规则
          `${nft} add table ip ${VMNet.NFT_TABLE_NAT}`,

          // 在 NAT 表中添加 prerouting 链，关联入站钩子并设置优先级，用于处理进入命名空间的数据包
          `${nft} add chain ip ${VMNet.NFT_TABLE_NAT} prerouting { type nat hook prerouting priority -100 \\; }`,

          // 在 NAT 表中添加 postrouting 链，关联出站钩子并设置优先级，用于处理离开命名空间的数据包
          `${nft} add chain ip ${VMNet.NFT_TABLE_NAT} postrouting { type nat hook postrouting priority 100 \\; }`,

          // 为出站流量设置伪装规则，将从 veth.guest 发出的包源 IP 动态转换为该网卡的 IP 地址
          `${nft} add rule ip ${VMNet.NFT_TABLE_NAT} postrouting oifname ${this.veth.guest.name} masquerade`,

          // 为入站流量设置目的 NAT 规则，将发往 veth.guest 接口 IP 的包重定向给 VM 的 TAP IP
          `${nft} add rule ip ${VMNet.NFT_TABLE_NAT} prerouting iifname ${this.veth.guest.name} ip daddr ${this.veth.guest.ip} dnat to ${VMNet.TAP_VM_IP}`,
        ],
      );

      if (this.#bandwidth && this.#bandwidth > 0) {
        // 限制最大带宽为 10000 Mbps (10 Gbps)，避免 burst 过大
        const effectiveRate = Math.min(this.#bandwidth, 10000);

        // burst 通常设置为 10-100ms 的流量，而不是 rate/8
        // 例如：100ms 的流量 = rate * 0.1 / 8 (转换为 KB)
        const burstKb = Math.max(32, Math.floor((effectiveRate * 1000 * 0.1) / 8));

        // 进一步限制 burst 最大值 1GB
        const finalBurstKb = Math.min(burstKb, 1024 * 1024);

        commands.push(
          `sudo ip netns exec ${this.name} tc qdisc add dev ${VMNet.TAP} root tbf rate ${effectiveRate}mbit burst ${finalBurstKb}kb latency 400ms`,
        );
      }

      for (const cmd of commands) {
        await this.#exec(cmd);
      }
    } catch (e) {
      await Promise.all([
        this.#exec(`sudo ip link del ${this.veth.host.name}`).catch(() => {}),
        this.#exec(`sudo ip netns del ${this.name}`).catch(() => {}),
      ]);

      throw e;
    }
  }

  async uninstall() {
    const commands = [
      // 删除宿主机端的 veth（会自动清理对端）
      `sudo ip link del ${this.veth.host.name}`,
      // 删除命名空间（会自动清理内部所有设备）
      `sudo ip netns del ${this.name}`,
    ];

    for (const cmd of commands) {
      await this.#exec(cmd).catch(() => {});
    }
  }

  async health() {
    const link = await this.#exec(`ip link show ${this.veth.host.name}`).then(
      () => true,
      () => false,
    );

    if (!link) {
      return { ok: false, stage: "veth" } satisfies VMNet.Health;
    }

    const ns = await this.#exec(`ip netns list | grep -q "^${this.name}\\b"`).then(
      () => true,
      () => false,
    );

    if (!ns) {
      return { ok: false, stage: "netns" } satisfies VMNet.Health;
    }

    const tap = await this.#exec(`sudo ip netns exec ${this.name} ip link show ${VMNet.TAP}`).then(
      () => true,
      () => false,
    );

    if (!tap) {
      return { ok: false, stage: "tap" } satisfies VMNet.Health;
    }

    const ping = await this.#exec(`sudo ip netns exec ${this.name} ping -c 1 -W 1 ${this.veth.host.ip}`).then(
      () => true,
      () => false,
    );

    if (!ping) {
      return { ok: false, stage: "connectivity" } satisfies VMNet.Health;
    }

    return { ok: true } satisfies VMNet.Health;
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

  export const TAP = "cc-w-tap";
  export const TAP_NS_IP = "10.123.0.1";
  export const TAP_VM_IP = "10.123.0.2";

  export const DNS_RESOLVERS = ["8.8.8.8", "8.8.4.4"];

  export const NFT_TABLE_FILTER = "cc-w-filter";
  export const NFT_TABLE_NAT = "cc-w-nat";

  export type Health =
    | {
        ok: false;
        stage: "veth" | "netns" | "tap" | "connectivity";
      }
    | {
        ok: true;
      };
}
