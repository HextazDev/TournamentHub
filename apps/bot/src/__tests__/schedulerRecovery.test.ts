import { afterEach, describe, expect, it, vi } from "vitest";
import { SchedulerRecovery } from "../services/SchedulerRecovery";
import type { Client } from "discord.js";

const database = vi.hoisted(() => ({ result: { data: null as unknown, error: null as unknown } }));
vi.mock("../lib/supabase", () => ({
  supabase: { from: () => ({ select: () => ({ in: () => ({ gte: () => ({
    abortSignal: async () => database.result,
  }) }) }) }) },
}));
import { SchedulerService } from "../services/SchedulerService";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("scheduler recovery", () => {
  it("OPS-04: retries failed restoration and is ready only after success", async () => {
    vi.useFakeTimers();
    const restore = vi.fn().mockRejectedValueOnce(new Error("database down")).mockResolvedValueOnce(undefined);
    const recovery = new SchedulerRecovery(restore, () => {}, 1000);
    await recovery.start();
    expect(recovery.isReady()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(restore).toHaveBeenCalledTimes(2);
    expect(recovery.isReady()).toBe(true);
    recovery.stop();
    expect(recovery.isReady()).toBe(false);
  });
  it("OPS-04: stop prevents retry and late restoration from marking ready", async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {};
    const recovery = new SchedulerRecovery(() => new Promise<void>((resolve) => { finish = resolve; }), () => {}, 1000);
    const pending = recovery.start();
    recovery.stop();
    finish();
    await pending;
    await vi.advanceTimersByTimeAsync(5000);
    expect(recovery.isReady()).toBe(false);
  });
  it("OPS-04: actual scheduler reports a failed query and restores returned tournaments on retry", async () => {
    vi.useFakeTimers();
    const tournament = { id: "t1", guild_id: "g1", checkin_start_at: "2030-01-01", checkin_end_at: "2030-01-02" };
    database.result = { data: null, error: { message: "offline" } };
    const schedule = vi.spyOn(SchedulerService, "scheduleTournament").mockImplementation(async () => {});
    const recovery = new SchedulerRecovery(() => SchedulerService.init({} as Client), () => {}, 1000);
    await recovery.start();
    expect(recovery.isReady()).toBe(false);
    expect(schedule).not.toHaveBeenCalled();
    database.result = { data: [tournament], error: null };
    await vi.advanceTimersByTimeAsync(1000);
    expect(schedule).toHaveBeenCalledWith(tournament);
    expect(recovery.isReady()).toBe(true);
    recovery.stop();
  });
});
