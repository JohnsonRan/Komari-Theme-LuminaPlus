import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { recordVisitorEvent } from "@/services/api";
import { usePublicConfig } from "@/hooks/usePublicConfig";

const DEBOUNCE_MS = 300;

/**
 * 页面切换时向后端上报访客事件（fire-and-forget）。
 * 仅在后端 record_enabled 为 true 时激活，尊重管理员开关。
 * 不采集任何用户标识，仅上报 path + type。
 */
export function useVisitorTracking() {
  const { pathname } = useLocation();
  const { data: config } = usePublicConfig();
  const timerRef = useRef<number | null>(null);
  const prevPathRef = useRef<string>("");

  useEffect(() => {
    if (!config?.record_enabled) return;
    // 首次挂载和路径相同时不重复上报。
    if (pathname === prevPathRef.current) return;
    prevPathRef.current = pathname;

    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      recordVisitorEvent({
        type: "pageview",
        path: pathname,
        referrer: document.referrer || undefined,
      });
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [pathname, config?.record_enabled]);
}
