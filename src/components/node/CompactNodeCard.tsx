import { memo, useCallback, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  Calendar,
  CircleDollarSign,
  Clock3,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  MemoryStick,
  Network,
  Unplug,
} from "lucide-react";
import { clsx } from "clsx";
import { Flag } from "@/components/ui/Flag";
import { OsLogo } from "@/components/ui/OsLogo";
import { useNodeCardModel } from "@/hooks/useNodeCardModel";
import { useThemeSettings } from "@/hooks/useThemeSettings";
import { formatBytes } from "@/utils/format";
import {
  latencyHeatColor,
  lossHeatColor,
  speedRateColor,
  speedRateColorFromBytes,
} from "@/utils/metricTone";
import { formatHealthBucketTooltip, formatPingHourStatsTitle } from "./pingBucketText";
import {
  formatCompactExpire,
  formatCompactPercent,
  formatCompactUptime,
  joinTagTitle,
  nodeDetailLinkLabels,
  pingEmptyLabels,
  TRAFFIC_SLIVER_RATIO,
} from "./nodeCardShared";
import { IpStackBadges } from "./IpStackBadges";
import { CanvasStrip, safeCanvasColor } from "./CanvasStrip";
import type {
  NodeInfo,
  NodeMetrics,
  PingOverviewBucket,
  PingOverviewItem,
  TrafficTrendSample,
} from "@/types/komari";
import type { ByteRateDisplay } from "@/utils/format";
import type { TrafficDisplay } from "@/utils/traffic";

const TRAFFIC_DOT_COUNT = 16;
const HEALTH_BAR_COUNT = 18;
type CompactNode = NodeInfo & NodeMetrics;
type CompactTag = { label: string; color: string };
type CompactExpire = { value: string; unit: string };

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function CompactGauge({
  icon,
  label,
  value,
  detail,
  color,
  fraction,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string;
  color: string;
  fraction: number;
}) {
  // 单元素分段条:填充用一个 hard-stop 渐变到 fraction 处,再叠一个重复 mask 打出
  // 18 个段间空隙。替代了 18 个逐段 <span>(每卡 ×4 个 gauge)—— 那些 span 在每个
  // 屏外卡片上每 tick 的 reconcile + 样式重算曾是渲染开销大头。
  const style = {
    "--compact-gauge-color": color,
    "--compact-gauge-fill": `${clamp01(fraction) * 100}%`,
  } as CSSProperties;

  return (
    <div
      className="compact-node-gauge"
      style={style}
      title={detail ? `${label} ${value} · ${detail}` : `${label} ${value}`}
    >
      <div className="compact-node-gauge-head">
        <span className="compact-node-gauge-label">
          {icon}
          <span>{label}</span>
        </span>
        <strong className="tabular">{value}</strong>
      </div>
      <div className="compact-node-gauge-track" aria-hidden />
    </div>
  );
}

function CompactInfoTile({
  label,
  color,
  children,
}: {
  label: string;
  color: string;
  children: ReactNode;
}) {
  const style = { "--compact-info-color": color } as CSSProperties;

  return (
    <div
      className="compact-node-info-tile"
      style={style}
      aria-label={label}
    >
      <span className="compact-node-info-content">{children}</span>
    </div>
  );
}

function CompactTrafficPulse({
  up,
  down,
}: {
  up: TrafficTrendSample[];
  down: TrafficTrendSample[];
}) {
  const upSelected = up.slice(-TRAFFIC_DOT_COUNT);
  const downSelected = down.slice(-TRAFFIC_DOT_COUNT);

  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, width: number, height: number) => {
      const count = TRAFFIC_DOT_COUNT;
      const slotWidth = width / count;
      const upPad = Math.max(0, count - upSelected.length);
      const downPad = Math.max(0, count - downSelected.length);
      const inactiveColor = safeCanvasColor("var(--progress-bg)");

      for (let i = 0; i < count; i++) {
        const upSample = i < upPad ? null : upSelected[i - upPad];
        const downSample = i < downPad ? null : downSelected[i - downPad];
        const upValue = upSample?.value ?? 0;
        const downValue = downSample?.value ?? 0;
        const active = upValue > 0 || downValue > 0;
        const level = Math.max(upSample?.level ?? 0, downSample?.level ?? 0);
        const scale = active ? 0.68 + level * 0.62 : 0.48;
        const radius = 2 * scale;
        const x = i * slotWidth + slotWidth / 2;
        const y = height / 2;

        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = active
          ? safeCanvasColor(speedRateColorFromBytes(Math.max(upValue, downValue)))
          : inactiveColor;
        ctx.globalAlpha = active ? 0.5 + level * 0.42 : 0.38;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    },
    [upSelected, downSelected],
  );

  return (
    <CanvasStrip
      className="compact-node-traffic-pulse-canvas"
      height={7}
      redrawKey={`${upSelected.length}-${downSelected.length}`}
      draw={draw}
    />
  );
}

function CompactInfoRow({
  icon,
  label,
  value,
  unit,
  color,
}: {
  icon: ReactNode;
  label?: string;
  value: string;
  unit?: string;
  color?: string;
}) {
  const style = color ? ({ "--compact-info-row-color": color } as CSSProperties) : undefined;

  return (
    <span className="compact-node-info-row" style={style}>
      <span className="compact-node-info-row-label">
        {icon}
        {label && <span>{label}</span>}
      </span>
      <strong className="compact-node-info-row-value tabular">
        {value}
        {unit && <small>{unit}</small>}
      </strong>
    </span>
  );
}

function HealthBars({
  buckets,
  max,
  kind,
}: {
  buckets: PingOverviewBucket[];
  max: number;
  kind: "latency" | "loss";
}) {
  const safeMax = Math.max(1, max);
  const bars = buckets.slice(-HEALTH_BAR_COUNT);
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const activeIndex = hoveredIndex ?? selectedIndex;
  const activeBucket = activeIndex == null ? null : bars[activeIndex] ?? null;
  const activeTooltip = activeBucket ? formatHealthBucketTooltip(activeBucket, kind) : null;
  const activeLeft =
    activeIndex == null || bars.length === 0
      ? "50%"
      : `clamp(42px, ${((activeIndex + 0.5) / bars.length) * 100}%, calc(100% - 42px))`;

  const selectIndex = (next: number) => {
    if (bars.length === 0) return;
    setSelectedIndex(Math.max(0, Math.min(bars.length - 1, next)));
  };

  return (
    <div
      ref={containerRef}
      className="compact-node-health-bars"
      data-kind={kind}
      style={{ "--compact-health-tooltip-x": activeLeft } as CSSProperties}
      tabIndex={0}
      role="group"
      aria-label={`${kind === "latency" ? "延迟" : "丢包"}历史${activeTooltip ? `，${activeTooltip}` : ""}，使用左右方向键查看`}
      onFocus={() => {
        if (selectedIndex == null) selectIndex(bars.length - 1);
      }}
      onBlur={() => {
        setHoveredIndex(null);
        setSelectedIndex(null);
      }}
      onKeyDown={(event) => {
        const current = selectedIndex ?? bars.length - 1;
        if (event.key === "ArrowLeft") selectIndex(current - 1);
        else if (event.key === "ArrowRight") selectIndex(current + 1);
        else if (event.key === "Home") selectIndex(0);
        else if (event.key === "End") selectIndex(bars.length - 1);
        else return;
        event.preventDefault();
      }}
    >
      {activeTooltip && (
        <span className="compact-node-health-tooltip" role="status">
          {activeTooltip}
        </span>
      )}
      {bars.map((bucket, index) => {
        const hasSamples = bucket.total > 0;
        const latencyValue = bucket.value ?? 0;
        const lossValue = bucket.loss ?? 0;
        const active = kind === "latency" ? bucket.value != null : hasSamples;
        const height =
          kind === "latency"
            ? `${active ? Math.max(26, Math.min(100, (latencyValue / safeMax) * 100)) : 24}%`
            : `${active ? Math.max(38, Math.min(100, 84 - Math.min(lossValue, 45))) : 24}%`;
        const color = active
          ? kind === "latency"
            ? latencyHeatColor(latencyValue)
            : lossHeatColor(lossValue)
          : "var(--progress-bg)";
        const style = {
          "--compact-health-height": height,
          "--compact-health-color": color,
          opacity: active ? 0.94 : 0.42,
        } as CSSProperties;
        const tooltip = formatHealthBucketTooltip(bucket, kind);

        return (
          <span
            key={`${bucket.index}-${index}`}
            className="compact-node-health-bar"
            style={style}
            data-selected={selectedIndex === index ? "true" : "false"}
            aria-hidden="true"
            title={tooltip}
            onMouseEnter={() => setHoveredIndex(index)}
            onMouseLeave={() => setHoveredIndex(null)}
            onClick={() => {
              containerRef.current?.focus({ preventScroll: true });
              setSelectedIndex(index);
            }}
          />
        );
      })}
    </div>
  );
}

function CompactHealthItem({
  icon,
  label,
  value,
  unit,
  color,
  title,
  children,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  unit?: string;
  color: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="compact-node-health-item">
      <div className="compact-node-health-head">
        <span className="compact-node-health-label">
          {icon}
          {label}
        </span>
        <strong className="compact-node-health-value tabular" style={{ color }} title={title}>
          {value}
          {unit && <small>{unit}</small>}
        </strong>
      </div>
      {children}
    </div>
  );
}

function CompactNodeHeader({
  node,
  osName,
  systemInfo,
}: {
  node: CompactNode;
  osName: string;
  systemInfo: string;
}) {
  const detailLabels = nodeDetailLinkLabels(node.name, osName);
  return (
    <header className="compact-node-header">
      <div className="compact-node-title-wrap">
        <div className="compact-node-title-row">
          <Flag region={node.region} size={15} />
          <Link
            to={`/instance/${encodeURIComponent(node.uuid)}`}
            className="compact-node-title"
            title={node.name}
          >
            {node.name}
          </Link>
        </div>
        {systemInfo && (
          <div className="compact-node-sysinfo" title={systemInfo}>
            {systemInfo}
          </div>
        )}
      </div>
      <div className="compact-node-actions">
        <Link
          to={`/instance/${encodeURIComponent(node.uuid)}`}
          className="compact-node-detail-link"
          title={detailLabels.title}
          aria-label={detailLabels.ariaLabel}
        >
          <OsLogo value={node.os} size={15} />
        </Link>
      </div>
    </header>
  );
}

function CompactNodeChips({
  subtitle,
  tags,
  ipv4,
  ipv6,
}: {
  subtitle: string;
  tags: CompactTag[];
  ipv4?: string | null;
  ipv6?: string | null;
}) {
  // 完整 tag 列表挂在 lane 的 tooltip 上;chip 不带自己的 title,hover 会穿透到 lane 上 ——
  // 被裁剪 lane 折行挤出去的 tag 就靠这个保持可见,不用显示"+N"角标。
  const tagTitle = joinTagTitle(tags);

  return (
    <div className="compact-node-chip-row">
      {subtitle && (
        <span className="compact-node-subtitle" title={subtitle}>
          {subtitle}
        </span>
      )}
      <IpStackBadges ipv4={ipv4} ipv6={ipv6} />
      {tags.length > 0 && (
        <div className="compact-node-tag-lane" title={tagTitle}>
          {tags.map((tag, index) => (
            <span
              key={`${tag.label}-${index}`}
              className="compact-node-tag"
              data-tag={tag.color}
            >
              {tag.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CompactNodeVitals({
  node,
  loadFraction,
}: {
  node: CompactNode;
  loadFraction: number;
}) {
  return (
    <div className="compact-node-vitals">
      <CompactGauge
        icon={<Cpu size={12} />}
        label="CPU"
        value={formatCompactPercent(node.cpuPct)}
        detail={`${node.cpu_cores || 0} 核`}
        fraction={node.cpuPct / 100}
        color="var(--progress-cpu)"
      />
      <CompactGauge
        icon={<MemoryStick size={12} />}
        label="内存"
        value={formatCompactPercent(node.ramPct)}
        detail={`${formatBytes(node.ramUsed)} / ${formatBytes(node.ramTotal)}`}
        fraction={node.ramPct / 100}
        color="var(--progress-memory)"
      />
      <CompactGauge
        icon={<HardDrive size={12} />}
        label="磁盘"
        value={formatCompactPercent(node.diskPct)}
        detail={`${formatBytes(node.diskUsed)} / ${formatBytes(node.diskTotal)}`}
        fraction={node.diskPct / 100}
        color="var(--progress-disk)"
      />
      <CompactGauge
        icon={<Gauge size={12} />}
        label="负载"
        value={node.load1.toFixed(2)}
        detail={`${node.load5.toFixed(2)} / ${node.load15.toFixed(2)}`}
        fraction={loadFraction}
        color="var(--progress-load)"
      />
    </div>
  );
}

function CompactNodeInfoStrip({
  node,
  trafficTrend,
  upRate,
  downRate,
  showTrafficTotal,
  showBilling,
  showConnections,
  expire,
  expireColor,
  renewalPrice,
}: {
  node: CompactNode;
  trafficTrend: { up: TrafficTrendSample[]; down: TrafficTrendSample[] };
  upRate: ByteRateDisplay;
  downRate: ByteRateDisplay;
  showTrafficTotal: boolean;
  showBilling: boolean;
  showConnections: boolean;
  expire: CompactExpire;
  expireColor: string;
  renewalPrice: string | null;
}) {
  const infoTileCount =
    1 + (showTrafficTotal ? 1 : 0) + (showBilling ? 1 : 0) + (showConnections ? 1 : 0);

  return (
    <div
      className="compact-node-info-strip"
      style={{ "--compact-info-columns": infoTileCount } as CSSProperties}
    >
      <CompactInfoTile
        label="实时速率"
        color="var(--progress-cpu)"
      >
        <CompactInfoRow
          icon={<ArrowUp size={12} strokeWidth={2.3} />}
          value={upRate.value}
          unit={upRate.unit}
          color={speedRateColor(upRate.unit)}
        />
        <CompactInfoRow
          icon={<ArrowDown size={12} strokeWidth={2.3} />}
          value={downRate.value}
          unit={downRate.unit}
          color={speedRateColor(downRate.unit)}
        />
        <CompactTrafficPulse up={trafficTrend.up} down={trafficTrend.down} />
      </CompactInfoTile>
      {showTrafficTotal && (
        <CompactInfoTile
          label="累计流量"
          color="var(--text-primary)"
        >
          <CompactInfoRow
            icon={(
              <ArrowUp
                size={12}
                strokeWidth={2.5}
                aria-label="上行"
              />
            )}
            value={formatBytes(node.trafficUp)}
          />
          <CompactInfoRow
            icon={(
              <ArrowDown
                size={12}
                strokeWidth={2.5}
                aria-label="下行"
              />
            )}
            value={formatBytes(node.trafficDown)}
          />
        </CompactInfoTile>
      )}
      {showBilling && (
        <CompactInfoTile
          label="费用到期"
          color="var(--status-success)"
        >
          <CompactInfoRow
            icon={<Calendar size={12} strokeWidth={2.1} />}
            value={formatCompactExpire(expire)}
            color={expireColor}
          />
          <CompactInfoRow
            icon={<CircleDollarSign size={12} strokeWidth={2.2} />}
            value={renewalPrice || "未填"}
            color={renewalPrice ? "var(--status-success)" : "var(--text-tertiary)"}
          />
        </CompactInfoTile>
      )}
      {showConnections && (
        <CompactInfoTile label="连接数" color="var(--progress-network)">
          <CompactInfoRow
            icon={<Network size={12} strokeWidth={2.1} />}
            label="TCP"
            value={node.connectionsTcp.toLocaleString()}
            color="var(--progress-network)"
          />
          <CompactInfoRow
            icon={<Network size={12} strokeWidth={2.1} />}
            label="UDP"
            value={node.connectionsUdp.toLocaleString()}
          />
        </CompactInfoTile>
      )}
    </div>
  );
}

// 流量阈值条:label + used / limit 同一行(紧凑卡片很挤,这里省掉剩余量),
// 用单元素热力填充(无 canvas、无逐段 span)复用 gauge 轨道,保持每 tick 低开销。
function CompactTrafficBar({
  traffic,
  uptimeLabel,
}: {
  traffic: TrafficDisplay;
  uptimeLabel: string;
}) {
  // 用量非零但极小时,下限填充"一段的 TRAFFIC_SLIVER_RATIO"(段内一道细边),而不是整段——
  // 否则低用量节点(如 0.01%)会被夸张成快 5.6%。fraction 为 0 时保持全灭。
  const fillFraction =
    traffic.fraction > 0
      ? Math.max(clamp01(traffic.fraction), TRAFFIC_SLIVER_RATIO / 18)
      : 0;
  const style = {
    "--compact-gauge-color": traffic.color,
    "--compact-gauge-fill": `${fillFraction * 100}%`,
  } as CSSProperties;

  return (
    <div
      className="compact-node-traffic"
      style={style}
      title={`流量 · ${traffic.typeLabel} · ${traffic.detail}${uptimeLabel ? ` · ${uptimeLabel}` : ""}`}
    >
      <div className="compact-node-traffic-body">
        <span className="compact-node-traffic-label">
          <Database size={12} strokeWidth={2.1} />
          <span>流量</span>
        </span>
        <div className="compact-node-gauge-track" aria-hidden />
        <span className="compact-node-traffic-uptime">
          {uptimeLabel || "\u00A0"}
        </span>
        <span className="compact-node-traffic-value">{traffic.detail}</span>
      </div>
    </div>
  );
}

// memo:每个 prop 都源自 ping,在父卡片每 ~1s 指标 tick 重渲染时引用稳定(ping 数据
// ~60s 才刷新一次),所以在 ping 数据真正变化前,跳过重渲染 latency/loss HealthBars
// 这棵子树 —— 它是每 tick DOM 开销的大头。
const CompactNodeHealth = memo(function CompactNodeHealth({
  ping,
  pingBuckets,
  latencyColor,
  lossColor,
  hasHomepagePingBinding,
}: {
  ping: PingOverviewItem;
  pingBuckets: PingOverviewBucket[];
  latencyColor: string;
  lossColor: string;
  hasHomepagePingBinding: boolean;
}) {
  // 已绑定但无样本时显示"无样本",未绑定时显示"未配置" —— 见 pingEmptyLabels。
  const { text: emptyText } = pingEmptyLabels(hasHomepagePingBinding);
  const hourStatsTitle = formatPingHourStatsTitle(ping);
  return (
    <div className="compact-node-bottom">
      <CompactHealthItem
        icon={<Clock3 size={12} />}
        label="延迟"
        value={ping.lastValue != null ? Math.round(ping.lastValue).toString() : emptyText}
        unit={ping.lastValue != null ? "ms" : undefined}
        color={latencyColor}
        title={hourStatsTitle ?? undefined}
      >
        <HealthBars buckets={pingBuckets} max={ping.max} kind="latency" />
      </CompactHealthItem>
      <CompactHealthItem
        icon={<Unplug size={12} />}
        label="丢包"
        value={ping.loss != null ? ping.loss.toFixed(1) : emptyText}
        unit={ping.loss != null ? "%" : undefined}
        color={lossColor}
      >
        <HealthBars buckets={pingBuckets} max={1} kind="loss" />
      </CompactHealthItem>
    </div>
  );
});

export const CompactNodeCard = memo(function CompactNodeCard({
  uuid,
}: {
  uuid: string;
}) {
  const model = useNodeCardModel(uuid, HEALTH_BAR_COUNT);
  const themeSettings = useThemeSettings();

  if (!model.node) {
    return (
      <div className="compact-node-card skeleton-compact" aria-busy>
        <div className="skeleton-compact-header">
          <div className="skeleton-compact-title">
            <span className="skeleton-block" style={{ width: "55%", height: 15 }} />
            <span className="skeleton-block" style={{ width: "80%", height: 11 }} />
          </div>
          <span className="skeleton-block" style={{ width: 30, height: 30, borderRadius: 8 }} />
        </div>
        <div className="skeleton-compact-chips">
          <span className="skeleton-block" style={{ width: 64, height: 22, borderRadius: 7 }} />
          <span className="skeleton-block" style={{ width: 44, height: 22, borderRadius: 8 }} />
        </div>
        <div className="skeleton-compact-vitals">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skeleton-compact-gauge">
              <span className="skeleton-block" style={{ width: "70%", height: 11 }} />
              <span className="skeleton-block" style={{ width: "100%", height: 7, borderRadius: 4 }} />
            </div>
          ))}
        </div>
        <div className="skeleton-compact-strip">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="skeleton-compact-strip-tile">
              <span className="skeleton-block" style={{ width: "80%", height: 10 }} />
              <span className="skeleton-block" style={{ width: "60%", height: 10 }} />
            </div>
          ))}
        </div>
        <div className="skeleton-compact-traffic">
          <span className="skeleton-block" style={{ width: "45%", height: 11 }} />
          <span className="skeleton-block" style={{ width: "100%", height: 7, borderRadius: 4 }} />
        </div>
        <div className="skeleton-compact-bottom">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="skeleton-compact-health">
              <span className="skeleton-block" style={{ width: "65%", height: 11 }} />
              <span className="skeleton-block" style={{ width: "100%", height: 13, borderRadius: 4 }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const {
    node,
    traffic,
    trafficTrend,
    ping,
    pingBuckets,
    compactFooterTags: footerTags,
    subtitle,
    systemInfo,
    renewalPrice,
    expire,
    expireColor,
    upRate,
    downRate,
    isOffline,
    latencyColor,
    lossColor,
    loadFraction,
    hasHomepagePingBinding,
    osName,
  } = model;
  const showTrafficTotal = themeSettings.isReady && themeSettings.compactShowTrafficTotal;
  const showBilling = themeSettings.isReady && themeSettings.compactShowBilling;
  const showUptime = themeSettings.isReady && themeSettings.compactShowUptime;
  const showConnections = themeSettings.isReady && themeSettings.showConnections;
  // 开关关闭或节点离线时,完全跳过格式化工作。离线时显示最后在线时间。
  const uptimeLabel = showUptime && !isOffline
    ? formatCompactUptime(node.uptime)
    : isOffline && model.lastSeen
      ? model.lastSeen
      : "";

  return (
    <article className={clsx("compact-node-card", isOffline && "is-offline")}>
      <CompactNodeHeader node={node} osName={osName} systemInfo={systemInfo} />
      <CompactNodeChips subtitle={subtitle} tags={footerTags} ipv4={node.ipv4} ipv6={node.ipv6} />
      <CompactNodeVitals node={node} loadFraction={loadFraction} />
      <CompactNodeInfoStrip
        node={node}
        trafficTrend={trafficTrend}
        upRate={upRate}
        downRate={downRate}
        showTrafficTotal={showTrafficTotal}
        showBilling={showBilling}
        showConnections={showConnections}
        expire={expire}
        expireColor={expireColor}
        renewalPrice={renewalPrice}
      />
      <CompactTrafficBar traffic={traffic} uptimeLabel={uptimeLabel} />
      <CompactNodeHealth
        ping={ping}
        pingBuckets={pingBuckets}
        latencyColor={latencyColor}
        lossColor={lossColor}
        hasHomepagePingBinding={hasHomepagePingBinding}
      />
    </article>
  );
});
