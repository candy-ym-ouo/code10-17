import { z } from "zod";

export const SESSION_STATUSES = [
  "DRAFT",
  "IN_REVIEW",
  "COMPLETED",
  "ARCHIVED",
  "DELETING",
  "DELETE_FAILED",
] as const;
export const MEDIA_STATUSES = [
  "PENDING_UPLOAD",
  "UPLOADING",
  "UPLOADED",
  "PROCESSING",
  "READY",
  "FAILED",
  "CANCELLED",
] as const;
export const ANNOTATION_TYPES = ["RHYTHM", "FINGERING", "EMOTION"] as const;
export const GOAL_CATEGORIES = [
  "RHYTHM",
  "FINGERING",
  "EMOTION",
  "CONTINUITY",
  "PITCH",
  "SPEED",
  "REPERTOIRE",
  "OTHER",
] as const;
export const METRIC_TYPES = [
  "DURATION",
  "COUNT",
  "SPEED",
  "ACCURACY",
  "SUBJECTIVE_SCORE",
  "CUSTOM",
] as const;
export const EVIDENCE_REQUIREMENTS = ["NONE", "AUDIO", "SELF_REVIEW", "AUDIO_AND_SELF_REVIEW"] as const;
export const GOAL_STATUSES = ["OPEN", "IN_PROGRESS", "ACHIEVED", "MISSED", "CANCELLED"] as const;

const requiredText = (label: string, max: number) =>
  z.string().trim().min(1, `${label}不能为空`).max(max, `${label}不能超过 ${max} 个字符`);
const optionalText = (max: number, label: string) =>
  z.string().trim().max(max, `${label}不能超过 ${max} 个字符`).optional().nullable();

export const emailSchema = z.string().trim().toLowerCase().email("邮箱格式不正确").max(254);
export const passwordSchema = z
  .string()
  .min(10, "密码至少 10 位")
  .max(128, "密码不能超过 128 位")
  .regex(/[A-Za-z]/, "密码必须包含字母")
  .regex(/[0-9]/, "密码必须包含数字");

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: requiredText("展示名", 80),
});
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "请输入密码").max(128),
});
export const updateProfileSchema = z.object({
  displayName: requiredText("展示名", 80).optional(),
  defaultInstrument: optionalText(60, "默认乐器"),
  timezone: z.string().trim().min(1).max(64).optional(),
  locale: z.string().trim().min(2).max(16).optional(),
});
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

export const sessionCreateSchema = z.object({
  title: requiredText("练习标题", 120),
  instrument: requiredText("乐器", 60),
  startedAt: z.coerce.date(),
  focus: optionalText(500, "本次重点"),
  location: optionalText(120, "练习地点"),
  notes: optionalText(5000, "总体备注"),
  actualDurationMs: z.coerce.number().int().positive().max(86_400_000).optional().nullable(),
});
export const sessionUpdateSchema = sessionCreateSchema
  .partial()
  .extend({ version: z.coerce.number().int().nonnegative() });
export const sessionBatchSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});
export const sessionListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum([...SESSION_STATUSES, "ALL"]).default("COMPLETED"),
  instrument: z.string().trim().max(60).optional(),
  annotationType: z.enum(ANNOTATION_TYPES).optional(),
  goalStatus: z.enum(GOAL_STATUSES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sortBy: z.enum(["startedAt", "actualDurationMs", "annotationCount", "updatedAt"]).default("startedAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const annotationCreateBaseSchema = z.object({
  mediaId: z.string().uuid(),
  type: z.enum(ANNOTATION_TYPES),
  severity: z.coerce.number().int().min(1).max(5),
  startMs: z.coerce.number().int().nonnegative(),
  endMs: z.coerce.number().int().positive(),
  title: requiredText("短标题", 80),
  description: optionalText(2000, "详细描述"),
  nextAction: optionalText(1000, "建议动作"),
});

export const annotationCreateSchema = annotationCreateBaseSchema
  .refine((value) => value.endMs > value.startMs, {
    path: ["endMs"],
    message: "结束时间必须晚于开始时间",
  })
  .refine((value) => value.endMs - value.startMs >= 100, {
    path: ["endMs"],
    message: "标记区间至少 100 毫秒",
  });
export const annotationUpdateSchema = annotationCreateBaseSchema.partial().omit({ mediaId: true });
export const annotationListQuerySchema = z.object({
  mediaId: z.string().uuid().optional(),
  type: z.enum(ANNOTATION_TYPES).optional(),
});

export const reviewDraftSchema = z.object({
  goodPoints: optionalText(3000, "做得好的地方"),
  mainIssues: optionalText(3000, "主要问题"),
  nextFocus: optionalText(500, "下次练习重点"),
  noIssues: z.boolean().default(false),
  suggestedNextPracticeAt: z.coerce.date().optional().nullable(),
});
export const reviewSaveSchema = reviewDraftSchema.extend({
  version: z.coerce.number().int().nonnegative(),
});

export const goalCreateSchema = z.object({
  sourceSessionId: z.string().uuid(),
  annotationId: z.string().uuid().optional().nullable(),
  title: requiredText("目标标题", 160),
  category: z.enum(GOAL_CATEGORIES),
  metricType: z.enum(METRIC_TYPES),
  baselineValue: z.coerce.number().finite().optional().nullable(),
  targetValue: z.coerce.number().finite(),
  unit: requiredText("单位", 24),
  dueDate: z.coerce.date(),
  method: optionalText(3000, "练习方法"),
  evidenceRequirement: z.enum(EVIDENCE_REQUIREMENTS),
});
export const goalUpdateSchema = goalCreateSchema
  .omit({ sourceSessionId: true })
  .partial()
  .extend({ version: z.coerce.number().int().nonnegative() });
export const goalListQuerySchema = z.object({
  status: z.enum(GOAL_STATUSES).optional(),
  category: z.enum(GOAL_CATEGORIES).optional(),
  instrument: z.string().trim().max(60).optional(),
  dueBefore: z.coerce.date().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const goalProgressCreateSchema = z.object({
  sessionId: z.string().uuid(),
  actualValue: z.coerce.number().finite(),
  note: optionalText(1000, "进度备注"),
  evidenceMediaId: z.string().uuid().optional().nullable(),
  recordedAt: z.coerce.date().optional(),
});
export const goalCancelSchema = z.object({ reason: requiredText("取消原因", 1000) });
export const goalActivateSchema = z.object({
  dueDate: z.coerce.date().optional(),
  targetValue: z.coerce.number().finite().optional(),
});

export const completionGoalProgressSchema = goalProgressCreateSchema.omit({ sessionId: true }).extend({
  goalId: z.string().uuid(),
});

export const completionSchema = z.object({
  version: z.coerce.number().int().nonnegative(),
  review: reviewDraftSchema.extend({ nextFocus: requiredText("下次练习重点", 500) }),
  goalCreates: z.array(goalCreateSchema.omit({ sourceSessionId: true })).default([]),
  goalProgressUpdates: z.array(completionGoalProgressSchema).default([]),
  annotationVersion: z.coerce.number().int().nonnegative().optional(),
});

export const statisticsRangeSchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  timezone: z.string().trim().min(1).max(64).default("Asia/Shanghai"),
  instrument: z.string().trim().max(60).optional(),
});

export const createExportSchema = z.object({
  format: z.enum(["json", "csv"]).default("json"),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// ---------------------------------------------------------------------------
// 合奏排练协调
// ---------------------------------------------------------------------------

export const ENSEMBLE_MEMBER_ROLES = ["OWNER", "CONDUCTOR", "MEMBER"] as const;
export const ATTENDANCE_STATUSES = ["PENDING", "CONFIRMED", "DECLINED", "PRESENT", "LATE", "ABSENT"] as const;
export const REHEARSAL_STATUSES = ["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
export const BAR_TASK_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "DONE", "SKIPPED"] as const;
export const REHEARSAL_NOTIFICATION_TYPES = [
  "REHEARSAL_CREATED",
  "REHEARSAL_UPDATED",
  "REHEARSAL_CANCELLED",
  "MEMBER_ADDED",
  "MEMBER_REMOVED",
  "ATTENDANCE_UPDATED",
  "BAR_TASK_ASSIGNED",
  "BAR_TASK_UPDATED",
] as const;
export const NOTIFICATION_STATUSES = ["UNREAD", "READ"] as const;

/** 排练开始前可由成员自行提交的回复；点名状态只能由组织者写入 */
export const SELF_ATTENDANCE_STATUSES = ["CONFIRMED", "DECLINED"] as const;
/** 实际到场状态 */
export const PRESENT_ATTENDANCE_STATUSES = ["PRESENT", "LATE"] as const;
/** 明确缺席（请假或点名缺席），其任务绝不能计入完成度分母 */
export const ABSENT_ATTENDANCE_STATUSES = ["ABSENT", "DECLINED"] as const;

export const ensembleCreateSchema = z.object({
  name: requiredText("合奏名称", 120),
  description: optionalText(2000, "合奏简介"),
});
export const ensembleUpdateSchema = ensembleCreateSchema
  .partial()
  .extend({ version: z.coerce.number().int().nonnegative() });

export const memberCreateSchema = z.object({
  displayName: requiredText("成员姓名", 80),
  instrument: requiredText("乐器", 60),
  part: requiredText("声部", 120),
  userId: z.string().uuid().optional().nullable(),
  role: z.enum(ENSEMBLE_MEMBER_ROLES).default("MEMBER"),
});
export const memberUpdateSchema = z.object({
  displayName: requiredText("成员姓名", 80).optional(),
  instrument: requiredText("乐器", 60).optional(),
  part: requiredText("声部", 120).optional(),
  role: z.enum(ENSEMBLE_MEMBER_ROLES).optional(),
  isActive: z.boolean().optional(),
  version: z.coerce.number().int().nonnegative(),
});

const rehearsalBaseSchema = z.object({
  title: requiredText("排练标题", 120),
  piece: optionalText(160, "曲目"),
  location: optionalText(120, "排练地点"),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  notes: optionalText(4000, "排练说明"),
});
export const rehearsalCreateSchema = rehearsalBaseSchema.refine((value) => value.endsAt > value.startsAt, {
  path: ["endsAt"],
  message: "结束时间必须晚于开始时间",
});
export const rehearsalUpdateSchema = rehearsalBaseSchema
  .partial()
  .extend({ version: z.coerce.number().int().nonnegative() })
  .refine((value) => value.startsAt === undefined || value.endsAt === undefined || value.endsAt > value.startsAt, {
    path: ["endsAt"],
    message: "结束时间必须晚于开始时间",
  });
export const rehearsalTransitionSchema = z.object({
  status: z.enum(REHEARSAL_STATUSES),
  version: z.coerce.number().int().nonnegative(),
});

export const idempotencyKeySchema = z.string().trim().min(8).max(80);

export const attendanceResponseSchema = z.object({
  status: z.enum(ATTENDANCE_STATUSES),
  note: optionalText(500, "回复备注"),
  // 离线客户端在本地生成回复的时刻；服务端按此时刻做 last-write-wins 合并
  clientUpdatedAt: z.coerce.date().optional(),
  respondedOffline: z.boolean().default(false),
});
export const attendanceBatchSchema = z.object({
  responses: z
    .array(
      z.object({
        memberId: z.string().uuid(),
        status: z.enum(ATTENDANCE_STATUSES),
        note: optionalText(500, "回复备注"),
        clientUpdatedAt: z.coerce.date().optional(),
        respondedOffline: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(200),
  clientUpdatedAt: z.coerce.date().optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const rollCallSchema = z.object({
  status: z.enum([...PRESENT_ATTENDANCE_STATUSES, "ABSENT"]),
  note: optionalText(500, "点名备注"),
  idempotencyKey: idempotencyKeySchema,
});

export const barTaskCreateSchema = z.object({
  startBar: z.coerce.number().int().min(1).max(10_000),
  endBar: z.coerce.number().int().min(1).max(10_000),
  title: requiredText("小节任务标题", 160),
  focus: optionalText(500, "练习重点"),
  assigneeId: z.string().uuid().optional().nullable(),
});
export const barTaskUpdateSchema = barTaskCreateSchema
  .partial()
  .extend({ version: z.coerce.number().int().nonnegative() })
  .refine((value) => value.startBar === undefined || value.endBar === undefined || value.endBar >= value.startBar, {
    path: ["endBar"],
    message: "结束小节不能小于开始小节",
  });
export const barTaskStatusSchema = z.object({
  status: z.enum(BAR_TASK_STATUSES),
  version: z.coerce.number().int().nonnegative(),
  idempotencyKey: idempotencyKeySchema,
});

export const notificationListQuerySchema = z.object({
  unreadOnly: z.coerce.boolean().default(false),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export type EnsembleMemberRole = (typeof ENSEMBLE_MEMBER_ROLES)[number];
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
export type RehearsalStatus = (typeof REHEARSAL_STATUSES)[number];
export type BarTaskStatus = (typeof BAR_TASK_STATUSES)[number];
export type RehearsalNotificationType = (typeof REHEARSAL_NOTIFICATION_TYPES)[number];

export const idSchema = z.string().uuid();

export type SessionStatus = (typeof SESSION_STATUSES)[number];
export type MediaStatus = (typeof MEDIA_STATUSES)[number];
export type AnnotationType = (typeof ANNOTATION_TYPES)[number];
export type GoalCategory = (typeof GOAL_CATEGORIES)[number];
export type MetricType = (typeof METRIC_TYPES)[number];
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export type EvidenceRequirement = (typeof EVIDENCE_REQUIREMENTS)[number];

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    traceId?: string;
  };
}

const allowedTransitions: Record<SessionStatus, SessionStatus[]> = {
  DRAFT: ["IN_REVIEW", "DELETING"],
  IN_REVIEW: ["DRAFT", "COMPLETED", "DELETING"],
  COMPLETED: ["ARCHIVED", "DELETING", "COMPLETED"],
  ARCHIVED: ["COMPLETED", "DELETING"],
  DELETING: ["DELETE_FAILED"],
  DELETE_FAILED: ["DELETING"],
};

export function canTransitionSession(from: SessionStatus, to: SessionStatus): boolean {
  return from === to || allowedTransitions[from].includes(to);
}

export function validateAnnotationRange(
  startMs: number,
  endMs: number,
  durationMs?: number | null,
): { ok: true } | { ok: false; code: string; message: string } {
  if (!Number.isInteger(startMs) || startMs < 0) {
    return { ok: false, code: "AUDIO_RANGE_INVALID", message: "开始时间必须是非负整数毫秒值" };
  }
  if (!Number.isInteger(endMs) || endMs <= startMs) {
    return { ok: false, code: "AUDIO_RANGE_INVALID", message: "结束时间必须晚于开始时间" };
  }
  if (endMs - startMs < 100) {
    return { ok: false, code: "AUDIO_RANGE_INVALID", message: "标记区间至少 100 毫秒" };
  }
  if (durationMs != null && endMs > durationMs) {
    return { ok: false, code: "AUDIO_RANGE_INVALID", message: "标记结束时间不能超出音频时长" };
  }
  return { ok: true };
}

export function isGoalProgressValid(actualValue: number, targetValue: number): boolean {
  return Number.isFinite(actualValue) && Number.isFinite(targetValue) && actualValue >= targetValue;
}

export function calculateSessionDuration(mediaDurationsMs: Array<number | null | undefined>): number {
  return mediaDurationsMs.reduce<number>((total, duration) => total + (duration && duration > 0 ? duration : 0), 0);
}

export function describeMissingReview(input: {
  readyMediaCount: number;
  annotationCount: number;
  noIssues: boolean;
  nextFocus?: string | null;
  openGoalCount: number;
  newGoalCount: number;
  progressUpdateCount: number;
}): string[] {
  const missing: string[] = [];
  if (input.readyMediaCount < 1) missing.push("至少需要一段已解析完成的音频");
  if (input.annotationCount < 1 && !input.noIssues) missing.push("请至少添加一个问题标记，或声明本次无异常");
  if (!input.nextFocus?.trim()) missing.push("请填写下次练习重点");
  if (input.openGoalCount < 1 && input.newGoalCount < 1) missing.push("请至少创建一个可执行目标");
  if (input.openGoalCount > 0 && input.progressUpdateCount < 1) {
    missing.push("已有未关闭目标时，本次至少记录一次目标进度");
  }
  return missing;
}

// ---------------------------------------------------------------------------
// 合奏排练：领域纯函数
// ---------------------------------------------------------------------------

export interface AttendanceMergeInput {
  status: AttendanceStatus;
  note?: string | null;
  /** 入站记录期望生效的时间（离线时刻 / 服务器时刻） */
  clientUpdatedAt?: Date | null;
  respondedOffline?: boolean;
}
export interface StoredAttendanceState extends AttendanceMergeInput {
  status: AttendanceStatus;
  note?: string | null;
  clientUpdatedAt?: Date | null;
  respondedOffline?: boolean;
  updatedAt?: Date | null;
}

const attendanceRank: Record<AttendanceStatus, number> = {
  PENDING: 0,
  CONFIRMED: 1,
  DECLINED: 1,
  PRESENT: 3,
  LATE: 3,
  ABSENT: 3,
};

function effectiveTime(state: StoredAttendanceState | AttendanceMergeInput): number {
  return new Date(state.clientUpdatedAt ?? 0).getTime();
}

/**
 * 合并到勤回复：
 * - 同一状态重复提交为幂等 no-op（服务端原始状态原样保留）。
 * - 默认 last-write-wins（按 clientUpdatedAt，离线确认因此不会覆盖较新的在线点名）。
 * - 已完成点名（PRESENT/LATE/ABSENT）后，普通成员回复（CONFIRMED/DECLINED/PENDING）
 *   不能再把实际到勤状态改回去——这是“缺席不能误算完成度”的状态机护栏。
 * - 点名状态之间允许按时间覆盖（迟到改到场、到场改缺席等纠偏场景）。
 */
export function mergeAttendance(
  current: StoredAttendanceState,
  incoming: AttendanceMergeInput,
  now: Date = new Date(),
): { merged: StoredAttendanceState; changed: boolean } {
  if (incoming.status === current.status) {
    return { merged: { ...current }, changed: false };
  }
  const currentRank = attendanceRank[current.status];
  const incomingRank = attendanceRank[incoming.status];
  if (currentRank >= 3 && incomingRank < 3) {
    return { merged: { ...current }, changed: false };
  }
  const incomingTime = effectiveTime(incoming) || now.getTime();
  const currentTime = effectiveTime(current) || (current.updatedAt ? new Date(current.updatedAt).getTime() : 0);
  if (incomingTime < currentTime) {
    return { merged: { ...current }, changed: false };
  }
  return {
    merged: {
      ...current,
      status: incoming.status,
      note: incoming.note ?? current.note ?? null,
      clientUpdatedAt: incoming.clientUpdatedAt ?? new Date(incomingTime),
      respondedOffline: incoming.respondedOffline ?? false,
    },
    changed: true,
  };
}

export interface RehearsalMember {
  id: string;
  displayName: string;
  instrument: string;
  part: string;
  isActive: boolean;
  attendance?: { status: AttendanceStatus; respondedOffline?: boolean } | null;
}

export interface RehearsalBarTask {
  id: string;
  startBar: number;
  endBar: number;
  title: string;
  status: BarTaskStatus;
  assigneeId?: string | null;
}

export interface MemberTaskSummary {
  memberId: string | null;
  displayName: string;
  part: string;
  instrument: string;
  attendanceStatus: AttendanceStatus;
  respondedOffline: boolean;
  assignedTotal: number;
  assignedBars: number;
  doneTotal: number;
  doneBars: number;
  /** 缺席且任务为 DONE —— 必须在排练前核实，不计入有效完成 */
  suspectDoneWhileAbsent: number;
}

export interface RehearsalSummary {
  memberCount: number;
  attendance: Record<AttendanceStatus, number> & {
    respondedOffline: number;
    presentTotal: number;
    missingTotal: number;
  };
  parts: Array<{ part: string; instrument: string; members: number; present: number; absent: number; pending: number }>;
  tasks: {
    total: number;
    done: number;
    inProgress: number;
    notStarted: number;
    skipped: number;
    totalBars: number;
    doneBars: number;
    /**
     * 完成度口径：只统计当场可核实的任务——
     * 明确缺席（ABSENT/DECLINED）成员名下的任务整体排除在分子分母之外，
     * 既不会因为缺席被算成“未完成”，缺席者自报 DONE 也不会抬高完成度。
     * SKIPPED 同样不计入分母。
     */
    accountableTotal: number;
    accountableDone: number;
    completionRate: number;
    barWeightedCompletionRate: number;
  };
  /** 点名缺失的成员：PENDING/CONFIRMED/DECLINED 都需要现场核实 */
  unresolvedMembers: string[];
  members: MemberTaskSummary[];
}

export function isAbsentStatus(status: AttendanceStatus): boolean {
  return (ABSENT_ATTENDANCE_STATUSES as readonly string[]).includes(status);
}

export function isPresentStatus(status: AttendanceStatus): boolean {
  return (PRESENT_ATTENDANCE_STATUSES as readonly string[]).includes(status);
}

/**
 * 汇总一次排练：成员声部、到齐状态与小节任务。
 * 缺席成员的任务不进入完成度口径，避免“缺席被误算成完成/未完成”。
 */
export function summarizeRehearsal(members: RehearsalMember[], tasks: RehearsalBarTask[]): RehearsalSummary {
  const activeMembers = members.filter((member) => member.isActive);
  const memberById = new Map(activeMembers.map((member) => [member.id, member]));

  const attendanceCounts = {
    PENDING: 0,
    CONFIRMED: 0,
    DECLINED: 0,
    PRESENT: 0,
    LATE: 0,
    ABSENT: 0,
  } as Record<AttendanceStatus, number>;
  let respondedOffline = 0;
  const unresolved: string[] = [];

  for (const member of activeMembers) {
    const status: AttendanceStatus = member.attendance?.status ?? "PENDING";
    attendanceCounts[status] += 1;
    if (member.attendance?.respondedOffline) respondedOffline += 1;
    if (!isPresentStatus(status) && status !== "ABSENT") unresolved.push(member.id);
  }

  const partMap = new Map<string, { part: string; instrument: string; members: number; present: number; absent: number; pending: number }>();
  for (const member of activeMembers) {
    const key = `${member.part}::${member.instrument}`;
    const entry = partMap.get(key) ?? { part: member.part, instrument: member.instrument, members: 0, present: 0, absent: 0, pending: 0 };
    const status = member.attendance?.status ?? "PENDING";
    entry.members += 1;
    if (isPresentStatus(status)) entry.present += 1;
    if (isAbsentStatus(status)) entry.absent += 1;
    if (status === "PENDING") entry.pending += 1;
    partMap.set(key, entry);
  }

  const perMember = new Map<string, MemberTaskSummary>();
  const placeholder: MemberTaskSummary = {
    memberId: null,
    displayName: "未分配",
    part: "-",
    instrument: "-",
    attendanceStatus: "PENDING",
    respondedOffline: false,
    assignedTotal: 0,
    assignedBars: 0,
    doneTotal: 0,
    doneBars: 0,
    suspectDoneWhileAbsent: 0,
  };

  let done = 0;
  let inProgress = 0;
  let notStarted = 0;
  let skipped = 0;
  let totalBars = 0;
  let doneBars = 0;
  let accountableTotal = 0;
  let accountableDone = 0;
  let accountableTotalBars = 0;
  let accountableDoneBars = 0;

  for (const task of tasks) {
    const bars = Math.max(0, task.endBar - task.startBar + 1);
    totalBars += bars;
    if (task.status === "DONE") done += 1;
    if (task.status === "IN_PROGRESS") inProgress += 1;
    if (task.status === "NOT_STARTED") notStarted += 1;
    if (task.status === "SKIPPED") skipped += 1;
    if (task.status === "DONE") doneBars += bars;

    const assignee = task.assigneeId ? memberById.get(task.assigneeId) : undefined;
    const assigneeStatus: AttendanceStatus = assignee?.attendance?.status ?? "PENDING";
    const assigneeAbsent = assignee ? isAbsentStatus(assigneeStatus) : false;
    const key = assignee?.id ?? "__unassigned__";
    let row = perMember.get(key);
    if (!row) {
      row = assignee
        ? {
            memberId: assignee.id,
            displayName: assignee.displayName,
            part: assignee.part,
            instrument: assignee.instrument,
            attendanceStatus: assigneeStatus,
            respondedOffline: assignee.attendance?.respondedOffline ?? false,
            assignedTotal: 0,
            assignedBars: 0,
            doneTotal: 0,
            doneBars: 0,
            suspectDoneWhileAbsent: 0,
          }
        : { ...placeholder };
      perMember.set(key, row);
    }
    row.assignedTotal += 1;
    row.assignedBars += bars;
    if (task.status === "DONE") {
      row.doneTotal += 1;
      row.doneBars += bars;
      if (assigneeAbsent) row.suspectDoneWhileAbsent += 1;
    }

    // 完成度：缺席成员的任务与 SKIPPED 任务一律不进口径
    if (!assigneeAbsent && task.status !== "SKIPPED") {
      accountableTotal += 1;
      accountableTotalBars += bars;
      if (task.status === "DONE") {
        accountableDone += 1;
        accountableDoneBars += bars;
      }
    }
  }

  // 没有任务的成员也出现在明细里
  for (const member of activeMembers) {
    if (!perMember.has(member.id)) {
      perMember.set(member.id, {
        memberId: member.id,
        displayName: member.displayName,
        part: member.part,
        instrument: member.instrument,
        attendanceStatus: member.attendance?.status ?? "PENDING",
        respondedOffline: member.attendance?.respondedOffline ?? false,
        assignedTotal: 0,
        assignedBars: 0,
        doneTotal: 0,
        doneBars: 0,
        suspectDoneWhileAbsent: 0,
      });
    }
  }

  const presentTotal = attendanceCounts.PRESENT + attendanceCounts.LATE;
  return {
    memberCount: activeMembers.length,
    attendance: {
      ...attendanceCounts,
      respondedOffline,
      presentTotal,
      missingTotal: activeMembers.length - presentTotal,
    },
    parts: [...partMap.values()].sort((a, b) => a.part.localeCompare(b.part, "zh-Hans-CN")),
    tasks: {
      total: tasks.length,
      done,
      inProgress,
      notStarted,
      skipped,
      totalBars,
      doneBars,
      accountableTotal,
      accountableDone,
      completionRate: accountableTotal === 0 ? 0 : accountableDone / accountableTotal,
      barWeightedCompletionRate: accountableTotalBars === 0 ? 0 : accountableDoneBars / accountableTotalBars,
    },
    unresolvedMembers: unresolved,
    members: [...perMember.values()].sort((a, b) => b.assignedTotal - a.assignedTotal || a.displayName.localeCompare(b.displayName, "zh-Hans-CN")),
  };
}

/**
 * 通知幂等键：同一 (排练, 变更类型, 变更实体, 变更序号) 只发一次。
 * 重复提交（重试、双击、离线回放）携带相同内容哈希时命中唯一约束，绝不重复通知。
 */
export function buildNotificationDedupeKey(input: {
  rehearsalId: string;
  type: RehearsalNotificationType;
  entityId?: string | null;
  /** 内容指纹：参与字段排序序列化后的短哈希，内容不变则不重复通知 */
  contentHash: string;
}): string {
  const entity = input.entityId ?? "rehearsal";
  return `${input.rehearsalId}:${input.type}:${entity}:${input.contentHash}`.slice(0, 160);
}

/** 稳定的内容指纹（FNV-1a 32 位，无第三方依赖） */
export function stableContentHash(value: unknown): string {
  const json = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

/** 排练状态机允许的迁移 */
const rehearsalTransitions: Record<RehearsalStatus, RehearsalStatus[]> = {
  SCHEDULED: ["IN_PROGRESS", "CANCELLED", "SCHEDULED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED", "IN_PROGRESS"],
  COMPLETED: ["IN_PROGRESS", "COMPLETED"],
  CANCELLED: ["SCHEDULED", "CANCELLED"],
};

export function canTransitionRehearsal(from: RehearsalStatus, to: RehearsalStatus): boolean {
  return from === to || rehearsalTransitions[from].includes(to);
}
