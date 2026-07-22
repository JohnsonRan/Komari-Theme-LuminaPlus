import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useAllNodeMeta, useVisibleNodeUuids } from "@/hooks/useNode";
import { useThemeSettings } from "@/hooks/useThemeSettings";
import { getPingOverview } from "@/services/api";
import { setPingBindingResolver } from "@/services/wsStore";
import type {
  PingOverviewBucket,
  PingOverviewItem,
  PingRecord,
  PingTaskStats,
} from "@/types/komari";
import { withTimeoutSignal } from "@/utils/abort";
import { collectMatchingNodeUuids } from "@/utils/nodeIdentity";
import { resolvePingSampleCounts } from "@/utils/pingMetrics";
import {
  invertHomepagePingTaskBindings,
  type HomepagePingTaskBindings,
} from "@/utils/pingTasks";

const DEFAULT_PING_REFRESH_INTERVAL = 120_000;
const MIN_PING_REFRESH_INTERVAL = 30_000;
const MAX_PING_REFRESH_INTERVAL = 300_000;
// 首页延迟图表最多显示 24 个 bucket。metric API 返回的是聚合区间而不是瞬时点，
// 绘制时要把较粗的后端区间投影到它覆盖的可视 bucket，同时保持卡片密度一致。
const MAX_VISIBLE_HOMEPAGE_PING_BUCKETS = 24;

const EMPTY_PING: PingOverviewItem = {
  client: "",
  isAssigned: false,
  lastValue: null,
  samples: [],
  max: 1,
  loss: null,
};

interface PingOverviewMapResult {
  assignmentKey: string;
  intervalMs: number;
  items: Map<string, PingOverviewItem>;
}

type Listener = () => void;

function toTimestamp(value: string | number) {
  if (typeof value === "number") {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizeRefreshInterval(seconds: number | null | undefined) {
  if (!Number.isFinite(seconds) || !seconds || seconds <= 0) {
    return DEFAULT_PING_REFRESH_INTERVAL;
  }

  return Math.min(
    MAX_PING_REFRESH_INTERVAL,
    Math.max(MIN_PING_REFRESH_INTERVAL, seconds * 1000),
  );
}

function normalizeVisibleUuids(uuids: string[]) {
  return Array.from(new Set(uuids.filter(Boolean))).sort((left, right) =>
    left.localeCompare(right),
  );
}

function stringifyBindings(bindings: HomepagePingTaskBindings) {
  return JSON.stringify(
    Object.entries(bindings)
      .map(([taskId, clients]) => [taskId, [...clients].sort((left, right) => left.localeCompare(right))])
      .sort(([left], [right]) => Number(left) - Number(right)),
  );
}

function equalSamples(
  a: PingOverviewItem["samples"],
  b: PingOverviewItem["samples"],
) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i]?.time !== b[i]?.time ||
      a[i]?.value !== b[i]?.value ||
      a[i]?.count !== b[i]?.count ||
      a[i]?.loss !== b[i]?.loss
    ) {
      return false;
    }
  }
  return true;
}

function equalPingItem(a: PingOverviewItem | undefined, b: PingOverviewItem | undefined) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.client === b.client &&
    a.isAssigned === b.isAssigned &&
    a.lastValue === b.lastValue &&
    a.metricIntervalMs === b.metricIntervalMs &&
    a.max === b.max &&
    a.loss === b.loss &&
    equalSamples(a.samples, b.samples)
  );
}

export function buildPingOverviewItems(
  taskId: number,
  records: PingRecord[],
  metricStats: PingTaskStats[] = [],
  metricIntervalSeconds?: number,
) {
  const metricIntervalMs =
    typeof metricIntervalSeconds === "number" &&
    Number.isFinite(metricIntervalSeconds) &&
    metricIntervalSeconds > 0
      ? metricIntervalSeconds * 1000
      : undefined;
  const selectedRecords = records.filter((record) => record.task_id === taskId);
  const grouped = new Map<string, Array<(typeof selectedRecords)[number]>>();
  const lossStatsByClient = new Map<string, { total: number; lost: number }>();

  for (const record of selectedRecords) {
    if (!record.client) continue;
    const current = grouped.get(record.client);
    if (current) current.push(record);
    else grouped.set(record.client, [record]);

    const stats = lossStatsByClient.get(record.client) ?? { total: 0, lost: 0 };
    const counts = resolvePingSampleCounts(record);
    stats.total += counts.total;
    stats.lost += counts.lost;
    lossStatsByClient.set(record.client, stats);
  }

  const result = new Map<string, PingOverviewItem>();
  const statsByClient = new Map(
    metricStats
      .filter((stat) => stat.taskId === taskId)
      .map((stat) => [stat.client, stat] as const),
  );
  const clients = new Set([...grouped.keys(), ...statsByClient.keys()]);

  for (const client of clients) {
    const clientRecords = grouped.get(client) ?? [];
    const sorted = [...clientRecords].sort(
      (left, right) => toTimestamp(left.time) - toTimestamp(right.time),
    );
    const latestRecord = sorted[sorted.length - 1];
    const samples: PingOverviewItem["samples"] = [];
    let max = 1;

    for (let i = 0; i < sorted.length; i++) {
      const record = sorted[i];
      const value = record.value;
      const time = toTimestamp(record.time);
      if (time > 0) {
        samples.push({
          time,
          value,
          count: "count" in record && typeof record.count === "number" ? record.count : undefined,
          loss: "loss" in record && typeof record.loss === "number" ? record.loss : undefined,
        });
      }
      if (value > max) {
        max = value;
      }
    }

    const lossStats = lossStatsByClient.get(client);
    const serverStats = statsByClient.get(client);
    result.set(client, {
      client,
      isAssigned: true,
      lastValue:
        serverStats?.latest ??
        (latestRecord && latestRecord.value >= 0 ? latestRecord.value : null),
      metricIntervalMs,
      samples,
      max: serverStats?.max ?? max,
      loss:
        serverStats?.loss ??
        (lossStats?.total ? (lossStats.lost / lossStats.total) * 100 : null),
    });
  }

  return result;
}

function resolveSelectedTasks(
  clientUuids: string[],
  bindings: HomepagePingTaskBindings,
) {
  const selectedTaskByClient = new Map<string, number>();
  const bindingSelection = invertHomepagePingTaskBindings(bindings);

  for (const uuid of clientUuids) {
    const taskId = bindingSelection.get(uuid);
    if (taskId != null) {
      selectedTaskByClient.set(uuid, taskId);
    }
  }

  return selectedTaskByClient;
}

function buildAssignmentKey(selectedTaskByClient: Map<string, number>) {
  return Array.from(selectedTaskByClient.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([uuid, taskId]) => `${uuid}:${taskId}`)
    .join("|");
}

// 限制 RPC 与兼容接口组成的整条回退链，避免一次刷新长期占住轮询。
const PING_REQUEST_TIMEOUT_MS = 35_000;

interface PreviousPingOverview {
  assignmentKey: string;
  items: ReadonlyMap<string, PingOverviewItem>;
}

function assignedEmptyPing(client: string): PingOverviewItem {
  return {
    client,
    isAssigned: true,
    lastValue: null,
    samples: [],
    max: 1,
    loss: null,
  };
}

async function buildOverviewMap(
  hours: number,
  clientUuids: string[],
  bindings: HomepagePingTaskBindings,
  signal?: AbortSignal,
  previous?: PreviousPingOverview,
): Promise<PingOverviewMapResult> {
  const normalizedUuids = normalizeVisibleUuids(clientUuids);
  if (normalizedUuids.length === 0) {
    return {
      assignmentKey: "",
      intervalMs: DEFAULT_PING_REFRESH_INTERVAL,
      items: new Map<string, PingOverviewItem>(),
    };
  }

  const selectedTaskByClient = resolveSelectedTasks(normalizedUuids, bindings);
  const selectedTaskIds = Array.from(new Set(selectedTaskByClient.values())).sort(
    (left, right) => left - right,
  );
  const assignmentKey = buildAssignmentKey(selectedTaskByClient);

  if (selectedTaskIds.length === 0) {
    return {
      assignmentKey: "",
      intervalMs: DEFAULT_PING_REFRESH_INTERVAL,
      items: new Map<string, PingOverviewItem>(),
    };
  }

  const overviewResults = await Promise.allSettled(
    selectedTaskIds.map((taskId) =>
      withTimeoutSignal(
        async (requestSignal) => {
          const entityIds = normalizedUuids.filter(
            (uuid) => selectedTaskByClient.get(uuid) === taskId,
          );
          return {
            taskId,
            overview: await getPingOverview(hours, taskId, {
              signal: requestSignal,
              entityIds,
            }),
          };
        },
        PING_REQUEST_TIMEOUT_MS,
        signal,
      ),
    ),
  );

  const itemsByTask = new Map<number, Map<string, PingOverviewItem>>();
  const successfulTaskIds = new Set<number>();
  const refreshIntervals: number[] = [];

  for (const result of overviewResults) {
    if (result.status !== "fulfilled") {
      continue;
    }

    const {
      taskId,
      overview: { records, tasks, stats, intervalSeconds },
    } = result.value;
    successfulTaskIds.add(taskId);
    itemsByTask.set(
      taskId,
      buildPingOverviewItems(taskId, records, stats, intervalSeconds),
    );

    const taskInterval = tasks.find((task) => task.id === taskId)?.interval;
    refreshIntervals.push(normalizeRefreshInterval(taskInterval));
  }

  const items = new Map<string, PingOverviewItem>();
  for (const [uuid, taskId] of selectedTaskByClient) {
    if (!successfulTaskIds.has(taskId)) {
      const previousItem =
        previous?.assignmentKey === assignmentKey ? previous.items.get(uuid) : undefined;
      items.set(uuid, previousItem ?? assignedEmptyPing(uuid));
      continue;
    }
    const item = itemsByTask.get(taskId)?.get(uuid);
    if (item) {
      items.set(uuid, item);
      continue;
    }
    items.set(uuid, assignedEmptyPing(uuid));
  }

  return {
    assignmentKey,
    intervalMs:
      refreshIntervals.length > 0
        ? Math.min(...refreshIntervals)
        : DEFAULT_PING_REFRESH_INTERVAL,
    items,
  };
}

interface PingOverviewStoreState {
  assignmentKey: string;
  intervalMs: number;
  items: Map<string, PingOverviewItem>;
}

let pingOverviewState: PingOverviewStoreState = {
  assignmentKey: "",
  intervalMs: DEFAULT_PING_REFRESH_INTERVAL,
  items: new Map(),
};
let scheduledVisibleUuids: string[] = [];
let scheduledVisibleKey = "";
let scheduledBindings: HomepagePingTaskBindings = {};
let scheduledBindingsKey = stringifyBindings({});
let pingRefreshInFlight = false;
let pingRefreshTimer: number | null = null;
let pingAbortController: AbortController | null = null;
let activeConsumers = 0;
const pingListeners = new Map<string, Set<Listener>>();

function schedulePingRefresh(intervalMs: number) {
  if (pingRefreshTimer != null) {
    window.clearTimeout(pingRefreshTimer);
    pingRefreshTimer = null;
  }
  // 没有组件消费 overview 时就停止轮询。等有消费者再次挂载时，
  // 由 ensurePingOverviewStarted 重新启动整条链路。
  if (activeConsumers <= 0) return;
  pingRefreshTimer = window.setTimeout(() => {
    pingRefreshTimer = null;
    void refreshPingOverview();
  }, intervalMs);
}

function stopPingPolling() {
  if (pingRefreshTimer != null) {
    window.clearTimeout(pingRefreshTimer);
    pingRefreshTimer = null;
  }
  // 中止进行中的 refresh（如果有），让它的请求和带宽在 teardown 时立刻释放；
  // refreshPingOverview 会把已 abort 的 signal 当成非当前，跳过 commit/重新调度。
  if (pingAbortController) {
    pingAbortController.abort();
    pingAbortController = null;
  }
}

function commitPingOverview(
  assignmentKey: string,
  intervalMs: number,
  items: Map<string, PingOverviewItem>,
) {
  const prevItems = pingOverviewState.items;
  const nextItems = new Map<string, PingOverviewItem>();
  const touched = new Set<string>();
  const keys = new Set<string>([...prevItems.keys(), ...items.keys()]);

  for (const key of keys) {
    const prev = prevItems.get(key);
    const next = items.get(key);

    if (!next) {
      // buildOverviewMap 对每个被选中的 client 都会产出占位项，所以一个 key 缺失只可能是该
      // client 离开了选择集（assignmentKey 必然随之改变）。直接丢弃旧条目并通知订阅者。
      if (prev) touched.add(key);
      continue;
    }

    if (equalPingItem(prev, next)) {
      nextItems.set(key, prev ?? next);
      continue;
    }

    nextItems.set(key, next);
    touched.add(key);
  }

  if (
    pingOverviewState.assignmentKey === assignmentKey &&
    pingOverviewState.intervalMs === intervalMs &&
    touched.size === 0 &&
    nextItems.size === prevItems.size
  ) {
    return;
  }

  pingOverviewState = {
    assignmentKey,
    intervalMs,
    items: nextItems,
  };

  for (const key of touched) {
    const listeners = pingListeners.get(key);
    if (!listeners) continue;
    for (const listener of listeners) listener();
  }
}

async function refreshPingOverview() {
  if (pingRefreshInFlight) return;

  pingRefreshInFlight = true;
  const visibleKey = scheduledVisibleKey;
  const bindingsKey = scheduledBindingsKey;
  const controller = new AbortController();
  pingAbortController = controller;
  const { signal } = controller;
  // 判断当前请求是否仍然有效（没被 stopPingPolling 中止，
  // 且 visible/binding 分配在执行期间没有被改掉）。
  const isCurrent = () =>
    !signal.aborted &&
    visibleKey === scheduledVisibleKey &&
    bindingsKey === scheduledBindingsKey;

  try {
    if (scheduledVisibleUuids.length === 0) {
      commitPingOverview("", DEFAULT_PING_REFRESH_INTERVAL, new Map());
      return;
    }

    const next = await buildOverviewMap(
      1,
      scheduledVisibleUuids,
      scheduledBindings,
      signal,
      pingOverviewState,
    );
    if (isCurrent()) {
      commitPingOverview(next.assignmentKey, next.intervalMs, next.items);
      schedulePingRefresh(next.intervalMs);
    }
  } catch {
    if (isCurrent()) {
      schedulePingRefresh(DEFAULT_PING_REFRESH_INTERVAL);
    }
  } finally {
    pingRefreshInFlight = false;
    if (pingAbortController === controller) pingAbortController = null;
    // 只要消费者还想轮询但队列里没有任务，就恢复轮询。这覆盖了执行中途 assignment
    // 变化（上面那次跑会跳过 commit）以及 abort/重新挂载竞态（如 StrictMode:
    // mount→stop(abort)→mount），后者里被 abort 的那次不能负责重新调度。成功或失败
    // 的一次已经设过 timer，所以稳态下这里是 no-op。
    if (
      activeConsumers > 0 &&
      scheduledVisibleUuids.length > 0 &&
      pingRefreshTimer == null
    ) {
      void refreshPingOverview();
    }
  }
}

function ensurePingOverviewStarted(
  visibleUuids: string[],
  bindings: HomepagePingTaskBindings,
) {
  const normalizedVisibleUuids = normalizeVisibleUuids(visibleUuids);
  const visibleKey = normalizedVisibleUuids.join("|");
  const bindingsKey = stringifyBindings(bindings);

  if (
    scheduledVisibleKey !== visibleKey ||
    scheduledBindingsKey !== bindingsKey
  ) {
    scheduledVisibleUuids = normalizedVisibleUuids;
    scheduledVisibleKey = visibleKey;
    scheduledBindings = bindings;
    scheduledBindingsKey = bindingsKey;

    pingAbortController?.abort();

    if (pingRefreshTimer != null) {
      window.clearTimeout(pingRefreshTimer);
      pingRefreshTimer = null;
    }
    void refreshPingOverview();
    return;
  }

  // 只要没有待处理请求、也没有已调度的 tick 就重启——这同时覆盖首次挂载
  // 和轮询被停止后的恢复。
  if (
    normalizedVisibleUuids.length > 0 &&
    !pingRefreshInFlight &&
    pingRefreshTimer == null
  ) {
    void refreshPingOverview();
  }
}

function subscribeToPingItem(uuid: string, listener: Listener) {
  let listeners = pingListeners.get(uuid);
  if (!listeners) {
    listeners = new Set();
    pingListeners.set(uuid, listeners);
  }
  listeners.add(listener);

  return () => {
    listeners?.delete(listener);
    if (listeners && listeners.size === 0) {
      pingListeners.delete(uuid);
    }
  };
}

function getPingSnapshot(uuid: string) {
  return pingOverviewState.items.get(uuid) ?? EMPTY_PING;
}

export function useHomepagePingOverview() {
  const { data: me } = useAuth();
  const visibleUuids = useVisibleNodeUuids(me?.logged_in === true);
  const allMeta = useAllNodeMeta();
  const themeSettings = useThemeSettings();

  // 主题级隐藏节点首页已不渲染,这里也从 overview 拉取里剔除——否则仍会为其绑定的
  // ping 任务发请求、做聚合,纯属无效网络/计算开销。名称匹配需要完整 meta。
  const hiddenUuids = useMemo(
    () => collectMatchingNodeUuids(allMeta, themeSettings.hiddenNodes),
    [allMeta, themeSettings.hiddenNodes],
  );
  const effectiveUuids = useMemo(
    () =>
      hiddenUuids.size > 0
        ? visibleUuids.filter((uuid) => !hiddenUuids.has(uuid))
        : visibleUuids,
    [visibleUuids, hiddenUuids],
  );

  useEffect(() => {
    if (!themeSettings.isReady) return;
    activeConsumers += 1;
    ensurePingOverviewStarted(effectiveUuids, themeSettings.homepagePingBindings);
    return () => {
      activeConsumers -= 1;
      if (activeConsumers <= 0) {
        activeConsumers = 0;
        stopPingPolling();
      }
    };
  }, [themeSettings.homepagePingBindings, themeSettings.isReady, effectiveUuids]);

  // 向 wsStore 注册 ping 绑定解析器，让内嵌 ping 数据能按绑定任务提取正确的延迟/丢包。
  const invertedBindings = useMemo(
    () => invertHomepagePingTaskBindings(themeSettings.homepagePingBindings),
    [themeSettings.homepagePingBindings],
  );
  useEffect(() => {
    if (!themeSettings.isReady) return;
    const resolver = (uuid: string) => {
      const taskId = invertedBindings.get(uuid);
      return taskId != null ? String(taskId) : undefined;
    };
    setPingBindingResolver(resolver);
    return () => setPingBindingResolver(null);
  }, [invertedBindings, themeSettings.isReady]);
}

export function useNodePingOverview(uuid: string): PingOverviewItem {
  const subscribe = useCallback(
    (cb: Listener) => (uuid ? subscribeToPingItem(uuid, cb) : () => undefined),
    [uuid],
  );
  const getSnapshot = useCallback(
    () => (uuid ? getPingSnapshot(uuid) : EMPTY_PING),
    [uuid],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function buildPingBuckets(
  ping: Pick<PingOverviewItem, "samples" | "metricIntervalMs">,
  count?: number,
  now = Date.now(),
): PingOverviewBucket[] {
  const totalWindowMs = 60 * 60 * 1000;
  const requestedCount = count ?? MAX_VISIBLE_HOMEPAGE_PING_BUCKETS;
  const boundedRequestedCount =
    Number.isFinite(requestedCount) && requestedCount > 0
      ? Math.min(240, Math.max(1, Math.round(requestedCount)))
      : MAX_VISIBLE_HOMEPAGE_PING_BUCKETS;
  const metricIntervalMs =
    typeof ping.metricIntervalMs === "number" &&
    Number.isFinite(ping.metricIntervalMs) &&
    ping.metricIntervalMs > 0
      ? ping.metricIntervalMs
      : 0;
  const resolvedCount = boundedRequestedCount;
  const bucketMs = totalWindowMs / resolvedCount;
  const windowStart = now - totalWindowMs;
  const totals = new Array<number>(resolvedCount).fill(0);
  const losts = new Array<number>(resolvedCount).fill(0);
  const positiveSums = new Array<number>(resolvedCount).fill(0);
  const positiveCounts = new Array<number>(resolvedCount).fill(0);

  const addSampleToBucket = (
    bucketIndex: number,
    sample: PingOverviewItem["samples"][number],
  ) => {
    const { total: sampleCount, lost: sampleLost, valid: sampleValid } =
      resolvePingSampleCounts(sample);

    totals[bucketIndex] += sampleCount;
    losts[bucketIndex] += sampleLost;
    // 聚合点的 value 已由 metric 适配层恢复为“成功样本均值”，这里按 valid count
    // 加权；旧接口/模拟数据没有 count，仍等价于单样本累加。
    if (sample.value >= 0 && sampleValid > 0) {
      positiveSums[bucketIndex] += sample.value * sampleValid;
      positiveCounts[bucketIndex] += sampleValid;
    }
  };

  for (const sample of ping.samples ?? []) {
    if (metricIntervalMs > bucketMs) {
      const sampleEnd = sample.time + metricIntervalMs;
      if (sampleEnd <= windowStart || sample.time > now) continue;

      // 后端时间戳是聚合桶起点。以每个可视 bucket 的中点判断它属于哪个
      // 聚合区间，相当于对粗粒度数据做 sample-and-hold：不会制造规律性空洞，
      // 也不会因为减少 DOM 数量而让不同节点的柱宽不一致。
      for (let index = 0; index < resolvedCount; index += 1) {
        const midpoint = windowStart + (index + 0.5) * bucketMs;
        if (midpoint >= sample.time && midpoint < sampleEnd) {
          addSampleToBucket(index, sample);
        }
      }
      continue;
    }

    let sampleTime = sample.time;
    if (metricIntervalMs > 0) {
      const sampleEnd = sample.time + metricIntervalMs;
      if (sampleEnd <= windowStart || sample.time > now) continue;
      const overlapStart = Math.max(sample.time, windowStart);
      const overlapEnd = Math.min(sampleEnd, now);
      if (overlapEnd < overlapStart) continue;
      sampleTime = overlapStart + (overlapEnd - overlapStart) / 2;
    } else if (sample.time < windowStart || sample.time > now) {
      continue;
    }

    let bucketIndex = Math.floor((sampleTime - windowStart) / bucketMs);
    if (bucketIndex < 0) continue;
    if (bucketIndex >= resolvedCount) bucketIndex = resolvedCount - 1;
    addSampleToBucket(bucketIndex, sample);
  }

  return Array.from({ length: resolvedCount }, (_, index) => {
    const startAt = windowStart + index * bucketMs;
    const endAt = startAt + bucketMs;
    const total = totals[index];
    const lost = Math.round(losts[index]);
    const positiveCount = positiveCounts[index];

    return {
      index,
      value: positiveCount > 0 ? positiveSums[index] / positiveCount : null,
      loss: total > 0 ? (lost / total) * 100 : null,
      total,
      lost,
      startAt,
      endAt,
    };
  });
}

export function usePingBuckets(
  ping: Pick<PingOverviewItem, "samples" | "metricIntervalMs">,
  count?: number,
): PingOverviewBucket[] {
  const { samples, metricIntervalMs } = ping;
  return useMemo(
    () => buildPingBuckets({ samples, metricIntervalMs }, count),
    [count, metricIntervalMs, samples],
  );
}
