import { z } from "zod";

// ---------------------------------------------------------------------------
// 合奏排练协调：枚举
// ---------------------------------------------------------------------------

export const ENSEMBLE_MEMBER_ROLES = ["OWNER", "MEMBER"] as const;
export const ATTENDANCE_STATUSES = ["PRESENT", "LATE", "ABSENT", "EXCUSED", "UNKNOWN"] as const;
export const BAR_TASK_STATUSES = ["OPEN", "DONE", "CANCELLED"] as const;
export const REHEARSAL_CHANGE_KINDS = [
  "REHEARSAL_CREATED",
  "REHEARSAL_UPDATED",
  "REHEARSAL_CANCELLED",
  "ATTENDANCE_CHANGED",
  "BAR_TASK_CREATED",
  "BAR_TASK_UPDATED",
  "BAR_TASK_DELETED",
  "BAR_TASK_CONFIRMED",
] as const;
export const NOTIFICATION_DELIVERY_STATUSES = ["PENDING", "SENT", "READ"] as const;

export type EnsembleMemberRole = (typeof ENSEMBLE_MEMBER_ROLES)[number];
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
export type BarTaskStatus = (typeof BAR_TASK_STATUSES)[number];
export type RehearsalChangeKind = (typeof REHEARSAL_CHANGE_KINDS)[number];
export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

// 出席状态（可计入小节任务完成度）
export const PRESENT_ATTENDANCE: ReadonlySet<AttendanceStatus> = new Set(["PRESENT", "LATE"]);

// ---------------------------------------------------------------------------
// 请求约束
// ---------------------------------------------------------------------------

const requiredText = (label: string, max: number) =>
  z.string().trim().min(1, `${label}不能为空`).max(max, `${label}不能超过 ${max} 个字符`);
const optionalText = (max: number, label: string) =>
  z.string().trim().max(max, `${label}不能超过 ${max} 个字符`).optional().nullable();

export const ensembleCreateSchema = z.object({
  name: requiredText("合奏团名称", 120),
  description: optionalText(1000, "合奏团简介"),
});
export const ensembleUpdateSchema = z.object({
  name: requiredText("合奏团名称", 120).optional(),
  description: optionalText(1000, "合奏团简介"),
  version: z.coerce.number().int().nonnegative(),
});

export const memberInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email("邮箱格式不正确").max(254),
  part: requiredText("声部", 60),
  role: z.enum(ENSEMBLE_MEMBER_ROLES).default("MEMBER"),
});
export const memberUpdateSchema = z.object({
  part: optionalText(60, "声部"),
  role: z.enum(ENSEMBLE_MEMBER_ROLES).optional(),
  version: z.coerce.number().int().nonnegative(),
});
export const memberListQuerySchema = z.object({
  part: z.string().trim().max(60).optional(),
});

export const rehearsalCreateSchema = z.object({
  title: requiredText("排练标题", 120),
  scheduledStart: z.coerce.date(),
  scheduledEnd: z.coerce.date(),
  location: optionalText(120, "排练地点"),
  notes: optionalText(4000, "排练说明"),
}).refine((value) => value.scheduledEnd.getTime() > value.scheduledStart.getTime(), {
  path: ["scheduledEnd"],
  message: "结束时间必须晚于开始时间",
});
export const rehearsalUpdateSchema = z.object({
  title: requiredText("排练标题", 120).optional(),
  scheduledStart: z.coerce.date().optional(),
  scheduledEnd: z.coerce.date().optional(),
  location: optionalText(120, "排练地点"),
  notes: optionalText(4000, "排练说明"),
  version: z.coerce.number().int().nonnegative(),
});
export const rehearsalListQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  includePast: z.coerce.boolean().default(true),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const attendanceBulkSchema = z.object({
  /** 乐观锁：必须等于当前排练 version */
  version: z.coerce.number().int().nonnegative(),
  entries: z
    .array(
      z.object({
        memberId: z.string().uuid(),
        status: z.enum(ATTENDANCE_STATUSES),
        note: optionalText(500, "点名备注"),
        /** 幂等键：同一离线事件重放不得重复写入 */
        clientEventId: z.string().trim().min(8).max(80).optional(),
        /** 离线时基于的排练版本，用于冲突检测 */
        baseVersion: z.coerce.number().int().nonnegative().optional(),
      }),
    )
    .min(1)
    .max(200),
});

export const barTaskCreateSchema = z.object({
  startBar: z.coerce.number().int().min(1).max(10_000),
  endBar: z.coerce.number().int().min(1).max(10_000),
  title: requiredText("小节任务标题", 120),
  instruction: optionalText(2000, "演奏要求"),
  assigneeIds: z.array(z.string().uuid()).max(200).default([]),
}).refine((value) => value.endBar >= value.startBar, {
  path: ["endBar"],
  message: "结束小节不能小于开始小节",
});
export const barTaskUpdateSchema = z.object({
  startBar: z.coerce.number().int().min(1).max(10_000).optional(),
  endBar: z.coerce.number().int().min(1).max(10_000).optional(),
  title: requiredText("小节任务标题", 120).optional(),
  instruction: optionalText(2000, "演奏要求"),
  assigneeIds: z.array(z.string().uuid()).max(200).optional(),
  status: z.enum(BAR_TASK_STATUSES).optional(),
  version: z.coerce.number().int().nonnegative(),
});
export const barTaskConfirmSchema = z.object({
  memberId: z.string().uuid(),
  done: z.boolean(),
  note: optionalText(1000, "确认备注"),
  clientEventId: z.string().trim().min(8).max(80).optional(),
  baseVersion: z.coerce.number().int().nonnegative().optional(),
});

/** 离线批量同步：多条事件按顺序合并，任一事件非法时整批拒绝，不产生半写入 */
export const offlineSyncSchema = z.object({
  events: z
    .array(
      z.discriminatedUnion("op", [
        z.object({
          op: z.literal("UPSERT_ATTENDANCE"),
          clientEventId: z.string().trim().min(8).max(80),
          baseVersion: z.coerce.number().int().nonnegative(),
          memberId: z.string().uuid(),
          status: z.enum(ATTENDANCE_STATUSES),
          note: optionalText(500, "点名备注"),
          occurredAt: z.coerce.date().optional(),
        }),
        z.object({
          op: z.literal("CONFIRM_BAR_TASK"),
          clientEventId: z.string().trim().min(8).max(80),
          baseVersion: z.coerce.number().int().nonnegative(),
          barTaskId: z.string().uuid(),
          memberId: z.string().uuid(),
          done: z.boolean(),
          note: optionalText(1000, "确认备注"),
          occurredAt: z.coerce.date().optional(),
        }),
      ]),
    )
    .min(1)
    .max(500),
});

export const notificationListQuerySchema = z.object({
  rehearsalId: z.string().uuid().optional(),
  status: z.enum(NOTIFICATION_DELIVERY_STATUSES).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

// ---------------------------------------------------------------------------
// 领域纯函数
// ---------------------------------------------------------------------------

export interface AttendanceRow {
  memberId: string;
  status: AttendanceStatus;
}

export interface BarTaskAssignmentInput {
  id: string;
  startBar: number;
  endBar: number;
  title: string;
  status: BarTaskStatus;
  assignees: Array<{ memberId: string }>;
  checkins: Array<{ memberId: string; done: boolean }>;
}

export interface BarTaskProgress {
  id: string;
  startBar: number;
  endBar: number;
  title: string;
  status: BarTaskStatus;
  /** 被指派且实际出席（PRESENT/LATE）的成员数 —— 完成度唯一分母 */
  eligibleCount: number;
  /** 分母中已确认完成的成员数 */
  confirmedCount: number;
  /** 被指派但缺席/请假/未点名的成员，单独展示，绝不计入分母 */
  excludedAssignees: Array<{ memberId: string; attendance: AttendanceStatus }>;
  /**
   * 完成比例 [0,1]。分母为 0（没有任何可完成任务的出席成员）时为 null，
   * 调用方必须展示为“暂不可统计”，禁止当成 0 或 100。
   */
  completionRatio: number | null;
}

/**
 * 计算一个小节任务的完成度。
 *
 * 关键口径：缺席（ABSENT/EXCUSED）或尚未点名（UNKNOWN）的被指派人
 * 不进入分母，因此不会因为“人没来、没点确认”而被误算成未完成；
 * 也不会因为分母只数了来的人而虚高——取消的任务不参与统计。
 */
export function summarizeBarTask(
  task: BarTaskAssignmentInput,
  attendance: ReadonlyArray<AttendanceRow>,
): BarTaskProgress {
  const attendanceByMember = new Map(attendance.map((row) => [row.memberId, row.status]));
  let eligibleCount = 0;
  let confirmedCount = 0;
  const doneByMember = new Map(task.checkins.filter((c) => c.done).map((c) => [c.memberId, true]));
  const excludedAssignees: BarTaskProgress["excludedAssignees"] = [];

  for (const assignee of task.assignees) {
    const status = attendanceByMember.get(assignee.memberId) ?? "UNKNOWN";
    if (PRESENT_ATTENDANCE.has(status)) {
      eligibleCount += 1;
      if (doneByMember.has(assignee.memberId)) confirmedCount += 1;
    } else {
      excludedAssignees.push({ memberId: assignee.memberId, attendance: status });
    }
  }

  const cancelled = task.status === "CANCELLED";
  const completionRatio = cancelled || eligibleCount === 0 ? null : confirmedCount / eligibleCount;
  return {
    id: task.id,
    startBar: task.startBar,
    endBar: task.endBar,
    title: task.title,
    status: task.status,
    eligibleCount,
    confirmedCount,
    excludedAssignees,
    completionRatio,
  };
}

export interface RollupInput {
  members: Array<{ id: string; part: string | null; role: EnsembleMemberRole; active: boolean }>;
  attendance: ReadonlyArray<AttendanceRow>;
  barTasks: ReadonlyArray<BarTaskAssignmentInput>;
}

export interface RehearsalRollup {
  totalMembers: number;
  presentCount: number;
  lateCount: number;
  absentCount: number;
  excusedCount: number;
  unknownCount: number;
  /** 到齐率分母只含已知出勤状态的成员（UNKNOWN 不计入），无数据时为 null */
  attendanceRatio: number | null;
  allPresent: boolean;
  barTasks: BarTaskProgress[];
  /** 整场排练完成度：各小节任务等权平均；任一任务不可统计或任务为空时为 null */
  overallCompletionRatio: number | null;
}

/** 汇总成员声部、到齐状态与小节任务，供排练详情页一次展示。 */
export function buildRehearsalRollup(input: RollupInput): RehearsalRollup {
  const attendanceByMember = new Map(input.attendance.map((row) => [row.memberId, row.status]));
  let presentCount = 0;
  let lateCount = 0;
  let absentCount = 0;
  let excusedCount = 0;
  let unknownCount = 0;

  for (const member of input.members) {
    if (!member.active) continue;
    const status = attendanceByMember.get(member.id) ?? "UNKNOWN";
    if (status === "PRESENT") presentCount += 1;
    else if (status === "LATE") lateCount += 1;
    else if (status === "ABSENT") absentCount += 1;
    else if (status === "EXCUSED") excusedCount += 1;
    else unknownCount += 1;
  }

  const totalMembers = input.members.filter((m) => m.active).length;
  const knownCount = presentCount + lateCount + absentCount + excusedCount;
  const attendanceRatio = knownCount === 0 ? null : (presentCount + lateCount) / knownCount;

  const barTasks = input.barTasks.map((task) => summarizeBarTask(task, input.attendance));
  const measurable = barTasks.filter((task) => task.completionRatio !== null);
  const overallCompletionRatio =
    barTasks.length === 0 || measurable.length !== barTasks.length
      ? null
      : barTasks.reduce((sum, task) => sum + (task.completionRatio ?? 0), 0) / barTasks.length;

  return {
    totalMembers,
    presentCount,
    lateCount,
    absentCount,
    excusedCount,
    unknownCount,
    attendanceRatio,
    allPresent: totalMembers > 0 && presentCount + lateCount === totalMembers,
    barTasks,
    overallCompletionRatio,
  };
}

/**
 * 离线事件 last-writer-wins 合并。
 *
 * @param existing 服务端已持久化的值（及其来源事件时间戳）
 * @param incoming 离线设备上送的值
 * @returns 应当落库的值；重复事件（相同 clientEventId）由调用方提前短路，
 *          这里只解决“不同设备对同一对象更新”的冲突：时间戳更新者胜出，
 *          时间戳相同则比较 clientEventId 保证多端收敛到同一结果。
 */
export function mergeOfflineValue<T>(
  existing: { clientEventId: string; occurredAt: Date; value: T } | null,
  incoming: { clientEventId: string; occurredAt: Date; value: T },
): { clientEventId: string; occurredAt: Date; value: T } {
  if (!existing) return incoming;
  if (existing.clientEventId === incoming.clientEventId) return existing;
  const existingTime = existing.occurredAt.getTime();
  const incomingTime = incoming.occurredAt.getTime();
  if (incomingTime > existingTime) return incoming;
  if (incomingTime < existingTime) return existing;
  return incoming.clientEventId > existing.clientEventId ? incoming : existing;
}

// -- 离线事件批量归约（纯函数，供服务层事务与测试共享）-----------------------

export interface StampedValue<T> {
  clientEventId: string;
  occurredAt: Date;
  value: T;
}

export interface AttendanceValue {
  status: AttendanceStatus;
  note: string | null;
}

export interface CheckinValue {
  done: boolean;
  note: string | null;
}

export type SyncEvent =
  | {
      op: "UPSERT_ATTENDANCE";
      clientEventId: string;
      memberId: string;
      occurredAt: Date;
      value: AttendanceValue;
    }
  | {
      op: "CONFIRM_BAR_TASK";
      clientEventId: string;
      barTaskId: string;
      memberId: string;
      occurredAt: Date;
      value: CheckinValue;
    };

export interface OfflineSyncState {
  attendance: Map<string, StampedValue<AttendanceValue>>;
  checkins: Map<string, StampedValue<CheckinValue>>;
  /**
   * 所有已处理过的 clientEventId（含 LWW 落败者）。
   * 重放判定必须查这个全集而不是只看当前行的胜出 id，
   * 否则“先被更新事件覆盖、随后原事件重试”的边界场景会被当成新冲突。
   */
  processedEventIds: Set<string>;
}

export interface OfflineSyncOutcome {
  /** 合并后的完整状态（包含未受本批影响的既有值），直接用于落库 */
  state: OfflineSyncState;
  /** 非重放、参与了合并的事件（即使最终被 LWW 判负也算应用过） */
  applied: string[];
  /** 命中 clientEventId 去重、原样跳过的事件 */
  replayed: string[];
  /** 多端写同一对象时的冲突裁决明细 */
  conflicts: Array<{ clientEventId: string; resolution: "KEPT_SERVER" | "TOOK_LOCAL" }>;
  /** 真正改写了出勤状态的成员（只含胜出事件），用于发通知 */
  effectiveAttendance: Array<{ memberId: string; status: AttendanceStatus }>;
  /** 真正改写为“完成”的确认（只含胜出事件），用于发通知 */
  effectiveConfirmations: Array<{ barTaskId: string; memberId: string }>;
}

export function emptySyncState(): OfflineSyncState {
  return { attendance: new Map(), checkins: new Map(), processedEventIds: new Set() };
}

function checkinKey(barTaskId: string, memberId: string): string {
  return `${barTaskId}:${memberId}`;
}

/**
 * 将一批离线事件顺序归约进服务端当前状态：
 * - 同一 clientEventId 重放（无论它当前是胜出值还是已被更新事件覆盖）-> replayed，幂等跳过
 * - 不同设备同对象并发写 -> 按 occurredAt LWW，时间戳相同用 clientEventId 破平
 * - 所有非重放事件都进入 processedEventIds；只有胜出且语义生效的事件才进 effective* 列表（通知口径）
 */
export function reduceOfflineSync(previous: OfflineSyncState, events: SyncEvent[]): OfflineSyncOutcome {
  // 深拷贝，保证纯函数不修改入参
  const state: OfflineSyncState = {
    attendance: new Map(previous.attendance),
    checkins: new Map(previous.checkins),
    processedEventIds: new Set(previous.processedEventIds),
  };
  const outcome: OfflineSyncOutcome = {
    state,
    applied: [],
    replayed: [],
    conflicts: [],
    effectiveAttendance: [],
    effectiveConfirmations: [],
  };
  const seenInBatch = new Set<string>();

  for (const event of events) {
    if (seenInBatch.has(event.clientEventId)) {
      throw new Error(`duplicate clientEventId in batch: ${event.clientEventId}`);
    }
    seenInBatch.add(event.clientEventId);

    // 重放判定查全量已处理事件，而不是只看当前行的胜出 id
    if (state.processedEventIds.has(event.clientEventId)) {
      outcome.replayed.push(event.clientEventId);
      continue;
    }

    if (event.op === "UPSERT_ATTENDANCE") {
      const key = event.memberId;
      const existing = state.attendance.get(key) ?? null;
      const winner = mergeOfflineValue(existing, {
        clientEventId: event.clientEventId,
        occurredAt: event.occurredAt,
        value: event.value,
      });
      if (existing) {
        outcome.conflicts.push({
          clientEventId: event.clientEventId,
          resolution: winner.clientEventId === event.clientEventId ? "TOOK_LOCAL" : "KEPT_SERVER",
        });
      }
      state.attendance.set(key, winner);
      state.processedEventIds.add(event.clientEventId);
      outcome.applied.push(event.clientEventId);
      if (winner.clientEventId === event.clientEventId) {
        outcome.effectiveAttendance.push({ memberId: key, status: winner.value.status });
      }
    } else {
      const key = checkinKey(event.barTaskId, event.memberId);
      const existing = state.checkins.get(key) ?? null;
      const winner = mergeOfflineValue(existing, {
        clientEventId: event.clientEventId,
        occurredAt: event.occurredAt,
        value: event.value,
      });
      if (existing) {
        outcome.conflicts.push({
          clientEventId: event.clientEventId,
          resolution: winner.clientEventId === event.clientEventId ? "TOOK_LOCAL" : "KEPT_SERVER",
        });
      }
      state.checkins.set(key, winner);
      state.processedEventIds.add(event.clientEventId);
      outcome.applied.push(event.clientEventId);
      if (winner.clientEventId === event.clientEventId && winner.value.done) {
        outcome.effectiveConfirmations.push({ barTaskId: event.barTaskId, memberId: event.memberId });
      }
    }
  }

  return outcome;
}

/**
 * 构造变更通知指纹的规范化字符串（语义身份，不含版本号）。
 * 相同语义的重复通知必须生成相同指纹（字段顺序固定、无多余空白），
 * 由 SHA-256 后落库唯一约束，保证通知变更幂等；
 * 版本号仅作为快照字段随事件存储，用于增量同步游标。
 */
export function buildChangeFingerprint(input: {
  rehearsalId: string;
  kind: RehearsalChangeKind;
  targetMemberId: string | null;
  payload: unknown;
}): string {
  const canonical = JSON.stringify([
    input.rehearsalId,
    input.kind,
    input.targetMemberId ?? "",
    stableStringify(input.payload),
  ]);
  return canonical;
}

/** 通知是否与上一版本同语义（同 kind/target/负载），同语义则只移动游标不重复插入。 */
export function isSameChange(
  a: { kind: RehearsalChangeKind; targetMemberId: string | null; payloadFingerprint: string },
  b: { kind: RehearsalChangeKind; targetMemberId: string | null; payloadFingerprint: string },
): boolean {
  return a.kind === b.kind && a.targetMemberId === b.targetMemberId && a.payloadFingerprint === b.payloadFingerprint;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
