import type { NodeInfo } from "@/types/komari";

const GIB = 1024 ** 3;
const TIB = 1024 ** 4;
const MIB = 1024 ** 2;

function dateAfter(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

const nodes: NodeInfo[] = [
  {
    uuid: "tokyo-edge-01",
    name: "Tokyo Edge",
    group: "生产",
    region: "JP",
    hidden: false,
    cpu_name: "AMD EPYC 7B13",
    cpu_cores: 4,
    arch: "x86_64",
    virtualization: "KVM",
    os: "debian",
    kernel_version: "6.1.0",
    gpu_name: "",
    mem_total: 8 * GIB,
    swap_total: 2 * GIB,
    disk_total: 160 * GIB,
    weight: 10,
    price: 48,
    billing_cycle: "month",
    auto_renewal: true,
    currency: "CNY",
    expired_at: dateAfter(24),
    tags: "边缘, 高带宽",
    public_remark: "东京入口与静态资源",
    traffic_limit: 4 * TIB,
    traffic_limit_type: "sum",
    ipv4: "203.0.113.11",
    ipv6: "2001:db8::11",
    created_at: dateAfter(-420),
    updated_at: new Date().toISOString(),
  },
  {
    uuid: "singapore-api-01",
    name: "Singapore API",
    group: "生产",
    region: "SG",
    hidden: false,
    cpu_name: "Intel Xeon Gold 6338",
    cpu_cores: 8,
    arch: "x86_64",
    virtualization: "KVM",
    os: "ubuntu",
    kernel_version: "6.8.0",
    gpu_name: "",
    mem_total: 16 * GIB,
    swap_total: 4 * GIB,
    disk_total: 240 * GIB,
    weight: 20,
    price: 18,
    billing_cycle: "month",
    auto_renewal: true,
    currency: "USD",
    expired_at: dateAfter(12),
    tags: "API, 核心",
    public_remark: "东南亚 API 集群",
    traffic_limit: 6 * TIB,
    traffic_limit_type: "sum",
    ipv4: "203.0.113.21",
    ipv6: "2001:db8::21",
    created_at: dateAfter(-310),
    updated_at: new Date().toISOString(),
  },
  {
    uuid: "frankfurt-db-01",
    name: "Frankfurt DB",
    group: "生产",
    region: "DE",
    hidden: false,
    cpu_name: "AMD EPYC 7763",
    cpu_cores: 12,
    arch: "x86_64",
    virtualization: "KVM",
    os: "alma",
    kernel_version: "5.14.0",
    gpu_name: "",
    mem_total: 32 * GIB,
    swap_total: 8 * GIB,
    disk_total: 480 * GIB,
    weight: 30,
    price: 34,
    billing_cycle: "month",
    auto_renewal: false,
    currency: "EUR",
    expired_at: dateAfter(3),
    tags: "数据库, 临期",
    public_remark: "主数据库副本",
    traffic_limit: 8 * TIB,
    traffic_limit_type: "sum",
    ipv4: "203.0.113.31",
    ipv6: "2001:db8::31",
    created_at: dateAfter(-260),
    updated_at: new Date().toISOString(),
  },
  {
    uuid: "new-york-worker-01",
    name: "New York Worker",
    group: "生产",
    region: "US",
    hidden: false,
    cpu_name: "Intel Xeon Platinum 8370C",
    cpu_cores: 8,
    arch: "x86_64",
    virtualization: "KVM",
    os: "rocky",
    kernel_version: "5.14.0",
    gpu_name: "",
    mem_total: 16 * GIB,
    swap_total: 4 * GIB,
    disk_total: 320 * GIB,
    weight: 40,
    price: 22,
    billing_cycle: "month",
    auto_renewal: true,
    currency: "USD",
    expired_at: dateAfter(46),
    tags: "任务队列",
    public_remark: "北美异步任务",
    traffic_limit: 5 * TIB,
    traffic_limit_type: "sum",
    ipv4: "203.0.113.41",
    ipv6: "2001:db8::41",
    created_at: dateAfter(-180),
    updated_at: new Date().toISOString(),
  },
  {
    uuid: "hong-kong-cache-01",
    name: "Hong Kong Cache",
    group: "边缘",
    region: "HK",
    hidden: false,
    cpu_name: "AMD EPYC 7543P",
    cpu_cores: 4,
    arch: "x86_64",
    virtualization: "KVM",
    os: "alpine",
    kernel_version: "6.6.12",
    gpu_name: "",
    mem_total: 6 * GIB,
    swap_total: 2 * GIB,
    disk_total: 120 * GIB,
    weight: 50,
    price: 68,
    billing_cycle: "quarter",
    auto_renewal: true,
    currency: "CNY",
    expired_at: dateAfter(61),
    tags: "缓存, 边缘",
    public_remark: "香港缓存层",
    traffic_limit: 3 * TIB,
    traffic_limit_type: "sum",
    ipv4: "203.0.113.51",
    ipv6: "2001:db8::51",
    created_at: dateAfter(-150),
    updated_at: new Date().toISOString(),
  },
  {
    uuid: "sydney-backup-01",
    name: "Sydney Backup",
    group: "备份",
    region: "AU",
    hidden: false,
    cpu_name: "Ampere Altra",
    cpu_cores: 4,
    arch: "aarch64",
    virtualization: "KVM",
    os: "ubuntu",
    kernel_version: "6.8.0",
    gpu_name: "",
    mem_total: 8 * GIB,
    swap_total: 2 * GIB,
    disk_total: 640 * GIB,
    weight: 60,
    price: 14,
    billing_cycle: "month",
    auto_renewal: false,
    currency: "USD",
    expired_at: dateAfter(19),
    tags: "备份",
    public_remark: "离线备份节点",
    traffic_limit: 2 * TIB,
    traffic_limit_type: "sum",
    ipv4: "203.0.113.61",
    ipv6: "2001:db8::61",
    created_at: dateAfter(-120),
    updated_at: new Date().toISOString(),
  },
];

const statusProfiles = [
  [18, 2.1, 0.7, 34, 11, 18_000_000, 72_000_000, 820 * GIB, 1.1 * TIB, true],
  [46, 9.2, 2.6, 57, 38, 32_000_000, 98_000_000, 1.8 * TIB, 2.2 * TIB, true],
  [91, 27.4, 8.8, 83, 161, 8_000_000, 24_000_000, 3.6 * TIB, 2.9 * TIB, true],
  [63, 11.8, 3.4, 66, 78, 21_000_000, 54_000_000, 1.4 * TIB, 1.7 * TIB, true],
  [31, 3.4, 1.2, 42, 24, 28_000_000, 86_000_000, 740 * GIB, 1.3 * TIB, true],
  [0, 0, 0, 38, 232, 0, 0, 1.1 * TIB, 880 * GIB, false],
] as const;

function latestStatus() {
  const now = Date.now();
  return Object.fromEntries(
    nodes.map((node, index) => {
      const [cpu, load, swapPct, diskPct, ping, up, down, totalUp, totalDown, online] =
        statusProfiles[index];
      if (!online) return [node.uuid, { online: false }];
      const memoryPct = index === 2 ? 88 : 36 + index * 7;
      return [
        node.uuid,
        {
          online: true,
          cpu,
          ram: (node.mem_total * memoryPct) / 100,
          ram_total: node.mem_total,
          swap: (node.swap_total * swapPct) / 100,
          swap_total: node.swap_total,
          load,
          load5: load * 0.86,
          load15: load * 0.72,
          disk: (node.disk_total * diskPct) / 100,
          disk_total: node.disk_total,
          net_out: up,
          net_in: down,
          net_total_up: totalUp,
          net_total_down: totalDown,
          uptime: (index + 3) * 864_000,
          process: 96 + index * 21,
          connections: 180 + index * 44,
          connections_udp: 12 + index * 3,
          updated_at: now,
          mock_ping: ping,
        },
      ];
    }),
  );
}

function loadRecords(uuid: string) {
  const node = nodes.find((item) => item.uuid === uuid) ?? nodes[0];
  const index = nodes.indexOf(node);
  const profile = statusProfiles[Math.max(0, index)];
  const now = Date.now();
  return Array.from({ length: 72 }, (_, sample) => {
    const phase = sample / 7 + index;
    const cpu = Math.max(2, Math.min(98, profile[0] + Math.sin(phase) * 10));
    const ram = node.mem_total * Math.min(0.94, 0.35 + index * 0.08 + Math.cos(phase) * 0.04);
    return {
      cpu,
      gpu: 0,
      ram,
      ram_total: node.mem_total,
      swap: node.swap_total * 0.08,
      swap_total: node.swap_total,
      load: profile[1] + Math.sin(phase) * 0.8,
      temp: 48 + index * 4 + Math.sin(phase) * 3,
      disk: node.disk_total * (profile[3] / 100),
      disk_total: node.disk_total,
      net_in: Math.max(0, profile[6] * (0.7 + Math.sin(phase) * 0.24)),
      net_out: Math.max(0, profile[5] * (0.7 + Math.cos(phase) * 0.24)),
      net_total_up: Math.max(0, profile[7] - (71 - sample) * (12 + index * 3) * MIB),
      net_total_down: Math.max(0, profile[8] - (71 - sample) * (28 + index * 5) * MIB),
      process: 100 + index * 20,
      connections: 180 + index * 40,
      connections_udp: 16,
      time: now - (71 - sample) * 300_000,
      client: node.uuid,
    };
  });
}

// 模拟新版后端的 metric 存储行为：只返回 used/rate 类指标，
// memory.total / swap.total / disk.total 已废弃（obsoleteBuiltinMetricNames），不再返回。
const LOAD_METRIC_TO_FIELD = {
  "cpu.usage": "cpu",
  "memory.used": "ram",
  "swap.used": "swap",
  "load.average": "load",
  "disk.used": "disk",
  "net.in.rate": "net_in",
  "net.out.rate": "net_out",
  "net.total.up": "net_total_up",
  "net.total.down": "net_total_down",
  "process.count": "process",
  "connections.tcp": "connections",
  "connections.udp": "connections_udp",
} as const;

function loadMetricPayload(params: {
  metric_keys?: string[];
  entity_ids?: string[];
  hours?: number;
}) {
  const metricKeys = (params.metric_keys ?? []).filter(
    (key): key is keyof typeof LOAD_METRIC_TO_FIELD => key in LOAD_METRIC_TO_FIELD,
  );
  const entityIds = params.entity_ids?.length ? params.entity_ids : [nodes[0].uuid];
  const now = Date.now();
  const series = entityIds.flatMap((uuid) => {
    const records = loadRecords(uuid);
    return metricKeys.map((metricKey) => ({
      metric_key: metricKey,
      entity_id: uuid,
      interval_seconds: 300,
      points: records.map((record) => ({
        time: new Date(Number(record.time)).toISOString(),
        value: record[LOAD_METRIC_TO_FIELD[metricKey]],
        count: 1,
      })),
    }));
  });
  return {
    start: new Date(now - (params.hours ?? 6) * 3_600_000).toISOString(),
    end: new Date(now).toISOString(),
    series,
    count: series.length,
  };
}

function trafficMetricPayload(params: {
  metric_keys?: string[];
  entity_ids?: string[];
  start?: string;
  end?: string;
}) {
  const start = Number.isFinite(Date.parse(params.start ?? ""))
    ? Date.parse(params.start ?? "")
    : new Date().setHours(0, 0, 0, 0);
  const end = Number.isFinite(Date.parse(params.end ?? ""))
    ? Date.parse(params.end ?? "")
    : Date.now();
  const entityIds = params.entity_ids?.length ? params.entity_ids : nodes.map((node) => node.uuid);
  const metricKeys = params.metric_keys ?? [];
  const intervalMs = 5 * 60 * 1000;
  const pointCount = Math.max(1, Math.ceil((end - start) / intervalMs));
  const series = entityIds.flatMap((uuid) => {
    const index = nodes.findIndex((node) => node.uuid === uuid);
    if (index < 0 || index === nodes.length - 1) return [];
    return metricKeys.map((metricKey) => ({
      metric_key: metricKey,
      entity_id: uuid,
      interval_seconds: intervalMs / 1000,
      points: Array.from({ length: pointCount }, (_, pointIndex) => {
        const phase = pointIndex / 9 + index * 0.8;
        const time = new Date(start + pointIndex * intervalMs).toISOString();
        const value =
          metricKey === "traffic.up"
            ? (12 + index * 3) * MIB * (0.72 + Math.sin(phase) * 0.24)
            : metricKey === "traffic.down"
              ? (28 + index * 5) * MIB * (0.74 + Math.cos(phase) * 0.22)
              : metricKey === "net.out.rate"
                ? statusProfiles[index][5] * (0.62 + Math.sin(phase) * 0.34)
                : statusProfiles[index][6] * (0.66 + Math.cos(phase) * 0.3);
        return { time, value: Math.max(0, value), count: 1 };
      }),
    }));
  });
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    series,
    count: series.length,
  };
}

function pingRecords(uuid?: string) {
  const clients = uuid ? [uuid] : nodes.map((node) => node.uuid);
  const now = Date.now();
  return clients.flatMap((client) => {
    const index = nodes.findIndex((node) => node.uuid === client);
    const baseline = statusProfiles[Math.max(0, index)][4];
    return Array.from({ length: 60 }, (_, sample) => ({
      task_id: 1,
      time: now - (59 - sample) * 60_000,
      value:
        index === 2 && sample % 17 === 0
          ? -1
          : Math.max(1, baseline + Math.round(Math.sin(sample / 5 + index) * 9)),
      client,
    }));
  });
}

const pingTask = {
  id: 1,
  interval: 60,
  name: "全球 ICMP",
  loss: 0,
  clients: nodes.map((node) => node.uuid),
  type: "icmp",
  target: "1.1.1.1",
  weight: 1,
};

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

export function installDevMockApi() {
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url, window.location.origin);

    if (url.hostname === "api.frankfurter.dev") {
      return json([
        { base: "USD", quote: "CNY", rate: 7.18 },
        { base: "USD", quote: "EUR", rate: 0.86 },
        { base: "USD", quote: "JPY", rate: 146.4 },
      ]);
    }

    if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) {
      return nativeFetch(input, init);
    }

    if (url.pathname === "/api/me") {
      return json({ logged_in: false, username: "", uuid: "" });
    }

    if (url.pathname === "/api/public") {
      return json({
        sitename: "Lumina Ops",
        description: "全球节点运行状态",
        theme: "komari-theme-luminalite",
        allow_cors: false,
        disable_password_login: false,
        oauth_enable: false,
        private_site: false,
        record_enabled: true,
        record_preserve_time: 30,
        ping_record_preserve_time: 30,
        metric_retention_days: 90,
        custom_head: "",
        custom_body: "",
        theme_settings: {
          desktopNodeViewMode: "compact",
          mobileNodeViewMode: "compact",
          showHomeOverview: true,
          showGroupTabs: true,
          showRegionBar: true,
          showCardGroup: true,
          enableHomeSort: true,
          showPingChart: true,
          homepagePingBindings: { "1": nodes.map((node) => node.uuid) },
        },
      });
    }

    if (url.pathname === "/api/nodes") {
      return json(nodes);
    }

    if (url.pathname === "/api/rpc2") {
      const payload = (await request.json()) as {
        id?: number | string;
        method?: string;
        params?: {
          uuid?: string;
          type?: string;
          metric_keys?: string[];
          entity_ids?: string[];
          start?: string;
          end?: string;
        };
      };
      let result: unknown = {};
      if (payload.method === "public:queryMetrics") {
        const metricKeys = payload.params?.metric_keys ?? [];
        if (metricKeys.some((key) => key === "traffic.up" || key === "traffic.down")) {
          result = trafficMetricPayload(payload.params ?? {});
        } else if (metricKeys.some((key) => key in LOAD_METRIC_TO_FIELD)) {
          // 模拟新版后端：返回 used/rate 类指标，不返回已废弃的 total 类指标。
          result = loadMetricPayload(payload.params ?? {});
        } else {
          return json({
            jsonrpc: "2.0",
            id: payload.id,
            error: { code: -32601, message: `Method not found: ${payload.method}` },
          });
        }
      } else if (payload.method === "public:getPingMetricStats") {
        // mock 数据仍由兼容 records 接口提供；明确返回 Method not found 才会触发
        // api.ts 的旧接口回退，不能用空对象伪装成功（那会得到空图表）。
        return json({
          jsonrpc: "2.0",
          id: payload.id,
          error: { code: -32601, message: `Method not found: ${payload.method}` },
        });
      }
      if (payload.method === "public:getPublicPingTasks") {
        result = [pingTask];
      } else if (payload.method === "common:getNodes") {
        result = Object.fromEntries(nodes.map((node) => [node.uuid, node]));
      } else if (payload.method === "common:getNodesLatestStatus") {
        result = latestStatus();
      } else if (payload.method === "common:getRecords") {
        const isPing = payload.params?.type === "ping";
        const records = isPing
          ? pingRecords(payload.params?.uuid)
          : loadRecords(payload.params?.uuid ?? nodes[0].uuid);
        result = { count: records.length, records, tasks: isPing ? [pingTask] : [] };
      }
      return json({ jsonrpc: "2.0", id: payload.id, result });
    }

    return json({ message: `No mock for ${url.pathname}` }, { status: 404 });
  };
}
