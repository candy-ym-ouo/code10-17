import { describe, expect, it } from "vitest";
import {
  buildChangeFingerprint,
  buildRehearsalRollup,
  emptySyncState,
  isSameChange,
  mergeOfflineValue,
  reduceOfflineSync,
  summarizeBarTask,
  type BarTaskAssignmentInput,
  type SyncEvent,
} from "../src/ensemble.js";

const members = [
  { id: "11111111-1111-4111-8111-111111111111", part: "第一小提琴", role: "OWNER" as const, active: true },
  { id: "22222222-2222-4222-8222-222222222222", part: "第二小提琴", role: "MEMBER" as const, active: true },
  { id: "33333333-3333-4333-8333-333333333333", part: "中提琴", role: "MEMBER" as const, active: true },
  { id: "44444444-4444-4444-8444-444444444444", part: "大提琴", role: "MEMBER" as const, active: false },
];

const task = (overrides: Partial<BarTaskAssignmentInput> = {}): BarTaskAssignmentInput => ({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  startBar: 17,
  endBar: 24,
  title: "渐强齐奏",
  status: "OPEN",
  assignees: [
    { memberId: members[0]!.id },
    { memberId: members[1]!.id },
    { memberId: members[2]!.id },
  ],
  checkins: [{ memberId: members[0]!.id, done: true }],
  ...overrides,
});

describe("summarizeBarTask", () => {
  it("counts only present assignees in the denominator", () => {
    const summary = summarizeBarTask(task(), [
      { memberId: members[0]!.id, status: "PRESENT" },
      { memberId: members[1]!.id, status: "PRESENT" },
      { memberId: members[2]!.id, status: "ABSENT" },
    ]);
    expect(summary.eligibleCount).toBe(2);
    expect(summary.confirmedCount).toBe(1);
    expect(summary.completionRatio).toBe(0.5);
    expect(summary.excludedAssignees).toEqual([
      { memberId: members[2]!.id, attendance: "ABSENT" },
    ]);
  });

  it("treats LATE as eligible but EXCUSED and UNKNOWN as excluded", () => {
    const summary = summarizeBarTask(task(), [
      { memberId: members[0]!.id, status: "LATE" },
      { memberId: members[1]!.id, status: "EXCUSED" },
      // members[2] 未点名 -> UNKNOWN
    ]);
    expect(summary.eligibleCount).toBe(1);
    expect(summary.confirmedCount).toBe(1);
    expect(summary.completionRatio).toBe(1);
    expect(summary.excludedAssignees.map((e) => e.attendance).sort()).toEqual(["EXCUSED", "UNKNOWN"]);
  });

  it("returns null instead of 0 or 1 when nobody eligible is present", () => {
    const summary = summarizeBarTask(task(), [
      { memberId: members[0]!.id, status: "ABSENT" },
      { memberId: members[1]!.id, status: "EXCUSED" },
    ]);
    expect(summary.eligibleCount).toBe(0);
    expect(summary.confirmedCount).toBe(0);
    expect(summary.completionRatio).toBeNull();
  });

  it("returns null for cancelled tasks even with confirmations", () => {
    const summary = summarizeBarTask(
      task({ status: "CANCELLED", checkins: [{ memberId: members[0]!.id, done: true }] }),
      [
        { memberId: members[0]!.id, status: "PRESENT" },
        { memberId: members[1]!.id, status: "PRESENT" },
      ],
    );
    expect(summary.completionRatio).toBeNull();
  });

  it("does not let a check-in from an absent member inflate completion", () => {
    const summary = summarizeBarTask(
      task({ checkins: [{ memberId: members[2]!.id, done: true }] }),
      [
        { memberId: members[0]!.id, status: "PRESENT" },
        { memberId: members[1]!.id, status: "PRESENT" },
        { memberId: members[2]!.id, status: "ABSENT" },
      ],
    );
    expect(summary.eligibleCount).toBe(2);
    expect(summary.confirmedCount).toBe(0);
    expect(summary.completionRatio).toBe(0);
  });
});

describe("buildRehearsalRollup", () => {
  it("aggregates parts, attendance and bar tasks in one pass", () => {
    const rollup = buildRehearsalRollup({
      members,
      attendance: [
        { memberId: members[0]!.id, status: "PRESENT" },
        { memberId: members[1]!.id, status: "LATE" },
        { memberId: members[2]!.id, status: "ABSENT" },
      ],
      barTasks: [
        task(),
        task({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", assignees: [], checkins: [] }),
      ],
    });
    // 停用成员不计入
    expect(rollup.totalMembers).toBe(3);
    expect(rollup.presentCount).toBe(1);
    expect(rollup.lateCount).toBe(1);
    expect(rollup.absentCount).toBe(1);
    expect(rollup.allPresent).toBe(false);
    expect(rollup.attendanceRatio).toBeCloseTo(2 / 3);
    // 第二个任务没有可统计成员 -> 整场完成度必须为 null 而不是只平均第一个
    expect(rollup.overallCompletionRatio).toBeNull();
  });

  it("reports unknown attendance separately and excludes it from the ratio", () => {
    const rollup = buildRehearsalRollup({
      members: members.slice(0, 2),
      attendance: [{ memberId: members[0]!.id, status: "PRESENT" }],
      barTasks: [],
    });
    expect(rollup.unknownCount).toBe(1);
    expect(rollup.attendanceRatio).toBe(1);
    expect(rollup.allPresent).toBe(false);
    expect(rollup.overallCompletionRatio).toBeNull();
  });

  it("returns null ratios before roll call starts", () => {
    const rollup = buildRehearsalRollup({ members: members.slice(0, 2), attendance: [], barTasks: [] });
    expect(rollup.attendanceRatio).toBeNull();
    expect(rollup.allPresent).toBe(false);
  });
});

describe("mergeOfflineValue", () => {
  const t1 = new Date("2026-10-03T10:00:00Z");
  const t2 = new Date("2026-10-03T10:05:00Z");

  it("inserts when nothing exists", () => {
    const incoming = { clientEventId: "evt-new-0001", occurredAt: t1, value: "PRESENT" as const };
    expect(mergeOfflineValue(null, incoming)).toBe(incoming);
  });

  it("treats the same clientEventId as an idempotent replay", () => {
    const existing = { clientEventId: "evt-same-001", occurredAt: t1, value: "PRESENT" as const };
    const replay = { clientEventId: "evt-same-001", occurredAt: t1, value: "ABSENT" as const };
    expect(mergeOfflineValue(existing, replay)).toBe(existing);
  });

  it("last-writer-wins by occurredAt across devices", () => {
    const existing = { clientEventId: "evt-device-a-1", occurredAt: t1, value: "PRESENT" as const };
    const incoming = { clientEventId: "evt-device-b-9", occurredAt: t2, value: "LATE" as const };
    expect(mergeOfflineValue(existing, incoming).value).toBe("LATE");
    expect(mergeOfflineValue(incoming, existing).value).toBe("LATE");
  });

  it("breaks timestamp ties deterministically via clientEventId", () => {
    const a = { clientEventId: "evt-aaaa", occurredAt: t1, value: "PRESENT" as const };
    const b = { clientEventId: "evt-bbbb", occurredAt: t1, value: "ABSENT" as const };
    expect(mergeOfflineValue(a, b).clientEventId).toBe("evt-bbbb");
    expect(mergeOfflineValue(b, a).clientEventId).toBe("evt-bbbb");
  });
});

describe("change notification fingerprint", () => {
  const base = {
    rehearsalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    kind: "ATTENDANCE_CHANGED" as const,
    targetMemberId: null,
    payload: { b: 2, a: 1, nested: { y: 2, x: 1 } },
  };

  it("is stable regardless of payload key order", () => {
    expect(buildChangeFingerprint(base)).toBe(
      buildChangeFingerprint({ ...base, payload: { nested: { x: 1, y: 2 }, a: 1, b: 2 } }),
    );
  });

  it("changes when any semantic field changes", () => {
    expect(buildChangeFingerprint(base)).not.toBe(
      buildChangeFingerprint({ ...base, payload: { ...base.payload, b: 3 } }),
    );
    expect(buildChangeFingerprint(base)).not.toBe(
      buildChangeFingerprint({ ...base, kind: "BAR_TASK_CONFIRMED" }),
    );
    expect(buildChangeFingerprint(base)).not.toBe(
      buildChangeFingerprint({ ...base, targetMemberId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }),
    );
  });

  it("isSameChange ignores version bumps on otherwise identical notifications", () => {
    const fp = buildChangeFingerprint(base);
    expect(
      isSameChange(
        { kind: base.kind, targetMemberId: null, payloadFingerprint: fp },
        { kind: base.kind, targetMemberId: null, payloadFingerprint: fp },
      ),
    ).toBe(true);
  });
});

describe("reduceOfflineSync", () => {
  const t = (ms: number) => new Date(ms);
  const memberA = "11111111-1111-4111-8111-111111111111";
  const memberB = "22222222-2222-4222-8222-222222222222";
  const bar1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("applies fresh events and reports them as effective", () => {
    const events: SyncEvent[] = [
      { op: "UPSERT_ATTENDANCE", clientEventId: "evt-att-0001", memberId: memberA, occurredAt: t(1000), value: { status: "PRESENT", note: null } },
      { op: "CONFIRM_BAR_TASK", clientEventId: "evt-chk-0001", barTaskId: bar1, memberId: memberA, occurredAt: t(2000), value: { done: true, note: "ok" } },
    ];
    const outcome = reduceOfflineSync(emptySyncState(), events);
    expect(outcome.applied).toEqual(["evt-att-0001", "evt-chk-0001"]);
    expect(outcome.replayed).toEqual([]);
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.effectiveAttendance).toEqual([{ memberId: memberA, status: "PRESENT" }]);
    expect(outcome.effectiveConfirmations).toEqual([{ barTaskId: bar1, memberId: memberA }]);
  });

  it("treats repeated clientEventIds as idempotent replays", () => {
    const state = emptySyncState();
    const events: SyncEvent[] = [
      { op: "UPSERT_ATTENDANCE", clientEventId: "evt-att-0002", memberId: memberA, occurredAt: t(1000), value: { status: "PRESENT", note: null } },
    ];
    const first = reduceOfflineSync(state, events);
    const second = reduceOfflineSync(first.state, [
      { op: "UPSERT_ATTENDANCE", clientEventId: "evt-att-0002", memberId: memberA, occurredAt: t(1000), value: { status: "ABSENT", note: "tampered" } },
    ]);
    expect(second.replayed).toEqual(["evt-att-0002"]);
    expect(second.applied).toEqual([]);
    expect(second.effectiveAttendance).toEqual([]);
    // 重放载荷被篡改也不影响已落库值
    expect(second.state.attendance.get(memberA)?.value.status).toBe("PRESENT");
  });

  it("merges concurrent writes last-writer-wins and reports the loser", () => {
    // 服务端先有设备 A 的较晚点名 ABSENT
    const server = reduceOfflineSync(emptySyncState(), [
      { op: "UPSERT_ATTENDANCE", clientEventId: "evt-device-A", memberId: memberA, occurredAt: t(5000), value: { status: "ABSENT", note: null } },
    ]).state;
    // 设备 B 离线时基于更早时间点写了 PRESENT
    const merged = reduceOfflineSync(server, [
      { op: "UPSERT_ATTENDANCE", clientEventId: "evt-device-B", memberId: memberA, occurredAt: t(3000), value: { status: "PRESENT", note: null } },
    ]);
    expect(merged.state.attendance.get(memberA)?.value.status).toBe("ABSENT");
    expect(merged.conflicts).toEqual([{ clientEventId: "evt-device-B", resolution: "KEPT_SERVER" }]);
    expect(merged.effectiveAttendance).toEqual([]);
  });

  it("a newer offline event overrides the server value (TOOK_LOCAL)", () => {
    const server = reduceOfflineSync(emptySyncState(), [
      { op: "UPSERT_ATTENDANCE", clientEventId: "evt-device-A", memberId: memberA, occurredAt: t(3000), value: { status: "PRESENT", note: null } },
    ]).state;
    const merged = reduceOfflineSync(server, [
      { op: "UPSERT_ATTENDANCE", clientEventId: "evt-device-B", memberId: memberA, occurredAt: t(9000), value: { status: "EXCUSED", note: "病假" } },
    ]);
    expect(merged.state.attendance.get(memberA)?.value.status).toBe("EXCUSED");
    expect(merged.conflicts[0]?.resolution).toBe("TOOK_LOCAL");
    expect(merged.effectiveAttendance).toEqual([{ memberId: memberA, status: "EXCUSED" }]);
  });

  it("does not treat unchecking (done=false) as a completion notification", () => {
    const server = reduceOfflineSync(emptySyncState(), [
      { op: "CONFIRM_BAR_TASK", clientEventId: "evt-chk-done", barTaskId: bar1, memberId: memberB, occurredAt: t(1000), value: { done: true, note: null } },
    ]).state;
    const merged = reduceOfflineSync(server, [
      { op: "CONFIRM_BAR_TASK", clientEventId: "evt-chk-undo", barTaskId: bar1, memberId: memberB, occurredAt: t(2000), value: { done: false, note: "改主意" } },
    ]);
    expect(merged.state.checkins.get(`${bar1}:${memberB}`)?.value.done).toBe(false);
    expect(merged.effectiveConfirmations).toEqual([]);
  });

  it("recognizes a replay even after its value was superseded by a newer event", () => {
    // 设备 A 先离线写 PRESENT
    const first = reduceOfflineSync(emptySyncState(), [
      { op: "UPSERT_ATTENDANCE", clientEventId: "evt-A-1", memberId: memberA, occurredAt: t(1000), value: { status: "PRESENT", note: null } },
    ]);
    // 点名员在更新设备上改为 ABSENT（胜出）
    const second = reduceOfflineSync(first.state, [
      { op: "UPSERT_ATTENDANCE", clientEventId: "evt-B-1", memberId: memberA, occurredAt: t(5000), value: { status: "ABSENT", note: null } },
    ]);
    expect(second.state.attendance.get(memberA)?.value.status).toBe("ABSENT");
    // 设备 A 网络恢复后重放它原来的 evt-A-1：必须识别为重放，绝不能回滚成 PRESENT
    const retry = reduceOfflineSync(second.state, [
      { op: "UPSERT_ATTENDANCE", clientEventId: "evt-A-1", memberId: memberA, occurredAt: t(1000), value: { status: "PRESENT", note: null } },
    ]);
    expect(retry.replayed).toEqual(["evt-A-1"]);
    expect(retry.applied).toEqual([]);
    expect(retry.conflicts).toEqual([]);
    expect(retry.state.attendance.get(memberA)?.value.status).toBe("ABSENT");
  });

  it("rejects duplicate event ids inside one batch", () => {
    const dup: SyncEvent[] = [
      { op: "UPSERT_ATTENDANCE", clientEventId: "evt-dup-00001", memberId: memberA, occurredAt: t(1), value: { status: "PRESENT", note: null } },
      { op: "UPSERT_ATTENDANCE", clientEventId: "evt-dup-00001", memberId: memberB, occurredAt: t(2), value: { status: "LATE", note: null } },
    ];
    expect(() => reduceOfflineSync(emptySyncState(), dup)).toThrow(/duplicate/);
  });

  it("does not mutate the previous state", () => {
    const previous = reduceOfflineSync(emptySyncState(), [
      { op: "UPSERT_ATTENDANCE", clientEventId: "evt-att-0010", memberId: memberA, occurredAt: t(1), value: { status: "PRESENT", note: null } },
    ]);
    const before = previous.state.attendance.get(memberA)?.clientEventId;
    reduceOfflineSync(previous.state, [
      { op: "UPSERT_ATTENDANCE", clientEventId: "evt-att-0011", memberId: memberA, occurredAt: t(9), value: { status: "LATE", note: null } },
    ]);
    expect(previous.state.attendance.get(memberA)?.clientEventId).toBe(before);
  });
});
