import type { NodeInfo, NodeMetrics, NodeRealtime, TrafficTrendSample } from "@/types/komari";
import { getNodes, getNodesLatestStatus } from "@/services/api";

type Listener = () => void;
type RealtimePayload = Record<string, unknown>;

interface State {
  metaByUuid: Record<string, NodeInfo>;
  metricsByUuid: Record<string, NodeMetrics>;
  trafficTrends: Record<string, NodeTrafficTrend>;
  order: string[];
  failureStreak: number;
}

export interface StoreStatusSnapshot {
  failureStreak: number;
  hydrated: boolean;
  nodeInfoError: boolean;
}

export interface HomeNodeSummary {
  uuid: string;
  group: string;
  region: string;
  hidden: boolean;
  weight: number;
  online: boolean | null;
  trafficUp: number;
  trafficDown: number;
  netUp: number;
  netDown: number;
  connectionsTcp: number;
  connectionsUdp: number;
}

interface TrafficTrendSeries {
  buffer: TrafficTrendSample[];
  start: number;
  size: number;
  signature: string;
  snapshot: TrafficTrendSample[];
}

interface NodeTrafficTrend {
  up: TrafficTrendSeries;
  down: TrafficTrendSeries;
  snapshot: {
    up: TrafficTrendSample[];
    down: TrafficTrendSample[];
  };
}

const LIVE_STATUS_REFRESH_INTERVAL_MS = 2_000;
const NODE_INFO_REFRESH_INTERVAL_MS = 30_000;
// 较短超时可让 half-open 连接尽快重试。
const LIVE_STATUS_REQUEST_TIMEOUT_MS = 8_000;
const SCROLL_IDLE_DELAY_MS = 160;
// 用户无交互超过此阈值时，实时指标轮询降频以节省 CPU / 电量。
const IDLE_THRESHOLD_MS = 120_000;
const IDLE_REFRESH_INTERVAL_MS = 10_000;
const IDLE_NODE_INFO_INTERVAL_MS = 60_000;
// WebSocket 实时通道（同默认主题 /api/clients），RPC 轮询仅作降级兜底。
const WS_RECONNECT_DELAY_MS = 3_000;
const WS_FRESH_THRESHOLD_MS = 8_000;
const TRAFFIC_TREND_SAMPLE_COUNT = 18;
const EMPTY_TRAFFIC_TREND_SAMPLE: TrafficTrendSample = {
  value: 0,
  level: 0.25,
  opacity: 0.52,
};
const EMPTY_TRAFFIC_TREND_SNAPSHOT = Array.from(
  { length: TRAFFIC_TREND_SAMPLE_COUNT },
  () => EMPTY_TRAFFIC_TREND_SAMPLE,
);
const EMPTY_TRAFFIC_TREND_SERIES: TrafficTrendSeries = {
  buffer: [],
  start: 0,
  size: 0,
  signature: "",
  snapshot: EMPTY_TRAFFIC_TREND_SNAPSHOT,
};
const EMPTY_NODE_TRAFFIC_TREND_SNAPSHOT = {
  up: EMPTY_TRAFFIC_TREND_SNAPSHOT,
  down: EMPTY_TRAFFIC_TREND_SNAPSHOT,
};
const EMPTY_TRAFFIC_TREND: NodeTrafficTrend = {
  up: EMPTY_TRAFFIC_TREND_SERIES,
  down: EMPTY_TRAFFIC_TREND_SERIES,
  snapshot: EMPTY_NODE_TRAFFIC_TREND_SNAPSHOT,
};

function emptyState(): State {
  return {
    metaByUuid: {},
    metricsByUuid: {},
    trafficTrends: {},
    order: [],
    failureStreak: 0,
  };
}

function emptyMetrics(info: NodeInfo, online: boolean | null): NodeMetrics {
  return {
    online,
    cpuPct: 0,
    ramUsed: 0,
    ramTotal: info.mem_total,
    ramPct: 0,
    swapUsed: 0,
    swapTotal: info.swap_total,
    diskUsed: 0,
    diskTotal: info.disk_total,
    diskPct: 0,
    netUp: 0,
    netDown: 0,
    trafficUp: 0,
    trafficDown: 0,
    uptime: 0,
    load1: 0,
    load5: 0,
    load15: 0,
    process: 0,
    connectionsTcp: 0,
    connectionsUdp: 0,
    updatedAt: 0,
    pingLatest: null,
    pingLoss: null,
    gpuPct: 0,
    gpuMemUsed: 0,
    gpuMemTotal: 0,
    gpuTemp: 0,
  };
}

function alignEmptyMetricsTotals(metrics: NodeMetrics, info: NodeInfo): NodeMetrics {
  if (metrics.updatedAt > 0) return metrics;
  if (
    metrics.ramTotal === info.mem_total &&
    metrics.swapTotal === info.swap_total &&
    metrics.diskTotal === info.disk_total
  ) {
    return metrics;
  }

  return {
    ...metrics,
    ramTotal: info.mem_total,
    swapTotal: info.swap_total,
    diskTotal: info.disk_total,
  };
}

// 累计流量直接跟随后端计数器下降；0 视为本帧缺样，避免局部帧闪零。
export function resolveTrafficTotal(previous: number, raw: number): number {
  return Number.isFinite(raw) && raw > 0 ? raw : previous;
}

// ─── 内嵌 Ping 绑定解析器 ─────────────────────────────────────────────────────
// 由 useHomepagePingOverview 挂载时注入，输入 uuid 输出当前绑定的 taskId 字符串。
// 无绑定时返回 undefined，此时 mergeRealtime 会取 ping map 的第一个 task。
type PingBindingResolver = (uuid: string) => string | undefined;
let pingBindingResolver: PingBindingResolver | null = null;

export function setPingBindingResolver(resolver: PingBindingResolver | null) {
  pingBindingResolver = resolver;
}

function resolveTrafficTotals(previous: NodeMetrics, nextUp: number, nextDown: number) {
  return {
    up: resolveTrafficTotal(previous.trafficUp, nextUp),
    down: resolveTrafficTotal(previous.trafficDown, nextDown),
  };
}

function mergeRealtime(
  metrics: NodeMetrics,
  rt: NodeRealtime,
  online: boolean,
  uuid: string,
): NodeMetrics {
  const ramUsed = rt.ram.used;
  const ramTotal = rt.ram.total;
  const swapUsed = rt.swap.used;
  const swapTotal = rt.swap.total;
  const diskUsed = rt.disk.used;
  const diskTotal = rt.disk.total;
  const updatedAt = toTimestamp(rt.updated_at);
  const trafficTotals = resolveTrafficTotals(
    metrics,
    rt.network?.totalUp ?? 0,
    rt.network?.totalDown ?? 0,
  );

  // 从内嵌 ping map 中提取当前绑定任务的实时延迟/丢包。
  let pingLatest: number | null = null;
  let pingLoss: number | null = null;
  if (rt.ping) {
    const boundTaskId = pingBindingResolver?.(uuid);
    const entry = boundTaskId != null
      ? rt.ping[boundTaskId]
      : Object.values(rt.ping)[0];
    if (entry) {
      pingLatest = Number.isFinite(entry.latest) ? entry.latest : null;
      pingLoss = Number.isFinite(entry.loss) ? entry.loss : null;
    }
  }

  return {
    online,
    cpuPct: rt.cpu?.usage ?? 0,
    ramUsed,
    ramTotal,
    ramPct: ramTotal > 0 ? (ramUsed / ramTotal) * 100 : 0,
    swapUsed,
    swapTotal,
    diskUsed,
    diskTotal,
    diskPct: diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0,
    netUp: rt.network?.up ?? 0,
    netDown: rt.network?.down ?? 0,
    trafficUp: trafficTotals.up,
    trafficDown: trafficTotals.down,
    uptime: rt.uptime ?? 0,
    load1: rt.load?.load1 ?? 0,
    load5: rt.load?.load5 ?? 0,
    load15: rt.load?.load15 ?? 0,
    process: rt.process ?? 0,
    connectionsTcp: rt.connections?.tcp ?? 0,
    connectionsUdp: rt.connections?.udp ?? 0,
    updatedAt: updatedAt > 0 ? updatedAt : metrics.updatedAt,
    pingLatest,
    pingLoss,
    // RPC（getNodesLatestStatus）硬编码 gpu=0，不携带 GPU 数据；
    // WS 通道提供 GPU 后，后续 RPC 帧不应将其冲零。
    gpuPct: rt.gpu?.usage ?? metrics.gpuPct,
    gpuMemUsed: rt.gpu?.memoryUsed ?? metrics.gpuMemUsed,
    gpuMemTotal: rt.gpu?.memoryTotal ?? metrics.gpuMemTotal,
    gpuTemp: rt.gpu?.temperature ?? metrics.gpuTemp,
  };
}

function shallowEqualMetrics(a: NodeMetrics, b: NodeMetrics) {
  return (
    a.online === b.online &&
    a.cpuPct === b.cpuPct &&
    a.ramUsed === b.ramUsed &&
    a.ramTotal === b.ramTotal &&
    a.ramPct === b.ramPct &&
    a.swapUsed === b.swapUsed &&
    a.swapTotal === b.swapTotal &&
    a.diskUsed === b.diskUsed &&
    a.diskTotal === b.diskTotal &&
    a.diskPct === b.diskPct &&
    a.netUp === b.netUp &&
    a.netDown === b.netDown &&
    a.trafficUp === b.trafficUp &&
    a.trafficDown === b.trafficDown &&
    a.uptime === b.uptime &&
    a.load1 === b.load1 &&
    a.load5 === b.load5 &&
    a.load15 === b.load15 &&
    a.process === b.process &&
    a.connectionsTcp === b.connectionsTcp &&
    a.connectionsUdp === b.connectionsUdp &&
    a.updatedAt === b.updatedAt &&
    a.pingLatest === b.pingLatest &&
    a.pingLoss === b.pingLoss &&
    a.gpuPct === b.gpuPct &&
    a.gpuMemUsed === b.gpuMemUsed &&
    a.gpuMemTotal === b.gpuMemTotal &&
    a.gpuTemp === b.gpuTemp
  );
}

function shallowEqualNodeInfo(a: NodeInfo, b: NodeInfo) {
  return (
    a.uuid === b.uuid &&
    a.name === b.name &&
    a.group === b.group &&
    a.region === b.region &&
    a.hidden === b.hidden &&
    a.ipv4 === b.ipv4 &&
    a.ipv6 === b.ipv6 &&
    a.cpu_name === b.cpu_name &&
    a.cpu_cores === b.cpu_cores &&
    a.arch === b.arch &&
    a.virtualization === b.virtualization &&
    a.os === b.os &&
    a.kernel_version === b.kernel_version &&
    a.gpu_name === b.gpu_name &&
    a.mem_total === b.mem_total &&
    a.swap_total === b.swap_total &&
    a.disk_total === b.disk_total &&
    a.weight === b.weight &&
    a.price === b.price &&
    a.billing_cycle === b.billing_cycle &&
    a.auto_renewal === b.auto_renewal &&
    a.currency === b.currency &&
    a.expired_at === b.expired_at &&
    a.tags === b.tags &&
    a.public_remark === b.public_remark &&
    a.traffic_limit === b.traffic_limit &&
    a.traffic_limit_type === b.traffic_limit_type &&
    a.created_at === b.created_at
    // updated_at 是未展示的心跳字段，不应触发整个节点列表重渲染。
  );
}

function materializeTrafficTrendSnapshot(
  buffer: TrafficTrendSample[],
  start: number,
  size: number,
) {
  if (size <= 0) return EMPTY_TRAFFIC_TREND_SNAPSHOT;

  const snapshot = new Array<TrafficTrendSample>(TRAFFIC_TREND_SAMPLE_COUNT);
  const padding = TRAFFIC_TREND_SAMPLE_COUNT - size;

  for (let i = 0; i < padding; i++) {
    snapshot[i] = EMPTY_TRAFFIC_TREND_SAMPLE;
  }

  for (let i = 0; i < size; i++) {
    snapshot[padding + i] = buffer[(start + i) % TRAFFIC_TREND_SAMPLE_COUNT]!;
  }

  return snapshot;
}

function updateTrafficTrendSeries(
  prevSeries: TrafficTrendSeries,
  value: number,
  updatedAt: number,
  online: boolean | null,
) {
  if (online === false) {
    if (!prevSeries.signature && prevSeries.size === 0) {
      return { series: prevSeries, changed: false };
    }
    return { series: EMPTY_TRAFFIC_TREND_SERIES, changed: true };
  }

  const safeValue = Number.isFinite(value) && value > 0 ? value : 0;
  const signature = `${updatedAt || 0}:${safeValue}`;
  if (signature === prevSeries.signature) {
    return { series: prevSeries, changed: false };
  }

  let visibleMax = safeValue > 0 ? safeValue : 1;
  for (let i = 0; i < prevSeries.size; i++) {
    const sample = prevSeries.buffer[(prevSeries.start + i) % TRAFFIC_TREND_SAMPLE_COUNT];
    if (sample && sample.value > visibleMax) {
      visibleMax = sample.value;
    }
  }

  const level = safeValue > 0 ? Math.max(0.2, Math.min(1, safeValue / visibleMax)) : 0.25;
  const nextSample: TrafficTrendSample = {
    value: safeValue,
    level,
    opacity: safeValue > 0 ? 0.4 + level * 0.48 : 0.52,
  };

  const buffer = new Array<TrafficTrendSample>(TRAFFIC_TREND_SAMPLE_COUNT);
  const nextSize =
    prevSeries.size < TRAFFIC_TREND_SAMPLE_COUNT
      ? prevSeries.size + 1
      : TRAFFIC_TREND_SAMPLE_COUNT;
  const nextStart =
    prevSeries.size < TRAFFIC_TREND_SAMPLE_COUNT
      ? prevSeries.start
      : (prevSeries.start + 1) % TRAFFIC_TREND_SAMPLE_COUNT;
  const insertIndex =
    prevSeries.size < TRAFFIC_TREND_SAMPLE_COUNT
      ? (prevSeries.start + prevSeries.size) % TRAFFIC_TREND_SAMPLE_COUNT
      : prevSeries.start;

  if (prevSeries.size > 0) {
    for (let i = 0; i < prevSeries.size; i++) {
      buffer[(prevSeries.start + i) % TRAFFIC_TREND_SAMPLE_COUNT] =
        prevSeries.buffer[(prevSeries.start + i) % TRAFFIC_TREND_SAMPLE_COUNT]!;
    }
  }
  buffer[insertIndex] = nextSample;

  return {
    series: {
      buffer,
      start: nextStart,
      size: nextSize,
      signature,
      snapshot: materializeTrafficTrendSnapshot(buffer, nextStart, nextSize),
    },
    changed: true,
  };
}

let state: State = emptyState();
const visibleNodeListeners = new Set<Listener>();
const allNodesListeners = new Set<Listener>();
const homeNodeSummaryListeners = new Set<Listener>();
const storeStatusListeners = new Set<Listener>();
const nodeMetaListeners = new Map<string, Set<Listener>>();
const nodeMetricsListeners = new Map<string, Set<Listener>>();
const trafficTrendListeners = new Map<string, Set<Listener>>();
let storeVersion = 0;
let visibleNodeUuidsSnapshot: string[] = [];
let visibleNodeUuidsSnapshotVersion = -1;
let visibleNodeUuidsWithHiddenSnapshot: string[] = [];
let visibleNodeUuidsWithHiddenSnapshotVersion = -1;
let allNodeMetaSnapshot: NodeInfo[] = [];
let allNodeMetaSnapshotVersion = -1;
let homeNodeSummariesSnapshot: HomeNodeSummary[] = [];
let homeNodeSummariesSnapshotVersion = -1;
let storeStatusSnapshot: StoreStatusSnapshot = {
  failureStreak: 0,
  hydrated: false,
  nodeInfoError: false,
};
let scrollIdleTimer: number | null = null;
let scrollTrackingStarted = false;
let scrollActive = false;
let refreshDeferredWhileScrolling = false;
let ws: WebSocket | null = null;
let wsGetTimer: number | null = null;
let wsReconnectTimer: number | null = null;
let wsLastMessageAt = 0;

interface CommitTouches {
  meta?: Iterable<string>;
  metrics?: Iterable<string>;
  trafficTrends?: Iterable<string>;
  nodeList?: boolean;
  allNodes?: boolean;
  storeStatus?: boolean;
}

function emitListeners(listeners: Iterable<Listener>) {
  for (const listener of listeners) listener();
}

function emitMappedListeners(
  listenersByKey: Map<string, Set<Listener>>,
  keys: Iterable<string>,
) {
  for (const key of keys) {
    const listeners = listenersByKey.get(key);
    if (listeners) emitListeners(listeners);
  }
}

function hasAny(items: Iterable<string> | undefined): boolean {
  if (!items) return false;
  return !items[Symbol.iterator]().next().done;
}

function commit(next: State, touches: CommitTouches = {}) {
  state = next;
  // 派生快照以 storeVersion 作缓存键。
  storeVersion += 1;
  // 空集合也是 truthy，需检查内容才能避免误广播。
  const homeTouched =
    Boolean(touches.nodeList || touches.allNodes) ||
    hasAny(touches.meta) ||
    hasAny(touches.metrics);

  if (touches.nodeList) emitListeners(visibleNodeListeners);
  if (touches.allNodes) emitListeners(allNodesListeners);
  if (homeTouched) emitListeners(homeNodeSummaryListeners);
  if (touches.storeStatus) emitListeners(storeStatusListeners);
  if (touches.meta) {
    emitMappedListeners(nodeMetaListeners, touches.meta);
  }
  if (touches.metrics) {
    emitMappedListeners(nodeMetricsListeners, touches.metrics);
  }
  if (touches.trafficTrends) emitMappedListeners(trafficTrendListeners, touches.trafficTrends);
}

function markScrollActivity() {
  scrollActive = true;
  if (scrollIdleTimer != null) {
    window.clearTimeout(scrollIdleTimer);
  }
  scrollIdleTimer = window.setTimeout(() => {
    scrollIdleTimer = null;
    scrollActive = false;
    if (refreshDeferredWhileScrolling) {
      refreshDeferredWhileScrolling = false;
      void refreshLatestStatus();
    }
  }, SCROLL_IDLE_DELAY_MS);
}

function ensureScrollTrackingStarted() {
  if (scrollTrackingStarted) return;
  scrollTrackingStarted = true;
  window.addEventListener("scroll", markScrollActivity, { passive: true });
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asRecord(value: unknown): RealtimePayload {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RealtimePayload)
    : {};
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "" || normalized === "0" || normalized === "false") return false;
    if (normalized === "1" || normalized === "true") return true;
  }
  return fallback;
}

function resolveOnline(rawRecord: unknown): boolean {
  if (rawRecord == null) return false;
  if (typeof rawRecord === "boolean") return rawRecord;
  const record = asRecord(rawRecord);
  return asBoolean(record.online, Object.keys(record).length > 0);
}

function toTimestamp(value: string | number | undefined): number {
  if (typeof value === "number") {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (!value) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

// 旧扁平协议的 connections 是 TCP+UDP 合计。
export function resolveFlatConnectionsTcp(payload: RealtimePayload): number {
  if (payload.connections_tcp != null) return asNumber(payload.connections_tcp);
  return Math.max(0, asNumber(payload.connections) - asNumber(payload.connections_udp));
}

/**
 * 解析后端 v1.Report 中的 GPU 字段。
 * 后端协议：{ count, average_usage, detailed_info: [{ name, memory_total, memory_used, utilization, temperature }] }
 * 兼容旧版扁平字段（usage / memoryUsed 等）。
 */
function parseGpuReport(
  gpu: RealtimePayload,
): { usage: number; memoryUsed?: number; memoryTotal?: number; temperature?: number } | undefined {
  if (Object.keys(gpu).length === 0) return undefined;

  // 新版协议：average_usage + detailed_info[]
  const detailedInfo = gpu.detailed_info;
  if (Array.isArray(detailedInfo) && detailedInfo.length > 0) {
    let memoryUsed = 0;
    let memoryTotal = 0;
    let tempSum = 0;
    let tempCount = 0;
    for (const device of detailedInfo) {
      const d = asRecord(device);
      memoryUsed += asNumber(d.memory_used ?? d.memoryUsed);
      memoryTotal += asNumber(d.memory_total ?? d.memoryTotal);
      const temp = asNumber(d.temperature, -1);
      if (temp >= 0) {
        tempSum += temp;
        tempCount += 1;
      }
    }
    return {
      usage: asNumber(gpu.average_usage ?? gpu.averageUsage ?? gpu.usage),
      memoryUsed,
      memoryTotal,
      temperature: tempCount > 0 ? tempSum / tempCount : undefined,
    };
  }

  // 旧版 / 扁平协议兼容
  const usage = asNumber(gpu.average_usage ?? gpu.averageUsage ?? gpu.usage);
  if (usage <= 0 && !asNumber(gpu.memory_used ?? gpu.memoryUsed) && !asNumber(gpu.temperature)) {
    return undefined;
  }
  return {
    usage,
    memoryUsed: asNumber(gpu.memory_used ?? gpu.memoryUsed) || undefined,
    memoryTotal: asNumber(gpu.memory_total ?? gpu.memoryTotal) || undefined,
    temperature: asNumber(gpu.temperature) || undefined,
  };
}

function normalizeRealtime(
  raw: unknown,
  meta: NodeInfo,
  metrics: NodeMetrics,
): NodeRealtime | null {
  const payload = asRecord(raw);
  if (Object.keys(payload).length === 0) return null;

  const cpu = asRecord(payload.cpu);
  const gpu = asRecord(payload.gpu);
  const ram = asRecord(payload.ram);
  const swap = asRecord(payload.swap);
  const load = asRecord(payload.load);
  const disk = asRecord(payload.disk);
  const network = asRecord(payload.network);
  const connections = asRecord(payload.connections);
  const hasNestedShape =
    Object.keys(cpu).length > 0 ||
    Object.keys(ram).length > 0 ||
    Object.keys(network).length > 0;

  const ping = parseEmbeddedPing(payload.ping);

  if (hasNestedShape) {
    return {
      cpu: { usage: asNumber(cpu.usage) },
      gpu: parseGpuReport(gpu),
      ram: {
        total: asNumber(ram.total, metrics.ramTotal || meta.mem_total),
        used: asNumber(ram.used),
      },
      swap: {
        total: asNumber(swap.total, metrics.swapTotal || meta.swap_total),
        used: asNumber(swap.used),
      },
      load: {
        load1: asNumber(load.load1),
        load5: asNumber(load.load5),
        load15: asNumber(load.load15),
      },
      disk: {
        total: asNumber(disk.total, metrics.diskTotal || meta.disk_total),
        used: asNumber(disk.used),
      },
      network: {
        up: asNumber(network.up),
        down: asNumber(network.down),
        totalUp: asNumber(network.totalUp),
        totalDown: asNumber(network.totalDown),
      },
      connections: {
        tcp: asNumber(connections.tcp),
        udp: asNumber(connections.udp),
      },
      uptime: asNumber(payload.uptime),
      process: asNumber(payload.process),
      updated_at: (payload.updated_at ?? payload.time) as string | number | undefined,
      ping,
    };
  }

  return {
    cpu: { usage: asNumber(payload.cpu) },
    gpu: typeof payload.gpu === "object" && payload.gpu !== null
      ? parseGpuReport(asRecord(payload.gpu))
      : asNumber(payload.gpu) > 0 || asNumber(payload.gpu_temperature) > 0
        ? {
            usage: asNumber(payload.gpu),
            memoryUsed: asNumber(payload.gpu_memory_used) || undefined,
            memoryTotal: asNumber(payload.gpu_memory_total) || undefined,
            temperature: asNumber(payload.gpu_temperature) || undefined,
          }
        : undefined,
    ram: {
      total: asNumber(payload.ram_total, metrics.ramTotal || meta.mem_total),
      used: asNumber(payload.ram),
    },
    swap: {
      total: asNumber(payload.swap_total, metrics.swapTotal || meta.swap_total),
      used: asNumber(payload.swap),
    },
    load: {
      load1: asNumber(payload.load),
      load5: asNumber(payload.load5),
      load15: asNumber(payload.load15),
    },
    disk: {
      total: asNumber(payload.disk_total, metrics.diskTotal || meta.disk_total),
      used: asNumber(payload.disk),
    },
    network: {
      up: asNumber(payload.net_out),
      down: asNumber(payload.net_in),
      totalUp: asNumber(payload.net_total_up),
      totalDown: asNumber(payload.net_total_down),
    },
    connections: {
      tcp: resolveFlatConnectionsTcp(payload),
      udp: asNumber(payload.connections_udp),
    },
    uptime: asNumber(payload.uptime),
    process: asNumber(payload.process),
    updated_at: (payload.updated_at ?? payload.time) as string | number | undefined,
    ping,
  };
}

/** 解析后端内嵌的 ping 字段：Record<taskId, { latest, loss, ... }> */
function parseEmbeddedPing(
  raw: unknown,
): Record<string, { latest: number; loss: number }> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const map = raw as Record<string, unknown>;
  const keys = Object.keys(map);
  if (keys.length === 0) return undefined;
  const result: Record<string, { latest: number; loss: number }> = {};
  for (const key of keys) {
    const entry = map[key];
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const latest = asNumber(rec.latest, -1);
    const loss = asNumber(rec.loss, -1);
    // latest < 0 表示无有效值（全部丢包时后端可能返回 -1）。
    result[key] = {
      latest: latest >= 0 ? latest : NaN,
      loss: loss >= 0 ? loss : NaN,
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function applyLatestStatus(records: Record<string, unknown>) {
  const touchedMetrics = new Set<string>();
  const touchedTrafficTrends = new Set<string>();
  // 安静 tick 不克隆整个索引。
  let nextMetricsByUuid = state.metricsByUuid;
  let nextTrafficTrends = state.trafficTrends;

  for (const uuid of state.order) {
    const meta = state.metaByUuid[uuid];
    const prev = state.metricsByUuid[uuid];
    if (!meta || !prev) continue;
    const rawRecord = records[uuid];
    const online = resolveOnline(rawRecord);
    const realtime = normalizeRealtime(rawRecord, meta, prev);
    const merged = realtime
      ? mergeRealtime(prev, realtime, online, uuid)
      : { ...prev, online };

    if (!shallowEqualMetrics(prev, merged)) {
      if (nextMetricsByUuid === state.metricsByUuid) {
        nextMetricsByUuid = { ...state.metricsByUuid };
      }
      nextMetricsByUuid[uuid] = merged;
      touchedMetrics.add(uuid);
    }

    const prevTrend = state.trafficTrends[uuid] ?? EMPTY_TRAFFIC_TREND;
    const nextUp = updateTrafficTrendSeries(
      prevTrend.up,
      merged.netUp,
      merged.updatedAt,
      merged.online,
    );
    const nextDown = updateTrafficTrendSeries(
      prevTrend.down,
      merged.netDown,
      merged.updatedAt,
      merged.online,
    );

    if (nextUp.changed || nextDown.changed) {
      if (nextTrafficTrends === state.trafficTrends) {
        nextTrafficTrends = { ...state.trafficTrends };
      }
      nextTrafficTrends[uuid] = {
        up: nextUp.series,
        down: nextDown.series,
        snapshot: {
          up: nextUp.series.snapshot,
          down: nextDown.series.snapshot,
        },
      };
      touchedTrafficTrends.add(uuid);
    }
  }

  return {
    nextMetricsByUuid,
    nextTrafficTrends,
    touchedMetrics: [...touchedMetrics],
    touchedTrafficTrends: [...touchedTrafficTrends],
  };
}

// ─── WebSocket 实时通道 ───────────────────────────────────────────────────────
// 与默认主题相同，通过 /api/clients WebSocket 获取完整 v1.Report（含 GPU）。
// RPC 轮询仅在 WS 不可用时作为降级路径。

function isMockMode(): boolean {
  try {
    return (
      import.meta.env.DEV &&
      new URLSearchParams(window.location.search).get("mock") === "1"
    );
  } catch {
    return false;
  }
}

function wsIsFresh(): boolean {
  return wsLastMessageAt > 0 && Date.now() - wsLastMessageAt < WS_FRESH_THRESHOLD_MS;
}

function applyWsLivePayload(payload: unknown) {
  const envelope = asRecord(payload);
  const body = asRecord(envelope.data);
  const dataMap = asRecord(body.data);
  const onlineList = body.online;
  const onlineSet = new Set(
    Array.isArray(onlineList)
      ? onlineList.filter((item): item is string => typeof item === "string")
      : [],
  );

  const touchedMetrics = new Set<string>();
  const touchedTrafficTrends = new Set<string>();
  let nextMetricsByUuid = state.metricsByUuid;
  let nextTrafficTrends = state.trafficTrends;

  for (const uuid of state.order) {
    const meta = state.metaByUuid[uuid];
    const prev = state.metricsByUuid[uuid];
    if (!meta || !prev) continue;
    if (!(uuid in dataMap)) continue;

    const online = onlineSet.has(uuid);
    const realtime = normalizeRealtime(dataMap[uuid], meta, prev);
    const merged = realtime
      ? mergeRealtime(prev, realtime, online, uuid)
      : { ...prev, online };

    if (!shallowEqualMetrics(prev, merged)) {
      if (nextMetricsByUuid === state.metricsByUuid) {
        nextMetricsByUuid = { ...state.metricsByUuid };
      }
      nextMetricsByUuid[uuid] = merged;
      touchedMetrics.add(uuid);
    }

    const prevTrend = state.trafficTrends[uuid] ?? EMPTY_TRAFFIC_TREND;
    const nextUp = updateTrafficTrendSeries(
      prevTrend.up,
      merged.netUp,
      merged.updatedAt,
      merged.online,
    );
    const nextDown = updateTrafficTrendSeries(
      prevTrend.down,
      merged.netDown,
      merged.updatedAt,
      merged.online,
    );

    if (nextUp.changed || nextDown.changed) {
      if (nextTrafficTrends === state.trafficTrends) {
        nextTrafficTrends = { ...state.trafficTrends };
      }
      nextTrafficTrends[uuid] = {
        up: nextUp.series,
        down: nextDown.series,
        snapshot: {
          up: nextUp.series.snapshot,
          down: nextDown.series.snapshot,
        },
      };
      touchedTrafficTrends.add(uuid);
    }
  }

  if (touchedMetrics.size > 0 || touchedTrafficTrends.size > 0) {
    commit(
      {
        ...state,
        metricsByUuid: touchedMetrics.size > 0 ? nextMetricsByUuid : state.metricsByUuid,
        trafficTrends:
          touchedTrafficTrends.size > 0 ? nextTrafficTrends : state.trafficTrends,
      },
      {
        metrics: touchedMetrics,
        trafficTrends: touchedTrafficTrends,
      },
    );
  }
}

function stopWsConnection() {
  if (wsGetTimer != null) {
    window.clearInterval(wsGetTimer);
    wsGetTimer = null;
  }
  if (wsReconnectTimer != null) {
    window.clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  if (ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    ws.close();
    ws = null;
  }
}

function startWsConnection() {
  if (ws || wsReconnectTimer != null || isMockMode()) return;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  let socket: WebSocket;
  try {
    socket = new WebSocket(`${protocol}//${window.location.host}/api/clients`);
  } catch {
    return;
  }
  ws = socket;

  socket.onopen = () => {
    wsLastMessageAt = Date.now();
    socket.send("get");
    wsGetTimer = window.setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send("get");
    }, LIVE_STATUS_REFRESH_INTERVAL_MS);
  };
  socket.onmessage = (event) => {
    wsLastMessageAt = Date.now();
    try {
      applyWsLivePayload(JSON.parse(String(event.data)));
    } catch {
      // 格式异常时忽略本帧。
    }
  };
  socket.onerror = () => {
    socket.close();
  };
  socket.onclose = () => {
    if (wsGetTimer != null) {
      window.clearInterval(wsGetTimer);
      wsGetTimer = null;
    }
    if (ws === socket) ws = null;
    if (started && !pageHidden && !isMockMode()) {
      wsReconnectTimer = window.setTimeout(() => {
        wsReconnectTimer = null;
        startWsConnection();
      }, WS_RECONNECT_DELAY_MS);
    }
  };
}

let hydrated = false;
let nodeInfoError = false;
let refreshInFlight = false;
let nodeInfoPromise: Promise<void> | null = null;
let liveStatusController: AbortController | null = null;
let nodeInfoController: AbortController | null = null;

function sortNodes(nodes: NodeInfo[]) {
  return [...nodes].sort((left, right) => left.weight - right.weight);
}

function syncNodeInfo() {
  nodeInfoPromise ??= performNodeInfoSync().finally(() => {
    nodeInfoPromise = null;
  });
  return nodeInfoPromise;
}

async function performNodeInfoSync() {
  const controller = new AbortController();
  nodeInfoController = controller;
  try {
    const nodes = sortNodes(await getNodes({ signal: controller.signal }));
    if (controller.signal.aborted) return;
    const order = nodes.map((node) => node.uuid);
    const touchedMeta = new Set<string>();
    const touchedMetrics = new Set<string>();
    const previousUuids = new Set(state.order);
    const nextUuids = new Set(order);
    const orderChanged =
      order.length !== state.order.length ||
      order.some((uuid, index) => uuid !== state.order[index]);
    const metaByUuid: Record<string, NodeInfo> = {};
    const metricsByUuid: Record<string, NodeMetrics> = {};

    for (const info of nodes) {
      const prev = state.metaByUuid[info.uuid];
      const isUnchanged = prev != null && shallowEqualNodeInfo(prev, info);
      const merged = isUnchanged ? prev : { ...info };
      metaByUuid[info.uuid] = merged;
      const previousMetrics = state.metricsByUuid[info.uuid];
      const nextMetrics = previousMetrics
        ? alignEmptyMetricsTotals(previousMetrics, info)
        : emptyMetrics(info, null);
      metricsByUuid[info.uuid] = nextMetrics;
      if (!isUnchanged) {
        touchedMeta.add(info.uuid);
      }
      if (!previousMetrics || previousMetrics !== nextMetrics) {
        touchedMetrics.add(info.uuid);
      }
    }

    for (const uuid of previousUuids) {
      if (!nextUuids.has(uuid)) {
        touchedMeta.add(uuid);
        touchedMetrics.add(uuid);
      }
    }

    const trafficTrends = Object.fromEntries(
      order.map((uuid) => [uuid, state.trafficTrends[uuid] ?? EMPTY_TRAFFIC_TREND]),
    );

    const nodeListChanged =
      orderChanged ||
      [...touchedMeta].some((uuid) => {
        const prev = state.metaByUuid[uuid];
        const next = metaByUuid[uuid];
        return Boolean(prev?.hidden) !== Boolean(next?.hidden);
      });

    const storeStatusChanged = !hydrated || nodeInfoError;
    hydrated = true;
    nodeInfoError = false;
    if (orderChanged || touchedMeta.size > 0 || touchedMetrics.size > 0 || storeStatusChanged) {
      commit(
        {
          ...state,
          order,
          metaByUuid,
          metricsByUuid,
          trafficTrends,
        },
        {
          meta: touchedMeta,
          metrics: touchedMetrics,
          // traffic trend 只由 refreshLatestStatus 改动;syncNodeInfo 原样带过来,这里无需通知。
          nodeList: nodeListChanged,
          allNodes: orderChanged || touchedMeta.size > 0,
          storeStatus: storeStatusChanged,
        },
      );
    }
  } catch (error) {
    if (!controller.signal.aborted && !nodeInfoError) {
      nodeInfoError = true;
      commit(state, { storeStatus: true });
    }
    throw error;
  } finally {
    if (nodeInfoController === controller) nodeInfoController = null;
  }
}

async function refreshLatestStatus() {
  if (refreshInFlight || state.order.length === 0) return;
  if (scrollActive) {
    refreshDeferredWhileScrolling = true;
    return;
  }

  refreshInFlight = true;
  const controller = new AbortController();
  liveStatusController = controller;
  try {
    const records = await getNodesLatestStatus([...state.order], {
      timeout: LIVE_STATUS_REQUEST_TIMEOUT_MS,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    const applied = applyLatestStatus(records);
    const metricsChanged = applied.touchedMetrics.length > 0;
    const trafficTrendsChanged = applied.touchedTrafficTrends.length > 0;
    const storeStatusChanged = state.failureStreak > 0;

    if (metricsChanged || trafficTrendsChanged || storeStatusChanged) {
      commit(
        {
          ...state,
          metricsByUuid: metricsChanged ? applied.nextMetricsByUuid : state.metricsByUuid,
          trafficTrends:
            trafficTrendsChanged ? applied.nextTrafficTrends : state.trafficTrends,
          failureStreak: 0,
        },
        {
          metrics: applied.touchedMetrics,
          trafficTrends: applied.touchedTrafficTrends,
          storeStatus: storeStatusChanged,
        },
      );
    }
  } catch {
    if (controller.signal.aborted) return;
    commit(
      {
        ...state,
        failureStreak: state.failureStreak + 1,
      },
      { storeStatus: true },
    );
  } finally {
    if (liveStatusController === controller) liveStatusController = null;
    refreshInFlight = false;
  }
}

async function bootstrap() {
  try {
    await syncNodeInfo();
    await refreshLatestStatus();
  } catch {
    // 下一个调度 tick 再重试。
  }
}

let started = false;
let retainCount = 0;
let stopTimer: number | null = null;
let liveStatusTimer: number | null = null;
let nodeInfoTimer: number | null = null;

// ─── Page Visibility + 空闲降频 ─────────────────────────────────────────────
let pageHidden = typeof document !== "undefined" && document.hidden;
let lastInteractionTime = Date.now();
let idleTrackingStarted = false;

function isUserIdle(): boolean {
  return Date.now() - lastInteractionTime > IDLE_THRESHOLD_MS;
}

function markUserInteraction() {
  lastInteractionTime = Date.now();
}

function ensureIdleTrackingStarted() {
  if (idleTrackingStarted) return;
  idleTrackingStarted = true;
  const opts: AddEventListenerOptions = { passive: true, capture: true };
  document.addEventListener("pointermove", markUserInteraction, opts);
  document.addEventListener("pointerdown", markUserInteraction, opts);
  document.addEventListener("keydown", markUserInteraction, opts);
  document.addEventListener("wheel", markUserInteraction, opts);
  document.addEventListener("touchstart", markUserInteraction, opts);
}

function stopIdleTracking() {
  if (!idleTrackingStarted) return;
  idleTrackingStarted = false;
  document.removeEventListener("pointermove", markUserInteraction, true);
  document.removeEventListener("pointerdown", markUserInteraction, true);
  document.removeEventListener("keydown", markUserInteraction, true);
  document.removeEventListener("wheel", markUserInteraction, true);
  document.removeEventListener("touchstart", markUserInteraction, true);
}

function getEffectiveLiveInterval(): number {
  return isUserIdle() ? IDLE_REFRESH_INTERVAL_MS : LIVE_STATUS_REFRESH_INTERVAL_MS;
}

function getEffectiveNodeInfoInterval(): number {
  return isUserIdle() ? IDLE_NODE_INFO_INTERVAL_MS : NODE_INFO_REFRESH_INTERVAL_MS;
}

function scheduleLiveStatusTick() {
  if (liveStatusTimer != null) return;
  if (pageHidden) return;
  liveStatusTimer = window.setTimeout(() => {
    liveStatusTimer = null;
    if (pageHidden || !started) return;
    if (!hydrated) {
      void bootstrap();
    } else if (!wsIsFresh()) {
      // WS 通道健康时跳过 RPC 轮询（WS 已提供全量实时数据含 GPU）。
      void refreshLatestStatus();
    }
    scheduleLiveStatusTick();
  }, getEffectiveLiveInterval());
}

function scheduleNodeInfoTick() {
  if (nodeInfoTimer != null) return;
  if (pageHidden) return;
  nodeInfoTimer = window.setTimeout(() => {
    nodeInfoTimer = null;
    if (pageHidden || !started) return;
    void syncNodeInfo().catch(() => {});
    scheduleNodeInfoTick();
  }, getEffectiveNodeInfoInterval());
}

function handleVisibilityChange() {
  const hidden = document.hidden;
  if (hidden === pageHidden) return;
  pageHidden = hidden;

  if (hidden) {
    // 页面隐藏：停止调度，节省后台开销。
    if (liveStatusTimer != null) {
      window.clearTimeout(liveStatusTimer);
      liveStatusTimer = null;
    }
    if (nodeInfoTimer != null) {
      window.clearTimeout(nodeInfoTimer);
      nodeInfoTimer = null;
    }
    stopWsConnection();
  } else {
    // 页面恢复可见：立即刷新一次，然后恢复正常调度。
    markUserInteraction();
    if (started) {
      if (!hydrated) {
        void bootstrap();
      } else {
        void refreshLatestStatus();
      }
      startWsConnection();
      scheduleLiveStatusTick();
      scheduleNodeInfoTick();
    }
  }
}

function ensureStarted() {
  if (started) return;
  started = true;

  ensureScrollTrackingStarted();
  ensureIdleTrackingStarted();
  document.addEventListener("visibilitychange", handleVisibilityChange);
  pageHidden = document.hidden;
  lastInteractionTime = Date.now();

  void bootstrap();
  startWsConnection();
  // 实时指标与节点信息使用自适应调度（感知 visibility + 空闲状态）。
  scheduleLiveStatusTick();
  scheduleNodeInfoTick();
}

export function retainStore() {
  if (stopTimer != null) {
    window.clearTimeout(stopTimer);
    stopTimer = null;
  }
  retainCount += 1;
  ensureStarted();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    retainCount = Math.max(0, retainCount - 1);
    if (retainCount === 0 && stopTimer == null) {
      stopTimer = window.setTimeout(() => {
        stopTimer = null;
        if (retainCount === 0) stopStore();
      }, 0);
    }
  };
}

function stopStore() {
  if (stopTimer != null) {
    window.clearTimeout(stopTimer);
    stopTimer = null;
  }
  liveStatusController?.abort();
  liveStatusController = null;
  nodeInfoController?.abort();
  nodeInfoController = null;
  stopWsConnection();
  wsLastMessageAt = 0;
  if (liveStatusTimer != null) {
    window.clearTimeout(liveStatusTimer);
    liveStatusTimer = null;
  }
  if (nodeInfoTimer != null) {
    window.clearTimeout(nodeInfoTimer);
    nodeInfoTimer = null;
  }
  if (scrollIdleTimer != null) {
    window.clearTimeout(scrollIdleTimer);
    scrollIdleTimer = null;
  }
  if (scrollTrackingStarted) {
    window.removeEventListener("scroll", markScrollActivity);
    scrollTrackingStarted = false;
  }
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  stopIdleTracking();
  scrollActive = false;
  refreshDeferredWhileScrolling = false;
  hydrated = false;
  nodeInfoError = false;
  started = false;
}

function subscribeSet(listeners: Set<Listener>, listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeVisibleNodeUuids(listener: Listener): () => void {
  return subscribeSet(visibleNodeListeners, listener);
}

export function subscribeAllNodes(listener: Listener): () => void {
  return subscribeSet(allNodesListeners, listener);
}

export function subscribeHomeNodeSummaries(listener: Listener): () => void {
  return subscribeSet(homeNodeSummaryListeners, listener);
}

export function subscribeStoreStatus(listener: Listener): () => void {
  return subscribeSet(storeStatusListeners, listener);
}

export function subscribeToNodeMeta(uuid: string, listener: Listener): () => void {
  return subscribeByKey(nodeMetaListeners, uuid, listener);
}

export function subscribeToNodeMetrics(uuid: string, listener: Listener): () => void {
  return subscribeByKey(nodeMetricsListeners, uuid, listener);
}

export function subscribeToNodeTrafficTrend(uuid: string, listener: Listener): () => void {
  return subscribeByKey(trafficTrendListeners, uuid, listener);
}

function subscribeByKey(
  listenersByKey: Map<string, Set<Listener>>,
  key: string,
  listener: Listener,
): () => void {
  let listeners = listenersByKey.get(key);
  if (!listeners) {
    listeners = new Set();
    listenersByKey.set(key, listeners);
  }
  listeners.add(listener);

  return () => {
    listeners?.delete(listener);
    if (listeners && listeners.size === 0) {
      listenersByKey.delete(key);
    }
  };
}

export function getStoreStatusSnapshot(): StoreStatusSnapshot {
  if (
    storeStatusSnapshot.failureStreak === state.failureStreak &&
    storeStatusSnapshot.hydrated === hydrated &&
    storeStatusSnapshot.nodeInfoError === nodeInfoError
  ) {
    return storeStatusSnapshot;
  }
  storeStatusSnapshot = {
    failureStreak: state.failureStreak,
    hydrated,
    nodeInfoError,
  };
  return storeStatusSnapshot;
}

export function getNodeMetaSnapshot(uuid: string): NodeInfo | undefined {
  return state.metaByUuid[uuid];
}

export function getNodeMetricsSnapshot(uuid: string): NodeMetrics | undefined {
  return state.metricsByUuid[uuid];
}

export function getNodeTrafficTrendSnapshot(uuid: string): {
  up: TrafficTrendSample[];
  down: TrafficTrendSample[];
} {
  const trend = state.trafficTrends[uuid] ?? EMPTY_TRAFFIC_TREND;
  return trend.snapshot;
}

export function getVisibleNodeUuidsSnapshot(includeHidden = false): string[] {
  if (includeHidden) {
    if (visibleNodeUuidsWithHiddenSnapshotVersion === storeVersion) {
      return visibleNodeUuidsWithHiddenSnapshot;
    }
  } else if (visibleNodeUuidsSnapshotVersion === storeVersion) {
    return visibleNodeUuidsSnapshot;
  }

  const next = state.order.filter((uuid) => {
    const node = state.metaByUuid[uuid];
    return Boolean(node) && (includeHidden || !node.hidden);
  });

  const previous = includeHidden
    ? visibleNodeUuidsWithHiddenSnapshot
    : visibleNodeUuidsSnapshot;
  const value =
    next.length === previous.length && next.every((uuid, index) => uuid === previous[index])
      ? previous
      : next;

  if (includeHidden) {
    visibleNodeUuidsWithHiddenSnapshot = value;
    visibleNodeUuidsWithHiddenSnapshotVersion = storeVersion;
  } else {
    visibleNodeUuidsSnapshot = value;
    visibleNodeUuidsSnapshotVersion = storeVersion;
  }
  return value;
}

export function getAllNodeMetaSnapshot(): NodeInfo[] {
  if (allNodeMetaSnapshotVersion === storeVersion) return allNodeMetaSnapshot;

  const next = state.order
    .map((uuid) => state.metaByUuid[uuid])
    .filter((node): node is NodeInfo => Boolean(node));

  if (
    !(
      next.length === allNodeMetaSnapshot.length &&
      next.every((node, index) => node === allNodeMetaSnapshot[index])
    )
  ) {
    allNodeMetaSnapshot = next;
  }
  allNodeMetaSnapshotVersion = storeVersion;
  return allNodeMetaSnapshot;
}

export function getHomeNodeSummariesSnapshot(): HomeNodeSummary[] {
  if (homeNodeSummariesSnapshotVersion === storeVersion) return homeNodeSummariesSnapshot;

  // 增量更新：只对字段真正变化的节点创建新对象，其余复用上一轮引用。
  // 这让每 tick 的对象分配从 O(N) 降到 O(changed)，减轻 GC 压力。
  const prevByUuid = new Map<string, HomeNodeSummary>();
  for (const item of homeNodeSummariesSnapshot) {
    prevByUuid.set(item.uuid, item);
  }

  let anyChanged =
    state.order.length !== homeNodeSummariesSnapshot.length;
  const next: HomeNodeSummary[] = [];

  for (const uuid of state.order) {
    const meta = state.metaByUuid[uuid];
    if (!meta) continue;
    const metrics = state.metricsByUuid[uuid];
    const prev = prevByUuid.get(uuid);

    const group = String(meta.group || "").trim();
    const region = String(meta.region || "").trim();
    const hidden = meta.hidden;
    const weight = meta.weight;
    const online = metrics?.online ?? null;
    const trafficUp = metrics?.trafficUp ?? 0;
    const trafficDown = metrics?.trafficDown ?? 0;
    const netUp = metrics?.netUp ?? 0;
    const netDown = metrics?.netDown ?? 0;
    const connectionsTcp = metrics?.connectionsTcp ?? 0;
    const connectionsUdp = metrics?.connectionsUdp ?? 0;

    if (
      prev &&
      prev.group === group &&
      prev.region === region &&
      prev.hidden === hidden &&
      prev.weight === weight &&
      prev.online === online &&
      prev.trafficUp === trafficUp &&
      prev.trafficDown === trafficDown &&
      prev.netUp === netUp &&
      prev.netDown === netDown &&
      prev.connectionsTcp === connectionsTcp &&
      prev.connectionsUdp === connectionsUdp
    ) {
      next.push(prev);
    } else {
      anyChanged = true;
      next.push({
        uuid,
        group,
        region,
        hidden,
        weight,
        online,
        trafficUp,
        trafficDown,
        netUp,
        netDown,
        connectionsTcp,
        connectionsUdp,
      });
    }
  }

  if (!anyChanged) {
    homeNodeSummariesSnapshotVersion = storeVersion;
    return homeNodeSummariesSnapshot;
  }

  homeNodeSummariesSnapshot = next;
  homeNodeSummariesSnapshotVersion = storeVersion;
  return homeNodeSummariesSnapshot;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopStore();
  });
}
