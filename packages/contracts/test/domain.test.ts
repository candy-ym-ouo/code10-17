import { describe, expect, it } from "vitest";
import {
  buildNotificationDedupeKey,
  calculateSessionDuration,
  canTransitionSession,
  describeMissingReview,
  isGoalProgressValid,
  mergeAttendance,
  stableContentHash,
  summarizeRehearsal,
  validateAnnotationRange,
  type RehearsalBarTask,
  type RehearsalMember,
} from "../src/index.js";

describe("session state machine", () => {
  it("allows the required completion transition", () => {
    expect(canTransitionSession("IN_REVIEW", "COMPLETED")).toBe(true);
    expect(canTransitionSession("DRAFT", "COMPLETED")).toBe(false);
  });
});

describe("annotation range", () => {
  it("rejects ranges under 100ms and outside media", () => {
    expect(validateAnnotationRange(100, 150, 1000)).toMatchObject({ ok: false });
    expect(validateAnnotationRange(900, 1100, 1000)).toMatchObject({ ok: false });
    expect(validateAnnotationRange(100, 250, 1000)).toEqual({ ok: true });
  });
});

describe("review completion", () => {
  it("returns every missing item instead of a generic failure", () => {
    expect(
      describeMissingReview({
        readyMediaCount: 0,
        annotationCount: 0,
        noIssues: false,
        nextFocus: "",
        openGoalCount: 0,
        newGoalCount: 0,
        progressUpdateCount: 0,
      }),
    ).toHaveLength(4);
  });
});

describe("goal values", () => {
  it("suggests achieved only when actual reaches target", () => {
    expect(isGoalProgressValid(90, 88)).toBe(true);
    expect(isGoalProgressValid(87, 88)).toBe(false);
  });

  it("sums only valid media durations", () => {
    expect(calculateSessionDuration([1000, null, 2500, -1])).toBe(3500);
  });
});

describe("attendance merge", () => {
  const now = new Date("2026-10-03T10:00:00.000Z");

  it("is idempotent for identical replayed responses", () => {
    const current = { status: "CONFIRMED" as const, note: "准时到", clientUpdatedAt: now, updatedAt: now };
    const result = mergeAttendance(current, { status: "CONFIRMED", clientUpdatedAt: now }, now);
    expect(result.changed).toBe(false);
    expect(result.merged.status).toBe("CONFIRMED");
  });

  it("merges offline confirmation by clientUpdatedAt without clobbering newer server roll call", () => {
    // 离线设备带着较早的 clientUpdatedAt 回放「确认参加」，
    // 但服务端已在更晚的时间点名为「缺席」——离线确认必须被丢弃。
    const offlineTime = new Date("2026-10-03T08:00:00.000Z");
    const serverTime = new Date("2026-10-03T09:30:00.000Z");
    const current = { status: "ABSENT" as const, clientUpdatedAt: serverTime, updatedAt: serverTime };
    const result = mergeAttendance(current, { status: "CONFIRMED", clientUpdatedAt: offlineTime, respondedOffline: true }, now);
    expect(result.changed).toBe(false);
    expect(result.merged.status).toBe("ABSENT");
  });

  it("applies an offline confirmation when it is newer than stored state", () => {
    const older = new Date("2026-10-03T08:00:00.000Z");
    const offlineTime = new Date("2026-10-03T09:00:00.000Z");
    const current = { status: "PENDING" as const, updatedAt: older };
    const result = mergeAttendance(current, { status: "CONFIRMED", clientUpdatedAt: offlineTime, respondedOffline: true }, now);
    expect(result.changed).toBe(true);
    expect(result.merged.status).toBe("CONFIRMED");
    expect(result.merged.respondedOffline).toBe(true);
  });

  it("never lets a member reply downgrade an already-checked attendance state", () => {
    for (const checked of ["PRESENT", "LATE", "ABSENT"] as const) {
      const current = { status: checked, updatedAt: now };
      const later = new Date(now.getTime() + 60_000);
      for (const reply of ["CONFIRMED", "DECLINED", "PENDING"] as const) {
        const result = mergeAttendance(current, { status: reply, clientUpdatedAt: later }, now);
        expect(result.changed).toBe(false);
        expect(result.merged.status).toBe(checked);
      }
    }
  });

  it("allows managers to correct roll-call states with a newer timestamp", () => {
    const earlier = new Date("2026-10-03T10:00:00.000Z");
    const later = new Date("2026-10-03T10:15:00.000Z");
    const current = { status: "PRESENT" as const, clientUpdatedAt: earlier, updatedAt: earlier };
    const result = mergeAttendance(current, { status: "ABSENT", clientUpdatedAt: later }, later);
    expect(result.changed).toBe(true);
    expect(result.merged.status).toBe("ABSENT");
  });
});

describe("rehearsal summary", () => {
  const members: RehearsalMember[] = [
    { id: "m1", displayName: "小林", instrument: "小提琴", part: "一提琴", isActive: true, attendance: { status: "PRESENT" } },
    { id: "m2", displayName: "小王", instrument: "小提琴", part: "二提琴", isActive: true, attendance: { status: "LATE" } },
    { id: "m3", displayName: "小张", instrument: "中提琴", part: "中提琴", isActive: true, attendance: { status: "CONFIRMED" } },
    { id: "m4", displayName: "小李", instrument: "大提琴", part: "大提琴", isActive: true, attendance: { status: "ABSENT" } },
    { id: "m5", displayName: "小钱", instrument: "长笛", part: "木管", isActive: true, attendance: { status: "DECLINED", respondedOffline: true } },
    { id: "m6", displayName: " inactive 不应计入", instrument: "圆号", part: "铜管", isActive: false, attendance: null },
  ];

  const tasks: RehearsalBarTask[] = [
    { id: "t1", startBar: 1, endBar: 8, title: "主题进入", status: "DONE", assigneeId: "m1" },
    { id: "t2", startBar: 9, endBar: 16, title: "副歌齐奏", status: "IN_PROGRESS", assigneeId: "m2" },
    { id: "t3", startBar: 17, endBar: 24, title: "中段音准", status: "NOT_STARTED", assigneeId: "m3" },
    // 缺席成员名下「已完成」任务：绝不允许抬高完成度
    { id: "t4", startBar: 25, endBar: 40, title: "低音铺底", status: "DONE", assigneeId: "m4" },
    // 请假成员名下任务同样整体排除
    { id: "t5", startBar: 41, endBar: 48, title: "长笛独奏", status: "DONE", assigneeId: "m5" },
    { id: "t6", startBar: 49, endBar: 56, title: "跳过段落", status: "SKIPPED", assigneeId: "m1" },
  ];

  it("groups attendance and part rollup correctly", () => {
    const summary = summarizeRehearsal(members, tasks);
    expect(summary.memberCount).toBe(5);
    expect(summary.attendance.PRESENT).toBe(1);
    expect(summary.attendance.LATE).toBe(1);
    expect(summary.attendance.ABSENT).toBe(1);
    expect(summary.attendance.DECLINED).toBe(1);
    expect(summary.attendance.presentTotal).toBe(2);
    expect(summary.attendance.missingTotal).toBe(3);
    expect(summary.attendance.respondedOffline).toBe(1);
    // CONFIRMED 与 DECLINED 在点名前都属于「待核实」
    expect(summary.unresolvedMembers).toContain("m3");
    expect(summary.unresolvedMembers).toContain("m5");
    expect(summary.unresolvedMembers).not.toContain("m1");
  });

  it("excludes absent members' tasks from completion denominator", () => {
    const summary = summarizeRehearsal(members, tasks);
    // 可核实任务：t1(DONE)、t2(进行中)、t3(未开始)；t4/t5 因缺席排除，t6 因 SKIPPED 排除
    expect(summary.tasks.accountableTotal).toBe(3);
    expect(summary.tasks.accountableDone).toBe(1);
    expect(summary.tasks.completionRate).toBeCloseTo(1 / 3, 10);
    // 朴素口径若不排除缺席，会被 t4/t5 两个 DONE 虚高到 3/6——必须不是这样
    expect(summary.tasks.completionRate).not.toBeCloseTo(0.5, 10);
  });

  it("computes bar-weighted completion over the same accountable scope", () => {
    const summary = summarizeRehearsal(members, tasks);
    // 可核实小节：t1 8 小节(DONE) + t2 8 + t3 8 = 24；完成 8
    expect(summary.tasks.barWeightedCompletionRate).toBeCloseTo(8 / 24, 10);
  });

  it("flags done tasks belonging to absent members for verification", () => {
    const summary = summarizeRehearsal(members, tasks);
    const absentRow = summary.members.find((row) => row.memberId === "m4");
    expect(absentRow?.suspectDoneWhileAbsent).toBe(1);
    const presentRow = summary.members.find((row) => row.memberId === "m1");
    expect(presentRow?.suspectDoneWhileAbsent).toBe(0);
  });

  it("reports 0 completion (not a misleading 100%) when no task is accountable", () => {
    const onlyAbsent: RehearsalMember[] = [
      { id: "a1", displayName: "唯一成员", instrument: "钢琴", part: "钢琴", isActive: true, attendance: { status: "ABSENT" } },
    ];
    const theirTasks: RehearsalBarTask[] = [
      { id: "x1", startBar: 1, endBar: 8, title: "全完成了？", status: "DONE", assigneeId: "a1" },
    ];
    const summary = summarizeRehearsal(onlyAbsent, theirTasks);
    expect(summary.tasks.accountableTotal).toBe(0);
    expect(summary.tasks.accountableDone).toBe(0);
    expect(summary.tasks.completionRate).toBe(0);
  });

  it("keeps all-present denominator identical to the plain count and handles empty rosters", () => {
    const everyone: RehearsalMember[] = [
      { id: "p1", displayName: "A", instrument: "小提琴", part: "一提", isActive: true, attendance: { status: "PRESENT" } },
      { id: "p2", displayName: "B", instrument: "中提琴", part: "中提", isActive: true, attendance: { status: "LATE" } },
    ];
    const tasks: RehearsalBarTask[] = [
      { id: "k1", startBar: 1, endBar: 4, title: "齐奏", status: "DONE", assigneeId: "p1" },
      { id: "k2", startBar: 5, endBar: 8, title: "伴奏", status: "NOT_STARTED", assigneeId: "p2" },
    ];
    const summary = summarizeRehearsal(everyone, tasks);
    expect(summary.tasks.accountableTotal).toBe(2);
    expect(summary.tasks.completionRate).toBe(0.5);
    expect(summary.attendance.presentTotal).toBe(2);
    expect(summary.attendance.missingTotal).toBe(0);

    const empty = summarizeRehearsal([], []);
    expect(empty.memberCount).toBe(0);
    expect(empty.tasks.completionRate).toBe(0);
    expect(empty.members).toEqual([]);
  });
});

describe("notification dedupe keys", () => {
  it("stays identical for the same change and changes when content changes", () => {
    const base = { rehearsalId: "r1", type: "REHEARSAL_UPDATED" as const, contentHash: stableContentHash({ location: "A 厅" }) };
    const again = { ...base };
    expect(buildNotificationDedupeKey(base)).toBe(buildNotificationDedupeKey(again));
    const changed = { ...base, contentHash: stableContentHash({ location: "B 厅" }) };
    expect(buildNotificationDedupeKey(base)).not.toBe(buildNotificationDedupeKey(changed));
  });

  it("hashes object key order independently", () => {
    expect(stableContentHash({ a: 1, b: 2 })).toBe(stableContentHash({ b: 2, a: 1 }));
  });

  it("scopes keys by type and entity so different changes both notify", () => {
    const a = buildNotificationDedupeKey({ rehearsalId: "r1", type: "BAR_TASK_ASSIGNED", entityId: "t1", contentHash: "x" });
    const b = buildNotificationDedupeKey({ rehearsalId: "r1", type: "BAR_TASK_UPDATED", entityId: "t1", contentHash: "x" });
    const c = buildNotificationDedupeKey({ rehearsalId: "r1", type: "BAR_TASK_ASSIGNED", entityId: "t2", contentHash: "x" });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
