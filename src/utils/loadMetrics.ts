import type { LoadRecord } from "@/types/komari";

const LOAD_METRIC_FIELD = {
  "cpu.usage": "cpu",
  "gpu.usage": "gpu",
  "gpu.memory.used": "gpu_memory_used",
  "gpu.memory.total": "gpu_memory_total",
  "gpu.temperature": "gpu_temperature",
  "memory.used": "ram",
  "memory.total": "ram_total",
  "swap.used": "swap",
  "swap.total": "swap_total",
  "load.average": "load",
  "disk.used": "disk",
  "disk.total": "disk_total",
  "net.in.rate": "net_in",
  "net.out.rate": "net_out",
  "net.total.up": "net_total_up",
  "net.total.down": "net_total_down",
  "process.count": "process",
  "connections.tcp": "connections",
  "connections.udp": "connections_udp",
} as const satisfies Record<string, keyof LoadRecord>;

// memory.total / swap.total / disk.total 已被新版后端废弃（obsoleteBuiltinMetricNames），
// 其指标定义会在后端启动时被删除。queryMetrics 遇到未注册的 key 会直接拒绝整个请求，
// 导致包括 GPU 显存/温度在内的全部指标查询失败、回退到不含 GPU 显存/温度的旧 records
// 接口。因此查询时不能携带这些 key；记录 total 为 0 时调用方会回退到节点静态总量。
// 映射本身保留，旧版后端若仍返回这些序列也能正常解析。
const OBSOLETE_METRIC_KEYS = new Set(["memory.total", "swap.total", "disk.total"]);

export const LOAD_METRIC_KEYS = Object.keys(LOAD_METRIC_FIELD).filter(
  (key) => !OBSOLETE_METRIC_KEYS.has(key),
);

export const LOAD_LAST_AGGREGATION = {
  "gpu.memory.total": "last",
  "net.total.up": "last",
  "net.total.down": "last",
} as const;

export interface LoadMetricSeries {
  metricKey: string;
  client: string;
  intervalSeconds?: number;
  tags?: Record<string, string>;
  points: Array<{ time: string; value: number | null; count: number }>;
}

function emptyLoadRecord(client: string, time: string): LoadRecord {
  return {
    cpu: 0,
    gpu: 0,
    gpu_memory_used: 0,
    gpu_memory_total: 0,
    gpu_temperature: 0,
    ram: 0,
    ram_total: 0,
    swap: 0,
    swap_total: 0,
    load: 0,
    temp: 0,
    disk: 0,
    disk_total: 0,
    net_in: 0,
    net_out: 0,
    net_total_up: 0,
    net_total_down: 0,
    process: 0,
    connections: 0,
    connections_udp: 0,
    time,
    client,
  };
}

// GPU device 指标带 device_index tag，多 GPU 节点会返回多条同 key 序列，需要聚合。
const GPU_SUM_FIELDS = new Set(["gpu_memory_used", "gpu_memory_total"]);
const GPU_AVG_FIELDS = new Set(["gpu_temperature"]);

export function mergeLoadMetricSeries(series: LoadMetricSeries[]): LoadRecord[] {
  const records = new Map<string, LoadRecord>();
  // 用于 GPU device 指标聚合：key → field → timeKey → { sum, count }
  const gpuAccum = new Map<string, Map<string, { sum: number; count: number }>>();

  for (const item of series) {
    const field = LOAD_METRIC_FIELD[item.metricKey as keyof typeof LOAD_METRIC_FIELD];
    if (!field || !item.client) continue;
    const isGpuDevice = Boolean(item.tags?.device_index != null);

    for (const point of item.points) {
      if (point.count <= 0 || point.value == null || !Number.isFinite(point.value)) continue;
      const timeMs = Date.parse(point.time);
      if (!Number.isFinite(timeMs)) continue;
      const key = `${item.client}\u0000${timeMs}`;
      const record = records.get(key) ?? emptyLoadRecord(item.client, point.time);
      records.set(key, record);

      if (isGpuDevice && (GPU_SUM_FIELDS.has(field) || GPU_AVG_FIELDS.has(field))) {
        // 多 GPU 设备聚合
        let fieldMap = gpuAccum.get(key);
        if (!fieldMap) {
          fieldMap = new Map();
          gpuAccum.set(key, fieldMap);
        }
        const acc = fieldMap.get(field) ?? { sum: 0, count: 0 };
        acc.sum += point.value;
        acc.count += 1;
        fieldMap.set(field, acc);
      } else {
        record[field] = point.value;
      }
    }
  }

  // 应用 GPU 聚合结果
  for (const [key, fieldMap] of gpuAccum) {
    const record = records.get(key);
    if (!record) continue;
    const rec = record as unknown as Record<string, number>;
    for (const [field, acc] of fieldMap) {
      rec[field] = GPU_SUM_FIELDS.has(field)
        ? acc.sum
        : acc.count > 0 ? acc.sum / acc.count : 0;
    }
  }

  return [...records.values()].sort(
    (left, right) => Date.parse(String(left.time)) - Date.parse(String(right.time)),
  );
}
