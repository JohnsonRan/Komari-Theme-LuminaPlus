import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { clsx } from "clsx";
import "uplot/dist/uPlot.min.css";
import { InstanceDetails } from "@/components/instance/InstanceDetails";
import { InstanceSidebar } from "@/components/instance/InstanceSidebar";
import { InstanceSwitcher } from "@/components/instance/InstanceSwitcher";
import { PingChart } from "@/components/instance/PingChart";
import { LoadChart } from "@/components/instance/LoadChart";
import { Spinner } from "@/components/ui/Spinner";
import {
  buildLoadTimeRangeOptions,
  buildPingTimeRangeOptions,
} from "@/components/instance/chartShared";
import { usePublicConfig } from "@/hooks/usePublicConfig";
import { useNodeMeta, useNodeStoreStatus, useAllNodeMeta } from "@/hooks/useNode";
import { useThemeSettings } from "@/hooks/useThemeSettings";
import { useAuth } from "@/hooks/useAuth";
import { collectMatchingNodeUuids } from "@/utils/nodeIdentity";

const DEFAULT_PING_HOURS = 4;
type TimeRangeOption = ReturnType<typeof buildLoadTimeRangeOptions>[number];

function RangeSelector({
  ranges,
  value,
  onChange,
}: {
  ranges: TimeRangeOption[];
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="instance-segmented is-scrollable">
      {ranges.map((range) => (
        <button
          key={range.value}
          type="button"
          data-active={value === range.value ? "true" : "false"}
          aria-pressed={value === range.value}
          onClick={() => onChange(range.value)}
        >
          {range.label}
        </button>
      ))}
    </div>
  );
}

export function Instance() {
  const { uuid } = useParams<{ uuid: string }>();
  const navigate = useNavigate();
  const { data: config } = usePublicConfig();
  const themeSettings = useThemeSettings();
  const meta = useNodeMeta(uuid ?? "");
  const storeStatus = useNodeStoreStatus(Boolean(uuid));
  const [chartType, setChartType] = useState<"load" | "ping">("load");
  const [loadHours, setLoadHours] = useState(0);
  const [pingHours, setPingHours] = useState(DEFAULT_PING_HOURS);
  const chartControlsRef = useRef<HTMLDivElement | null>(null);

  const metricRetentionHours =
    config?.metric_retention_days && config.metric_retention_days > 0
      ? config.metric_retention_days * 24
      : null;

  const loadRanges = useMemo(
    () => buildLoadTimeRangeOptions(metricRetentionHours ?? config?.record_preserve_time),
    [config?.record_preserve_time, metricRetentionHours],
  );
  const pingRanges = useMemo(
    () => buildPingTimeRangeOptions(metricRetentionHours ?? config?.ping_record_preserve_time),
    [config?.ping_record_preserve_time, metricRetentionHours],
  );
  const showPingChart = themeSettings.isReady && themeSettings.showPingChart;
  const splitLayout = themeSettings.isReady && themeSettings.detailSplitLayout;

  const alignCharts = useCallback(() => {
    const frame = window.requestAnimationFrame(() => {
      const element = chartControlsRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      if (rect.top >= 0 && rect.top < window.innerHeight) return;
      element.scrollIntoView({ behavior: "auto", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!loadRanges.some((range) => range.value === loadHours)) {
      setLoadHours(loadRanges[0]?.value ?? 0);
    }
  }, [loadHours, loadRanges]);

  useEffect(() => {
    if (!pingRanges.some((range) => range.value === pingHours)) {
      setPingHours(
        pingRanges.find((range) => range.value === DEFAULT_PING_HOURS)?.value ??
          pingRanges[0]?.value ??
          DEFAULT_PING_HOURS,
      );
    }
  }, [pingHours, pingRanges]);

  useEffect(() => {
    if (!showPingChart && chartType === "ping") {
      setChartType("load");
    }
  }, [chartType, showPingChart]);

  useEffect(() => {
    // 进入详情页或切换节点时回到顶部，避免保留上一页的滚动位置。
    window.scrollTo(0, 0);
  }, [uuid]);

  // 键盘导航：← / → 切换上/下一个节点。
  const allMeta = useAllNodeMeta();
  const { hiddenNodes } = useThemeSettings();
  const { data: authMe } = useAuth();
  const visibleUuids = useMemo(() => {
    const hiddenUuids = collectMatchingNodeUuids(allMeta, hiddenNodes);
    return allMeta
      .filter((n) => !hiddenUuids.has(n.uuid) && (authMe?.logged_in === true || !n.hidden))
      .map((n) => n.uuid);
  }, [allMeta, hiddenNodes, authMe?.logged_in]);

  useEffect(() => {
    if (!uuid || visibleUuids.length <= 1) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      // 忽略输入框内的按键
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable) return;
      const currentIndex = visibleUuids.indexOf(uuid);
      if (currentIndex < 0) return;
      event.preventDefault();
      const nextIndex = event.key === "ArrowLeft"
        ? (currentIndex - 1 + visibleUuids.length) % visibleUuids.length
        : (currentIndex + 1) % visibleUuids.length;
      const nextUuid = visibleUuids[nextIndex];
      if (nextUuid && nextUuid !== uuid) {
        navigate(`/instance/${encodeURIComponent(nextUuid)}`);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [uuid, visibleUuids, navigate]);

  if (!uuid) return null;

  const trimmedName = meta?.name?.trim();
  const pageTitle = trimmedName ? `${trimmedName} 信息` : "实例信息";

  if (!meta) {
    const message = storeStatus.hydrated
      ? "找不到这个实例，它可能已被删除或链接无效。"
      : storeStatus.nodeInfoError
        ? "节点列表加载失败，系统正在自动重试。"
        : null;
    return (
      <div className="flex flex-col gap-5 py-2">
        <Link to="/" className="instance-page-back" aria-label="返回">
          <ChevronLeft size={14} aria-hidden />
        </Link>
        <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
          {message ? (
            <>
              <div className="text-[15px] font-semibold text-[var(--text-primary)]">
                {storeStatus.hydrated ? "实例不存在" : "暂时无法加载实例"}
              </div>
              <p className="text-[13px] text-[var(--text-secondary)]">{message}</p>
            </>
          ) : (
            <Spinner size={24} label="正在加载实例" />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={clsx("instance-page", splitLayout && "is-split")}>
      {splitLayout && <InstanceSidebar currentUuid={uuid} />}
      <div className="instance-page-main">
      {/* 吸顶栏：返回 + 节点标题 + 快速切换始终悬浮，滚动查看图表时不丢失上下文。
          桌面分栏模式下切换器由 CSS 隐藏（侧栏已提供切换）。 */}
      <div className="instance-page-sticky-bar">
        <Link to="/" className="instance-page-back" aria-label="返回">
          <ChevronLeft size={14} aria-hidden />
        </Link>
        <h1 className="instance-page-title">{pageTitle}</h1>
        <InstanceSwitcher currentUuid={uuid} />
      </div>
      <InstanceDetails uuid={uuid} onNodeReady={alignCharts} />
      <div ref={chartControlsRef} className="instance-chart-controls">
        <div className="instance-segmented">
          <button
            type="button"
            data-active={chartType === "load" ? "true" : "false"}
            aria-pressed={chartType === "load"}
            onClick={() => {
              startTransition(() => setChartType("load"));
            }}
          >
            负载
          </button>
          {showPingChart && (
            <button
              type="button"
              data-active={chartType === "ping" ? "true" : "false"}
              aria-pressed={chartType === "ping"}
              onClick={() => {
                startTransition(() => setChartType("ping"));
              }}
            >
              Ping
            </button>
          )}
        </div>
        {chartType === "load" && (
          <RangeSelector
            key={`${chartType}-ranges`}
            ranges={loadRanges}
            value={loadHours}
            onChange={(value) => startTransition(() => setLoadHours(value))}
          />
        )}
        {chartType === "ping" && showPingChart && (
          <RangeSelector
            key={`${chartType}-ranges`}
            ranges={pingRanges}
            value={pingHours}
            onChange={(value) => startTransition(() => setPingHours(value))}
          />
        )}
      </div>
      <div className="instance-chart-stage">
        <div
          className="instance-chart-view"
          hidden={chartType !== "load"}
          aria-hidden={chartType !== "load"}
        >
          <LoadChart uuid={uuid} hours={loadHours} active={chartType === "load"} />
        </div>
        <div
          className="instance-chart-view"
          hidden={chartType !== "ping"}
          aria-hidden={chartType !== "ping"}
        >
          {showPingChart ? (
            <PingChart
              uuid={uuid}
              hours={pingHours}
              active={chartType === "ping"}
            />
          ) : null}
        </div>
      </div>
      </div>
    </div>
  );
}
