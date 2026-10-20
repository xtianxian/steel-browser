import { afterEach, describe, expect, it, vi } from "vitest";
import { createSharedScan } from "./shared-scan.js";
afterEach(() => vi.useRealTimers());
describe("per-target shared geometry scans", () => {
  it("shares in-flight scans for one target, keeps other targets independent", async () => {
    const read = createSharedScan<number>(250);
    const pending = Promise.withResolvers<number>();
    const first = vi.fn(() => pending.promise);
    const duplicate = vi.fn(async () => 999);
    const one = read("A", first),
      two = read("A", duplicate);
    expect(one).toBe(two);
    expect(await read("B", async () => 2)).toBe(2);
    pending.resolve(1);
    expect(await one).toBe(1);
    expect(first).toHaveBeenCalledOnce();
    expect(duplicate).not.toHaveBeenCalled();
  });
  it("does not slow the original scan cadence or retain a failed result", async () => {
    vi.useFakeTimers();
    const read = createSharedScan<number>(250);
    const count = vi.fn(async () => 1);
    expect(await read("A", count)).toBe(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(await read("A", count)).toBe(1);
    expect(count).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(
      read("A", async () => {
        throw new Error("detached");
      }),
    ).rejects.toThrow("detached");
    await vi.advanceTimersByTimeAsync(250);
    expect(await read("A", async () => 2)).toBe(2);
  });
  it("does not duplicate slow work or let old cleanup evict a newer scan", async () => {
    vi.useFakeTimers();
    const read = createSharedScan<number>(250),
      pending = Promise.withResolvers<number>();
    const first = read("A", () => pending.promise);
    await vi.advanceTimersByTimeAsync(800);
    expect(read("A", async () => 100)).toBe(first);
    pending.resolve(1);
    await first;
    const fresh = read("A", async () => 2);
    expect(await fresh).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read("A", async () => 3)).toBe(fresh);
  });
});
