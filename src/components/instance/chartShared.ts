import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type uPlot from "uplot";

// 共享的图表配色。LoadChart 按指标 (cpu/memory/…) 取色，PingChart 按 task 循环取色；
// 两者都取自这一处单一来源，避免 hex 值在两个图表间漂移。
export const CHART_PALETTE = {
  cpu: "#5d88ff",
  memory: "#a35cf5",
  disk: "#f1873d",
  success: "#61c08f",
  warning: "#d4a54a",
} as const;

// 备用定性色板（仅缺少总数时用）；正常走下面的 OKLCH 生成。
const CHART_SERIES_COLORS = [
  "#4878d0", // 蓝
  "#ee854a", // 橙
  "#6acc64", // 绿
  "#d65f5f", // 红
  "#956cb4", // 紫
  "#8c613c", // 棕
  "#dc7ec0", // 粉
  "#4aa7a0", // 青
  "#c7b446", // 芥黄
  "#82c6e2", // 浅蓝
] as const;

let oklchSupported: boolean | null = null;
function supportsOklch(): boolean {
  if (oklchSupported === null) {
    oklchSupported =
      typeof window !== "undefined" &&
      typeof window.CSS !== "undefined" &&
      typeof window.CSS.supports === "function" &&
      window.CSS.supports("color", "oklch(0.7 0.2 120 / 0.85)");
  }
  return oklchSupported;
}

export function colorForSeries(index: number, total?: number): string {
  // 没有总数时（防御性调用）退回精选板。
  if (typeof total !== "number" || total <= 0) {
    return CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length];
  }
  // 色相按总数均分，用 OKLCH 渲染：固定明度让每条线一样亮、中等彩度不刺眼、0.85 透明度让密集区
  // 混色不互相盖死；不支持则降级 HSL。
  const hue = Math.round((index * 360) / total);
  return supportsOklch()
    ? `oklch(0.7 0.2 ${hue} / 0.95)`
    : `hsl(${hue}, 50%, 60%)`;
}

// uPlot 图表的坐标轴网格/文字颜色。单一来源，避免 LoadChart 和 PingChart 在 dark/light 字面量上漂移。
export function getAxisColors(isDark: boolean): { grid: string; text: string } {
  return {
    grid: isDark ? "rgba(255,255,255,0.065)" : "rgba(0,0,0,0.08)",
    text: isDark ? "#a5a5aa" : "#52525b",
  };
}

// uPlot 图表 (LoadChart / PingChart) 共享的悬停 tooltip 状态结构。
export interface ChartTooltipState {
  show: boolean;
  left: number;
  top: number;
  rows: Array<{ label: string; value: string; color: string }>;
  time: string;
}

interface TimeRangeOption {
  label: string;
  value: number;
}

// load 和 ping 共用同一套历史区间预设；唯一区别是是否在前面加 "实时" 选项，这由
// buildHistoryRangeOptions 的 includeRealtime 标志处理，而非改预设列表本身。
const TIME_RANGE_OPTIONS: TimeRangeOption[] = [
  { label: "1 小时", value: 1 },
  { label: "4 小时", value: 4 },
  { label: "1 天", value: 24 },
  { label: "7 天", value: 168 },
  { label: "30 天", value: 720 },
];

// Ping 详情只保留高分辨率仍有观察价值的四档。metric store 虽可保留更久，
// 但 30/90 天会退化到小时级 rollup，不再放进详情页快捷范围。
const PING_TIME_RANGE_OPTIONS: TimeRangeOption[] = TIME_RANGE_OPTIONS.filter(
  (option) => option.value <= 168,
);

function formatRangeLabel(hours: number) {
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `${days} 天`;
  }

  return `${hours} 小时`;
}

function buildHistoryRangeOptions(
  presets: TimeRangeOption[],
  maxHours: number | null | undefined,
  includeRealtime: boolean,
) {
  const options = includeRealtime ? [{ label: "实时", value: 0 }] : [];
  if (!Number.isFinite(maxHours) || !maxHours || maxHours <= 0) {
    return [...options, ...presets];
  }

  const safeMaxHours = Math.floor(maxHours);
  const resolved = presets.filter((option) => option.value <= safeMaxHours);
  const hasExactMatch = resolved.some((option) => option.value === safeMaxHours);
  const largestPreset = presets[presets.length - 1]?.value ?? 0;

  // 保留时间大于前端最长快捷档时，不再把它动态追加成 90 天等超长按钮。
  // 小于最长档的非标准保留时间仍会显示，避免让用户选到后端已清理的数据范围。
  if (safeMaxHours > 0 && safeMaxHours < largestPreset && !hasExactMatch) {
    resolved.push({
      label: formatRangeLabel(safeMaxHours),
      value: safeMaxHours,
    });
  }

  return [...options, ...resolved];
}

export function buildLoadTimeRangeOptions(maxHours: number | null | undefined) {
  return buildHistoryRangeOptions(TIME_RANGE_OPTIONS, maxHours, true);
}

export function buildPingTimeRangeOptions(maxHours: number | null | undefined) {
  if (!Number.isFinite(maxHours) || !maxHours || maxHours <= 0) {
    return [...PING_TIME_RANGE_OPTIONS];
  }
  const safeMaxHours = Math.floor(maxHours);
  return PING_TIME_RANGE_OPTIONS.filter((option) => option.value <= safeMaxHours);
}

const GRID_CHART_DEFAULT = { w: 320, h: 132 };
const GRID_CHART_HEIGHT = 132;
const WIDE_CHART_GUTTER = 96;
const WIDE_CHART_HEIGHT = 340;
const WIDE_CHART_TABLET_HEIGHT = 300;
const WIDE_CHART_MOBILE_HEIGHT = 260;
const STRIP_CHART_HEIGHT = 150;
const STRIP_CHART_MOBILE_HEIGHT = 130;
const CHART_WIDTH_STEP = 8;

export function toChartSeconds(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 0;
    return value > 1_000_000_000_000 ? value / 1000 : value;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed / 1000;
}

function pad2(value: number) {
  return value.toString().padStart(2, "0");
}

function getDateParts(timestampSeconds: number) {
  const date = new Date(timestampSeconds * 1000);
  return {
    year: date.getFullYear(),
    month: pad2(date.getMonth() + 1),
    day: pad2(date.getDate()),
    hour: pad2(date.getHours()),
    minute: pad2(date.getMinutes()),
    second: pad2(date.getSeconds()),
  };
}

function formatAxisTime(timestampSeconds: number, rangeHours: number) {
  const parts = getDateParts(timestampSeconds);
  if (rangeHours >= 72) return `${parts.month}/${parts.day}`;
  return `${parts.hour}:${parts.minute}`;
}

export function createTimeAxisFormatter(rangeHours: number) {
  return (_self: uPlot, splits: number[]): string[] =>
    splits.map((value) => formatAxisTime(value, rangeHours));
}

function formatTooltipTime(timestampSeconds: number, rangeHours = 0): string {
  const parts = getDateParts(timestampSeconds);
  if (rangeHours >= 24) {
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

export function formatChartCoverageTime(timestampSeconds: number): string {
  const parts = getDateParts(timestampSeconds);
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getChartTooltipPosition({
  containerWidth,
  containerHeight,
  anchorX,
  anchorY,
  rowCount,
  estimatedWidth = 188,
}: {
  containerWidth: number;
  containerHeight: number;
  anchorX: number;
  anchorY: number;
  rowCount: number;
  estimatedWidth?: number;
}) {
  const margin = 10;
  const offsetX = 18;
  const offsetY = 16;
  const estimatedHeight = 34 + rowCount * 22;
  const maxLeft = Math.max(margin, containerWidth - estimatedWidth - margin);
  const maxTop = Math.max(margin, containerHeight - estimatedHeight - margin);

  let left =
    anchorX + estimatedWidth + offsetX <= containerWidth - margin
      ? anchorX + offsetX
      : anchorX - estimatedWidth - offsetX;
  left = clamp(left, margin, maxLeft);

  let top = anchorY - estimatedHeight - offsetY;
  if (top < margin) top = anchorY + offsetY;
  top = clamp(top, margin, maxTop);

  return { left, top };
}

export function buildChartTooltipHooks({
  dataRef,
  rangeHours,
  estimatedWidth,
  setTooltip,
  buildRows,
  isPinned,
}: {
  dataRef: { readonly current: uPlot.AlignedData };
  rangeHours: number;
  estimatedWidth: number;
  setTooltip: Dispatch<SetStateAction<ChartTooltipState>>;
  buildRows: (idx: number) => ChartTooltipState["rows"];
  // 点击固定：所在图表组处于固定状态时冻结 tooltip，不随光标移动/隐藏。
  // 用函数而非 ref：固定状态是「整组图表」共享的（见 useChartInteractions）。
  isPinned?: () => boolean;
}): {
  onInit: (u: uPlot) => void;
  onDestroy: (u: uPlot) => void;
  onSetCursor: (u: uPlot) => void;
} {
  let frame: number | null = null;
  let view: Window | null = null;
  const cancelScheduled = () => {
    if (frame != null) view?.cancelAnimationFrame(frame);
    frame = null;
  };
  const hide = () => {
    if (isPinned?.()) return;
    cancelScheduled();
    setTooltip((prev) => (prev.show ? { ...prev, show: false } : prev));
  };
  const update = (u: uPlot) => {
    frame = null;
    const idx = u.cursor.idx;
    if (idx == null || idx < 0) {
      hide();
      return;
    }
    const timestamp = dataRef.current[0]?.[idx];
    if (typeof timestamp !== "number") {
      hide();
      return;
    }
    const bbox = u.root.getBoundingClientRect();
    const anchorX = u.over.offsetLeft + u.valToPos(timestamp, "x");
    const anchorY =
      u.over.offsetTop +
      (typeof u.cursor.top === "number" ? u.cursor.top : u.over.clientHeight * 0.5);
    const rows = buildRows(idx);
    const position = getChartTooltipPosition({
      containerWidth: bbox.width,
      containerHeight: bbox.height,
      anchorX,
      anchorY,
      rowCount: rows.length,
      estimatedWidth,
    });
    setTooltip({
      show: true,
      left: position.left,
      top: position.top,
      rows,
      time: formatTooltipTime(timestamp, rangeHours),
    });
  };
  return {
    onInit: (u) => {
      view = u.root.ownerDocument.defaultView;
      u.root.addEventListener("mouseleave", hide);
    },
    onDestroy: (u) => {
      cancelScheduled();
      u.root.removeEventListener("mouseleave", hide);
      view = null;
    },
    onSetCursor: (u) => {
      if (isPinned?.()) return;
      if (!view) view = u.root.ownerDocument.defaultView;
      if (frame != null) return;
      frame = view?.requestAnimationFrame(() => update(u)) ?? null;
      if (frame == null) update(u);
    },
  };
}

function computeChartSize(
  mode: "grid" | "wide" | "strip",
  viewportWidth: number,
  containerWidth?: number,
): { w: number; h: number } {
  const quantize = (value: number) =>
    Math.max(1, Math.floor(value / CHART_WIDTH_STEP) * CHART_WIDTH_STEP);
  const measuredWidth =
    typeof containerWidth === "number" && containerWidth > 0
      ? containerWidth
      : mode === "grid"
        ? GRID_CHART_DEFAULT.w
        : viewportWidth - WIDE_CHART_GUTTER;

  if (mode === "wide") {
    const height =
      viewportWidth < 720
        ? WIDE_CHART_MOBILE_HEIGHT
        : viewportWidth < 1024
          ? WIDE_CHART_TABLET_HEIGHT
          : WIDE_CHART_HEIGHT;
    return {
      w: quantize(measuredWidth),
      h: height,
    };
  }

  if (mode === "strip") {
    return {
      w: quantize(measuredWidth),
      h: viewportWidth < 720 ? STRIP_CHART_MOBILE_HEIGHT : STRIP_CHART_HEIGHT,
    };
  }

  return {
    w: quantize(measuredWidth),
    h: viewportWidth < 768 ? 136 : GRID_CHART_HEIGHT,
  };
}

export function useResponsiveChartSize(mode: "grid" | "wide" | "strip") {
  const [size, setSize] = useState(
    mode === "grid"
      ? GRID_CHART_DEFAULT
      : mode === "strip"
        ? { w: 1280, h: STRIP_CHART_HEIGHT }
        : { w: 1280, h: WIDE_CHART_HEIGHT },
  );
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const apply = useCallback(() => {
    const next = computeChartSize(mode, window.innerWidth, nodeRef.current?.clientWidth);
    setSize((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
  }, [mode]);

  const scheduleApply = useCallback(() => {
    if (frameRef.current != null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      apply();
    });
  }, [apply]);

  const observeNode = useCallback(
    (node: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (node && typeof ResizeObserver !== "undefined") {
        const observer = new ResizeObserver(scheduleApply);
        observer.observe(node);
        observerRef.current = observer;
      }
    },
    [scheduleApply],
  );

  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      nodeRef.current = node;
      observeNode(node);
      if (node) {
        apply();
      }
    },
    [apply, observeNode],
  );

  useEffect(() => {
    observeNode(nodeRef.current);
    apply();
    window.addEventListener("resize", scheduleApply);
    return () => {
      window.removeEventListener("resize", scheduleApply);
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (frameRef.current != null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [apply, observeNode, scheduleApply]);

  return { ...size, ref };
}

// 跨图表联动：同一 syncKey 的图表共享「固定」与「缩放」状态。
// 固定任意图表 → 整组图表的光标都停在同一时间点并冻结 tooltip；
// 缩放任意图表 → 整组图表的 X 轴同步到同一时间窗口。
// syncKey 需与 uPlot cursor.sync.key 一致（光标位置靠 uPlot 内置 sync 广播，
// 固定/缩放这类「状态」则由本注册表广播）。
interface SyncGroupEntry {
  chart: uPlot | null;
  syncKey: string;
  fullRangeRef: MutableRefObject<[number, number] | null>;
  zoomXRangeRef: MutableRefObject<[number, number] | null>;
  setPinned: (value: boolean) => void;
  setZoomed: (value: boolean) => void;
  onUnpinRef: MutableRefObject<(() => void) | undefined>;
}

const syncGroupCharts = new Set<SyncGroupEntry>();
const pinnedSyncGroups = new Set<string>();

export function isSyncGroupPinned(syncKey: string): boolean {
  return pinnedSyncGroups.has(syncKey);
}

// uPlot 用私有属性 cursor._lock 冻结光标：为 true 时 mousemove/mouseleave/双击
// 以及跨图表 sync 光标更新全部被跳过。.d.ts 未声明该属性，故断言。
function setCursorLock(chart: uPlot, locked: boolean) {
  (chart.cursor as uPlot.Cursor & { _lock?: boolean })._lock = locked;
}

// 解除整组固定：逐图回调 onUnpin 隐藏 tooltip。移动端没有 hover，
// 取消固定后若不主动隐藏，tooltip 会永远留在原处。
function unpinSyncGroup(syncKey: string) {
  if (!pinnedSyncGroups.delete(syncKey)) return;
  for (const entry of [...syncGroupCharts]) {
    if (entry.syncKey !== syncKey) continue;
    entry.setPinned(false);
    if (entry.chart) setCursorLock(entry.chart, false);
    entry.onUnpinRef.current?.();
  }
}

// 重置整组缩放：清除各图的 zoomXRangeRef 并解除缩放标记。
function resetSyncGroupZoom(syncKey: string) {
  for (const entry of [...syncGroupCharts]) {
    if (entry.syncKey !== syncKey) continue;
    entry.zoomXRangeRef.current = null;
    entry.setZoomed(false);
  }
}

// 把 X 轴窗口广播给同组其余图表，并同步各自的 zoomed 标记。
// 各图的 fullRange 可能不同（实时为 null），故各自判断 isFull。
// isReset=true 时为重置操作，所有图表无条件清除缩放标记。
function broadcastXScale(syncKey: string, source: uPlot, min: number, max: number, isReset = false) {
  for (const entry of [...syncGroupCharts]) {
    if (entry.syncKey !== syncKey || entry.chart == null || entry.chart === source) continue;
    entry.zoomXRangeRef.current = isReset ? null : [min, max];
    entry.chart.setScale("x", { min, max });
    if (isReset) {
      entry.setZoomed(false);
    } else {
      const full = entry.fullRangeRef.current;
      const isFull = full != null && min <= full[0] + 0.5 && max >= full[1] - 0.5;
      entry.setZoomed(!isFull);
    }
  }
}

// 图表交互：滚轮缩放 X 轴、点击固定 tooltip、重置视图，且固定/缩放整组联动。
// fullRange 为可缩放的完整边界（历史模式用请求范围，实时用 null 自动取数据边界）。
// resetSignal 变化时重置缩放并取消固定（由父组件的刷新按钮驱动）。
// onUnpin 在取消固定时回调（供调用方隐藏 tooltip）。
export function useChartInteractions({
  fullRange,
  resetSignal,
  syncKey,
  onUnpin,
  zoomXRangeRef,
}: {
  fullRange: [number, number] | null;
  resetSignal: number;
  syncKey: string;
  onUnpin?: () => void;
  zoomXRangeRef: MutableRefObject<[number, number] | null>;
}) {
  const chartRef = useRef<uPlot | null>(null);
  const [pinned, setPinned] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const fullRangeRef = useRef(fullRange);
  fullRangeRef.current = fullRange;
  const firstReset = useRef(true);
  const onUnpinRef = useRef(onUnpin);
  onUnpinRef.current = onUnpin;

  // entry 只创建一次；持有的全是 ref / 稳定 setState，不存在过期闭包。
  const entryRef = useRef<SyncGroupEntry | null>(null);
  if (entryRef.current === null) {
    entryRef.current = {
      chart: null,
      syncKey,
      fullRangeRef,
      zoomXRangeRef,
      setPinned,
      setZoomed,
      onUnpinRef,
    };
  }
  const entry = entryRef.current;

  // 挂载时注册进组并继承组内既有状态；卸载时摘除，避免已销毁图表的 setState 泄漏。
  useEffect(() => {
    syncGroupCharts.add(entry);
    setPinned(pinnedSyncGroups.has(syncKey));
    return () => {
      syncGroupCharts.delete(entry);
      entry.chart = null;
    };
  }, [entry, syncKey]);

  const isGroupPinned = useCallback(() => pinnedSyncGroups.has(syncKey), [syncKey]);

  const onCreate = useCallback(
    (chart: uPlot) => {
      chartRef.current = chart;
      entry.chart = chart;
      const over = chart.over;

      const onWheel = (event: WheelEvent) => {
        event.preventDefault();
        const scale = chart.scales.x;
        if (scale.min == null || scale.max == null) return;
        const rect = over.getBoundingClientRect();
        const ratio = Math.min(
          Math.max((event.clientX - rect.left) / rect.width, 0),
          1,
        );
        const min = scale.min;
        const max = scale.max;
        const span = max - min;
        const factor = event.deltaY > 0 ? 1.25 : 0.8;
        let newMin = min + span * ratio * (1 - factor);
        let newMax = max - span * (1 - ratio) * (1 - factor);

        // 收敛到完整范围，避免缩出数据边界。
        const full = fullRangeRef.current;
        if (full) {
          const [fullMin, fullMax] = full;
          const fullSpan = fullMax - fullMin;
          if (newMax - newMin >= fullSpan) {
            newMin = fullMin;
            newMax = fullMax;
          } else {
            if (newMin < fullMin) {
              newMax += fullMin - newMin;
              newMin = fullMin;
            }
            if (newMax > fullMax) {
              newMin -= newMax - fullMax;
              newMax = fullMax;
            }
          }
        }

        // 最小缩放窗口 60s，避免缩到单点无意义。
        if (newMax - newMin < 60) return;

        chart.setScale("x", { min: newMin, max: newMax });
        zoomXRangeRef.current = [newMin, newMax];
        const isFull = full != null && newMin <= full[0] + 0.5 && newMax >= full[1] - 0.5;
        setZoomed(!isFull);
        // 缩放整组联动：其余同组图表同步到相同 X 窗口。
        broadcastXScale(syncKey, chart, newMin, newMax);
      };

      // uPlot 在 wrap 上以捕获阶段监听 click：只要按下到松开期间光标有过任何位移
      //（真实点击几乎必然发生），就会走 drag.click 默认实现 stopImmediatePropagation，
      // 把 click 事件整个吞掉，导致 over 上的 click 监听基本永远收不到事件。
      // 因此改用 pointerdown/pointerup 自行检测 tap：位移小于阈值视为点击，切换固定。
      // 该方案同时覆盖鼠标与触摸（移动端没有 hover，tap 是唯一入口）。
      let downPointerId = -1;
      let downX = 0;
      let downY = 0;
      const onPointerDown = (event: PointerEvent) => {
        downPointerId = event.pointerId;
        downX = event.clientX;
        downY = event.clientY;
      };
      const onPointerUp = (event: PointerEvent) => {
        if (event.pointerId !== downPointerId) return;
        downPointerId = -1;
        const dx = event.clientX - downX;
        const dy = event.clientY - downY;
        // 位移超过 8px 视为拖拽缩放，不触发固定切换。
        if (dx * dx + dy * dy > 64) return;

        if (pinnedSyncGroups.has(syncKey)) {
          unpinSyncGroup(syncKey);
          return;
        }
        // 先把光标落到 tap 位置。第三个参数 _pub=true 让 uPlot 内置 sync 把光标
        // 广播给同组其余图表（它们会按同一时间点排期渲染各自 tooltip）；
        // 此刻组还未固定，各图 setCursor hook 才会执行。随后再置整组固定。
        // （uPlot 的 .d.ts 漏了第三个 _pub 参数，运行时支持，故断言绕过。）
        const rect = over.getBoundingClientRect();
        (
          chart.setCursor as (
            opts: { left: number; top: number },
            fireHook?: boolean,
            pub?: boolean,
          ) => void
        )(
          {
            left: event.clientX - rect.left,
            top: event.clientY - rect.top,
          },
          true,
          true,
        );
        pinnedSyncGroups.add(syncKey);
        for (const other of syncGroupCharts) {
          if (other.syncKey !== syncKey) continue;
          other.setPinned(true);
          // 锁定必须放在 setCursor 广播之后：广播时还要让 sync 光标抵达其余图表，
          // 锁定后 mousemove/mouseleave 才无法再把十字线与点标记移离点选位置。
          if (other.chart) setCursorLock(other.chart, true);
        }
      };

      over.addEventListener("wheel", onWheel, { passive: false });
      over.addEventListener("pointerdown", onPointerDown);
      over.addEventListener("pointerup", onPointerUp);

      const originalDestroy = chart.destroy.bind(chart);
      chart.destroy = () => {
        over.removeEventListener("wheel", onWheel);
        over.removeEventListener("pointerdown", onPointerDown);
        over.removeEventListener("pointerup", onPointerUp);
        if (entry.chart === chart) entry.chart = null;
        if (chartRef.current === chart) chartRef.current = null;
        // 图表销毁（切换时间范围/主题重建等）后光标与数据都已重置，
        // 同步解除整组固定，避免残留冻结在旧数据上的 tooltip。
        unpinSyncGroup(syncKey);
        resetSyncGroupZoom(syncKey);
        originalDestroy();
      };
    },
    [entry, syncKey, zoomXRangeRef],
  );

  const resetView = useCallback(() => {
    unpinSyncGroup(syncKey);
    resetSyncGroupZoom(syncKey);
    const chart = chartRef.current;
    if (!chart) return;
    const full = fullRangeRef.current;
    if (full) {
      chart.setScale("x", { min: full[0], max: full[1] });
      broadcastXScale(syncKey, chart, full[0], full[1], true);
    } else {
      const times = chart.data[0];
      if (times && times.length > 1) {
        const min = times[0] as number;
        const max = times[times.length - 1] as number;
        chart.setScale("x", { min, max });
        broadcastXScale(syncKey, chart, min, max, true);
      }
    }
  }, [syncKey]);

  // 刷新按钮递增 resetSignal 触发重置；跳过首次挂载。
  useEffect(() => {
    if (firstReset.current) {
      firstReset.current = false;
      return;
    }
    resetView();
  }, [resetSignal, resetView]);

  return { onCreate, pinned, zoomed, isGroupPinned, resetView };
}
