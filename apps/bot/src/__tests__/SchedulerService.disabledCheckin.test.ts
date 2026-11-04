import { beforeEach, describe, expect, it, vi } from "vitest";
import schedule from "node-schedule";

const db = vi.hoisted(() => ({
  updates: [] as Array<{ table: string; values: any; filters: any }>,
  reset() {
    this.updates = [];
  },
}));

vi.mock("../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const filters: any = {};
      const chain: any = {
        update: (values: any) => {
          return {
            eq: (col: string, val: any) => {
              filters[col] = val;
              return {
                eq: (col2: string, val2: any) => {
                  filters[col2] = val2;
                  db.updates.push({ table, values, filters: { ...filters } });
                  return Promise.resolve({ data: null, error: null });
                },
              };
            },
          };
        },
      };
      return chain;
    },
  },
}));

import { SchedulerService } from "../services/SchedulerService";

describe("SchedulerService — checkin_mode === DISABLED (CHK-05)", () => {
  beforeEach(() => {
    db.reset();
    vi.restoreAllMocks();
    SchedulerService.cancelAllJobs();
  });

  it("CHK-05: si checkin_mode === 'DISABLED', ne planifie aucun job et passe toutes les équipes à is_checked_in = true", async () => {
    const scheduleSpy = vi.spyOn(schedule, "scheduleJob");
    const tournament = {
      id: "t-disabled-1",
      guild_id: "g-1",
      checkin_mode: "DISABLED" as const,
      checkin_start_at: "2030-01-01T10:00:00Z",
      checkin_end_at: "2030-01-01T11:00:00Z",
    };

    await SchedulerService.scheduleTournament(tournament);

    expect(scheduleSpy).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]).toEqual({
      table: "teams",
      values: { is_checked_in: true },
      filters: { tournament_id: "t-disabled-1", is_checked_in: false },
    });
  });

  it("CHK-05: si checkin_mode === 'ENABLED', planifie les jobs de check-in sans forcer is_checked_in", async () => {
    const scheduleSpy = vi.spyOn(schedule, "scheduleJob").mockReturnValue({} as any);
    const tournament = {
      id: "t-enabled-1",
      guild_id: "g-1",
      checkin_mode: "ENABLED" as const,
      checkin_start_at: "2030-01-01T10:00:00Z",
      checkin_end_at: "2030-01-01T11:00:00Z",
    };

    await SchedulerService.scheduleTournament(tournament);

    expect(scheduleSpy).toHaveBeenCalled();
    expect(db.updates).toHaveLength(0);
  });
});
