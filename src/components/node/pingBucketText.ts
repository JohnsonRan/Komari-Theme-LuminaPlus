import type { PingOverviewBucket } from "@/types/komari";
import { trimFixed } from "@/utils/format";

export function formatPingBucketWindow(bucket: PingOverviewBucket | null) {
  if (!bucket || bucket.startAt == null || bucket.endAt == null) {
    return null;
  }

  const start = new Date(bucket.startAt);
  const end = new Date(bucket.endAt);
  const startText = `${start.getHours().toString().padStart(2, "0")}:${start
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
  const endText = `${end.getHours().toString().padStart(2, "0")}:${end
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
  return `${startText} - ${endText}`;
}

export function formatLatencyBucketSummary(bucket: PingOverviewBucket | null) {
  if (!bucket) return "—";
  if (bucket.value != null) return `${trimFixed(bucket.value, 1)} ms`;
  return bucket.total > 0 ? "失败" : "无样本";
}

export function formatLossBucketSummary(
  bucket: PingOverviewBucket | null,
  separator = " ",
) {
  if (!bucket) return "—";
  if (bucket.total <= 0 || bucket.loss == null) return "无样本";
  return `${trimFixed(bucket.loss, 1)}%${separator}${bucket.lost}/${bucket.total}`;
}

export function formatHealthBucketTooltip(
  bucket: PingOverviewBucket,
  kind: "latency" | "loss",
) {
  const window = formatPingBucketWindow(bucket);
  const summary =
    kind === "latency"
      ? formatLatencyBucketSummary(bucket)
      : formatLossBucketSummary(bucket, " · ");
  return window ? `${window} · ${summary}` : summary;
}

/** 将实时通道下发的近 1 小时延迟统计（均值/最低/最高）格式化为悬停提示。
 *  后端未下发任何一项时返回 null（不挂 title）。 */
export function formatPingHourStatsTitle(stats: {
  avg?: number | null;
  min?: number | null;
  peak?: number | null;
}) {
  const parts: string[] = [];
  if (stats.avg != null && Number.isFinite(stats.avg)) parts.push(`均值 ${Math.round(stats.avg)} ms`);
  if (stats.min != null && Number.isFinite(stats.min)) parts.push(`最低 ${Math.round(stats.min)} ms`);
  if (stats.peak != null && Number.isFinite(stats.peak)) parts.push(`最高 ${Math.round(stats.peak)} ms`);
  if (parts.length === 0) return null;
  return `近 1 小时：${parts.join(" · ")}`;
}
