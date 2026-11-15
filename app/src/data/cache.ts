// 上游数据缓存：先读 localStorage 里的旧副本，后台再取新的。
// 取不到网络时继续用缓存；两者都没有才算失败。

export interface CachedEntry<T> {
  data: T;
  fetchedAt: number;
}

const PREFIX = "otm.data.";

export function readCache<T>(key: string): CachedEntry<T> | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedEntry<T>;
    if (!parsed || typeof parsed.fetchedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeCache<T>(key: string, data: T): boolean {
  const entry: CachedEntry<T> = { data, fetchedAt: Date.now() };
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(entry));
    return true;
  } catch {
    // 多半是超出配额：清掉旧数据再试一次
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith(PREFIX)) localStorage.removeItem(k);
      }
      localStorage.setItem(PREFIX + key, JSON.stringify(entry));
      return true;
    } catch {
      return false;
    }
  }
}

export function cacheAge(key: string): number | null {
  const c = readCache(key);
  return c ? Date.now() - c.fetchedAt : null;
}
