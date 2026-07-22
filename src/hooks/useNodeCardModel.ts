import { useMemo } from "react";
import { useFakePingFallback } from "@/hooks/useFakePing";
import { useHourlyClock } from "@/hooks/useClock";
import { useNodeCardSnapshots } from "@/hooks/useNode";
import { useNodePingOverview, usePingBuckets } from "@/hooks/usePingOverview";
import { useThemeSettings } from "@/hooks/useThemeSettings";
import { formatRenewalPrice } from "@/utils/billing";
import { getExpireTextColor } from "@/utils/expireStatus";
import {
  formatBytes,
  formatByteRate,
  formatExpireDays,
  formatRelativeTime,
  formatUptimeDays,
  joinDisplayParts,
  parseTags,
} from "@/utils/format";
import {
  latencyHeatColor,
  lossHeatColor,
  trafficUsageColor,
} from "@/utils/metricTone";
import { resolveTrafficUsage, trafficTypeLabel, type TrafficDisplay } from "@/utils/traffic";
import { resolveOsInfo } from "@/components/ui/OsLogo";

export function useNodeCardModel(uuid: string, pingBucketCount?: number) {
  const { meta, metrics, trafficTrend } = useNodeCardSnapshots(uuid);
  const realPing = useNodePingOverview(uuid);
  const { showCardGroup, fakePingForUnbound, homepagePingBindings } = useThemeSettings();
  const now = useHourlyClock();
  const ping = useFakePingFallback(
    uuid,
    realPing,
    metrics?.online === true,
    fakePingForUnbound,
    homepagePingBindings,
  );
  const pingBuckets = usePingBuckets(ping, pingBucketCount);

  const metaModel = useMemo(() => {
    if (!meta) return null;
    const tags = parseTags(meta.tags);
    const group = showCardGroup ? meta.group : undefined;
    const subtitleParts = [group, meta.public_remark]
      .map((part) => part?.trim())
      .filter((part): part is string => Boolean(part));
    const subtitleLabels = new Set(subtitleParts.map((part) => part.toLowerCase()));
    const compactFooterTags = tags.filter(
      (tag) => !subtitleLabels.has(tag.label.trim().toLowerCase()),
    );
    const fallbackFooterTags =
      tags.length > 0
        ? tags
        : group
          ? [{ label: group, color: "gray" }]
          : [];
    const osName = resolveOsInfo(meta.os).name;
    return {
      tags,
      footerTags: fallbackFooterTags,
      compactFooterTags,
      subtitle: joinDisplayParts(subtitleParts),
      systemInfo: joinDisplayParts([osName, meta.arch, meta.kernel_version]),
      expire: formatExpireDays(meta.expired_at, now),
      expireColor: getExpireTextColor(meta.expired_at, now),
      renewalPrice: formatRenewalPrice(meta),
      osName,
      loadBaseline: meta.cpu_cores > 0 ? meta.cpu_cores : 4,
    };
  }, [meta, now, showCardGroup]);

  // 内嵌 ping 实时数据优先：延迟/丢包数值每 2s 跟随 latestStatus 刷新，
  // 历史柱状图仍由 overview 提供。无内嵌数据时回退到 overview 的 60s 数据。
  const resolvedPing = useMemo(() => {
    if (!metrics) return ping;
    const latest = metrics.pingLatest;
    const loss = metrics.pingLoss;
    if (latest == null && loss == null) return ping;
    return {
      ...ping,
      lastValue: latest ?? ping.lastValue,
      loss: loss ?? ping.loss,
    };
  }, [ping, metrics?.pingLatest, metrics?.pingLoss]);

  // ping 派生的颜色只在解析后的 ping 值变化时才变。
  const pingModel = useMemo(
    () => ({
      latencyColor: latencyHeatColor(resolvedPing.lastValue),
      lossColor: lossHeatColor(resolvedPing.loss),
      hasHomepagePingBinding: resolvedPing.isAssigned,
    }),
    [resolvedPing],
  );

  return useMemo(() => {
    if (!meta || !metrics || !metaModel) {
      return {
        node: undefined,
        trafficTrend,
        ping,
        pingBuckets,
      };
    }

    const { loadBaseline } = metaModel;

    // 流量配额：按节点的 traffic_limit_type（与后端一致）把累计上/下行算成"已用"，
    // 在这里一次性算出剩余和使用占比，让两种卡片布局共用这套计算。
    const trafficUsage = resolveTrafficUsage(
      meta.traffic_limit_type,
      metrics.trafficUp,
      metrics.trafficDown,
      meta.traffic_limit,
    );
    const trafficUsedLabel = formatBytes(trafficUsage.used);
    // 不限量时渲染成 ∞，让剩余值和"已用/上限"那行与限量情况保持一致
    //（"剩余 ∞" + "2.73 GB / ∞"）。
    const trafficLimitLabel = trafficUsage.unlimited ? "∞" : formatBytes(trafficUsage.limit);
    const trafficColor = trafficUsage.unlimited
      ? "var(--status-success)"
      : trafficUsageColor(trafficUsage.fraction);
    const traffic: TrafficDisplay = {
      fraction: trafficUsage.fraction,
      color: trafficColor,
      remainingLabel: trafficUsage.unlimited ? "∞" : formatBytes(trafficUsage.remaining),
      detail: `${trafficUsedLabel} / ${trafficLimitLabel}`,
      typeLabel: trafficTypeLabel(meta.traffic_limit_type),
    };

    return {
      node: { ...meta, ...metrics },
      trafficTrend,
      ping: resolvedPing,
      pingBuckets,
      traffic,
      ...metaModel,
      ...pingModel,
      uptime: formatUptimeDays(metrics.uptime),
      loadFraction: Math.max(0, Math.min(1, metrics.load1 / loadBaseline)),
      upRate: formatByteRate(metrics.netUp),
      downRate: formatByteRate(metrics.netDown),
      isOnline: metrics.online === true,
      isOffline: metrics.online === false,
      lastSeen: metrics.online === false && metrics.updatedAt > 0
        ? formatRelativeTime(metrics.updatedAt)
        : null,
    };
  }, [meta, metrics, metaModel, pingModel, resolvedPing, pingBuckets, trafficTrend]);
}
