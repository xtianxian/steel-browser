/** Coalesce target geometry reads without sharing page handles or input ownership. */
export function createSharedScan<T>(interval: number) {
  const entries = new Map<string, { promise: Promise<T>; expires: number }>();
  return (key: string, scan: () => Promise<T>): Promise<T> => {
    const cached = entries.get(key);
    if (cached && performance.now() < cached.expires) return cached.promise;
    const started = performance.now();
    const entry: { promise: Promise<T>; expires: number } = {
      promise: Promise.resolve(undefined as T),
      expires: Infinity,
    };
    entry.promise = Promise.resolve()
      .then(scan)
      .finally(() => {
        entry.expires = started + interval;
        const timer = setTimeout(
          () => {
            if (entries.get(key) === entry) entries.delete(key);
          },
          Math.max(0, entry.expires - performance.now()),
        );
        timer.unref?.();
      });
    entries.set(key, entry);
    return entry.promise;
  };
}
