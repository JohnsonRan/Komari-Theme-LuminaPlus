import type { ReactNode } from "react";
import { clsx } from "clsx";
import { Spinner } from "@/components/ui/Spinner";

export function InstancePanel({
  id,
  title,
  kicker,
  titleAction,
  description,
  aside,
  children,
  className,
}: {
  id?: string;
  // 可选：详情页标题已移到页面吸顶栏，面板本身不再重复渲染标题行。
  title?: string;
  kicker?: ReactNode;
  titleAction?: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const hasHeadings = title != null || kicker != null || description != null;
  return (
    <section id={id} className={clsx("instance-panel", kicker != null && "has-kicker", className)}>
      {(hasHeadings || aside != null) && (
        <header className="instance-panel-header">
          <div className="instance-panel-headings">
            {kicker != null && <span className="instance-panel-kicker">{kicker}</span>}
            {title != null && (
              <div className="instance-panel-title-row">
                <h2 className="instance-panel-title">{title}</h2>
                {titleAction}
              </div>
            )}
            {description != null && <p className="instance-panel-description">{description}</p>}
          </div>
          {aside != null && <div className="instance-panel-aside">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function InstanceChartLoading({ title }: { title: string }) {
  return (
    <InstancePanel title={title}>
      <div className="instance-chart-loading" aria-busy>
        <Spinner size={26} label="" />
        <span>加载中…</span>
      </div>
    </InstancePanel>
  );
}
