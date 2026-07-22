import { useQuery } from "@tanstack/react-query";
import { getVersion, type KomariVersion } from "@/services/api";

export function useVersion() {
  return useQuery<KomariVersion>({
    queryKey: ["version"],
    queryFn: ({ signal }) => getVersion({ signal }),
    // 版本号在运行期间不变，无需重复拉取。
    staleTime: Infinity,
    retry: false,
  });
}
