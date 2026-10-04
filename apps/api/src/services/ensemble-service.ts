import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  buildChangeFingerprint,
  buildRehearsalRollup,
  emptySyncState,
  mergeOfflineValue,
  reduceOfflineSync,
  type AttendanceStatus,
  type BarTaskStatus,
  type EnsembleMemberRole,
  type RehearsalChangeKind,
  type RehearsalRollup,
} from "@practice/contracts";
import { AppError, forbidden, notFound } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";

// ---------------------------------------------------------------------------
// 访问控制
// ---------------------------------------------------------------------------

export async function getMembership(
  userId: string,
  ensembleId: string,
): Promise<{ id: string; userId: string; part: string | null; role: EnsembleMemberRole; active: boolean; ensembleId: string }> {
  const membership = await prisma.ensembleMember.findUnique({
    where: { ensembleId_userId: { ensembleId, userId } },
    select: { id: true, userId: true, part: true, role: true, active: true, ensembleId: true },
  });
  if (!membership || !membership.active) throw notFound();
  return membership;
}

async function getRehearsalWithEnsemble(rehearsalId: string) {
  const rehearsal = await prisma.rehearsal.findUnique({
    where: { id: rehearsalId },
    select: {
      id: true,
      ensembleId: true,
      title: true,
      scheduledStart: true,
      scheduledEnd: true,
      location: true,
      notes: true,
      version: true,
      cancelledAt: true,
    },
  });
  if (!rehearsal) throw notFound();
  return rehearsal;
}

async function getRehearsalForUser(userId: string, rehearsalId: string) {
  const rehearsal = await getRehearsalWithEnsemble(rehearsalId);
  const membership = await getMembership(userId, rehearsal.ensembleId);
  return { rehearsal, membership };
}

function requireOwner(membership: { role: EnsembleMemberRole }): void {
  if (membership.role !== "OWNER") throw forbidden();
}

function assertVersion(current: number, provided: number, message = "排练已在其他设备被修改，请刷新后合并"): void {
  if (current !== provided) throw new AppError(409, "VERSION_CONFLICT", message);
}

// ---------------------------------------------------------------------------
// 合奏团与成员
// ---------------------------------------------------------------------------

export async function createEnsemble(
  userId: string,
  input: { name: string; description?: string | null },
) {
  return prisma.$transaction(async (tx) => {
    const ensemble = await tx.ensemble.create({
      data: {
        ownerId: userId,
        name: input.name,
        description: input.description ?? null,
        members: {
          create: { userId, role: "OWNER", part: null },
        },
      },
      include: ensembleSummaryInclude,
    });
    return ensemble;
  });
}

export async function listEnsembles(userId: string) {
  return prisma.ensemble.findMany({
    where: { members: { some: { userId, active: true } } },
    orderBy: { updatedAt: "desc" },
    include: {
      _count: { select: { members: { where: { active: true } }, rehearsals: true } },
    },
  });
}

export async function getEnsemble(userId: string, ensembleId: string) {
  await getMembership(userId, ensembleId);
  const ensemble = await prisma.ensemble.findUnique({ where: { id: ensembleId }, include: ensembleSummaryInclude });
  if (!ensemble) throw notFound();
  return ensemble;
}

export async function updateEnsemble(
  userId: string,
  ensembleId: string,
  input: { name?: string; description?: string | null; version: number },
) {
  const membership = await getMembership(userId, ensembleId);
  requireOwner(membership);
  const result = await prisma.ensemble.updateMany({
    where: { id: ensembleId, version: input.version },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      version: { increment: 1 },
    },
  });
  if (result.count !== 1) throw new AppError(409, "VERSION_CONFLICT", "合奏团信息已在其他窗口被修改");
  return getEnsemble(userId, ensembleId);
}

const ensembleSummaryInclude = {
  members: {
    where: { active: true },
    orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
    include: { user: { select: { id: true, displayName: true, defaultInstrument: true } } },
  },
} satisfies Prisma.EnsembleInclude;

export async function listMembers(userId: string, ensembleId: string, part?: string) {
  await getMembership(userId, ensembleId);
  return prisma.ensembleMember.findMany({
    where: { ensembleId, active: true, ...(part ? { part: { equals: part, mode: "insensitive" } } : {}) },
    orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
    include: { user: { select: { id: true, displayName: true, defaultInstrument: true } } },
  });
}

export async function inviteMember(
  userId: string,
  ensembleId: string,
  input: { email: string; part: string; role: EnsembleMemberRole },
) {
  const membership = await getMembership(userId, ensembleId);
  requireOwner(membership);
  const invitee = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });
  if (!invitee) throw new AppError(404, "USER_NOT_FOUND", "该邮箱尚未注册，邀请对象需要先拥有账号");
  const existing = await prisma.ensembleMember.findUnique({
    where: { ensembleId_userId: { ensembleId, userId: invitee.id } },
  });
  if (existing?.active) throw new AppError(409, "MEMBER_EXISTS", "该成员已在合奏团中");
  if (existing) throw new AppError(409, "MEMBER_INACTIVE", "该成员曾被移出，请先恢复其成员身份");
  return prisma.ensembleMember.create({
    data: { ensembleId, userId: invitee.id, part: input.part, role: input.role },
    include: { user: { select: { id: true, displayName: true, defaultInstrument: true } } },
  });
}

export async function updateMember(
  userId: string,
  ensembleId: string,
  memberId: string,
  input: { part?: string | null; role?: EnsembleMemberRole; version: number },
) {
  const membership = await getMembership(userId, ensembleId);
  requireOwner(membership);
  if (input.role && memberId === membership.id && input.role !== "OWNER") {
    throw new AppError(400, "VALIDATION_ERROR", "不能降低自己的团长身份");
  }
  const result = await prisma.ensembleMember.updateMany({
    where: { id: memberId, ensembleId, active: true, version: input.version },
    data: {
      ...(input.part === undefined ? {} : { part: input.part }),
      ...(input.role === undefined ? {} : { role: input.role }),
      version: { increment: 1 },
    },
  });
  if (result.count !== 1) throw new AppError(409, "VERSION_CONFLICT", "成员信息已在其他窗口被修改");
  return prisma.ensembleMember.findUniqueOrThrow({
    where: { id: memberId },
    include: { user: { select: { id: true, displayName: true, defaultInstrument: true } } },
  });
}

export async function removeMember(userId: string, ensembleId: string, memberId: string) {
  const membership = await getMembership(userId, ensembleId);
  requireOwner(membership);
  if (memberId === membership.id) throw new AppError(400, "VALIDATION_ERROR", "团长不能移除自己，请先转让合奏团");
  const result = await prisma.ensembleMember.updateMany({
    where: { id: memberId, ensembleId, active: true },
    data: { active: false, version: { increment: 1 } },
  });
  if (result.count !== 1) throw notFound();
  return { success: true as const };
}

// ---------------------------------------------------------------------------
// 排练
// ---------------------------------------------------------------------------

export async function createRehearsal(
  userId: string,
  ensembleId: string,
  input: { title: string; scheduledStart: Date; scheduledEnd: Date; location?: string | null; notes?: string | null },
) {
  const membership = await getMembership(userId, ensembleId);
  requireOwner(membership);
  const rehearsal = await prisma.rehearsal.create({
    data: {
      ensembleId,
      title: input.title,
      scheduledStart: input.scheduledStart,
      scheduledEnd: input.scheduledEnd,
      location: input.location ?? null,
      notes: input.notes ?? null,
    },
  });
  await recordChangeEvent(
    rehearsal.id,
    membership.id,
    "REHEARSAL_CREATED",
    { title: rehearsal.title, scheduledStart: rehearsal.scheduledStart, scheduledEnd: rehearsal.scheduledEnd },
    rehearsal.version,
  );
  return getRehearsalDetail(userId, rehearsal.id);
}

export async function listRehearsals(
  userId: string,
  ensembleId: string,
  query: { from?: Date; to?: Date; includePast: boolean; cursor?: string; limit: number },
) {
  await getMembership(userId, ensembleId);
  const now = new Date();
  const rows = await prisma.rehearsal.findMany({
    where: {
      ensembleId,
      cancelledAt: null,
      ...(query.from || query.to
        ? { scheduledStart: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
      ...(!query.includePast ? { scheduledEnd: { gte: now } } : {}),
    },
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    orderBy: { scheduledStart: "desc" },
    select: { id: true, title: true, scheduledStart: true, scheduledEnd: true, location: true, version: true },
  });
  const hasMore = rows.length > query.limit;
  const data = hasMore ? rows.slice(0, query.limit) : rows;
  return { data, nextCursor: hasMore ? data.at(-1)?.id ?? null : null };
}

export async function updateRehearsal(
  userId: string,
  rehearsalId: string,
  input: {
    title?: string;
    scheduledStart?: Date;
    scheduledEnd?: Date;
    location?: string | null;
    notes?: string | null;
    version: number;
  },
) {
  const { rehearsal, membership } = await getRehearsalForUser(userId, rehearsalId);
  requireOwner(membership);
  assertVersion(rehearsal.version, input.version);
  const nextStart = input.scheduledStart ?? rehearsal.scheduledStart;
  const nextEnd = input.scheduledEnd ?? rehearsal.scheduledEnd;
  if (!(nextEnd instanceof Date) || !(nextStart instanceof Date) || nextEnd <= nextStart) {
    throw new AppError(400, "VALIDATION_ERROR", "结束时间必须晚于开始时间");
  }
  const updated = await prisma.$transaction(async (tx) => {
    const rows = await tx.rehearsal.updateMany({
      where: { id: rehearsalId, version: input.version },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.scheduledStart === undefined ? {} : { scheduledStart: input.scheduledStart }),
        ...(input.scheduledEnd === undefined ? {} : { scheduledEnd: input.scheduledEnd }),
        ...(input.location === undefined ? {} : { location: input.location }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        version: { increment: 1 },
      },
    });
    if (rows.count !== 1) throw new AppError(409, "VERSION_CONFLICT", "排练已在其他设备被修改，请刷新后合并");
    return tx.rehearsal.findUniqueOrThrow({ where: { id: rehearsalId } });
  });
  await recordChangeEvent(
    rehearsalId,
    membership.id,
    "REHEARSAL_UPDATED",
    {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.scheduledStart === undefined ? {} : { scheduledStart: input.scheduledStart }),
      ...(input.scheduledEnd === undefined ? {} : { scheduledEnd: input.scheduledEnd }),
      ...(input.location === undefined ? {} : { location: input.location }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    },
    updated.version,
  );
  return getRehearsalDetail(userId, rehearsalId);
}

export async function cancelRehearsal(userId: string, rehearsalId: string, version: number) {
  const { rehearsal, membership } = await getRehearsalForUser(userId, rehearsalId);
  requireOwner(membership);
  assertVersion(rehearsal.version, version);
  if (rehearsal.cancelledAt) throw new AppError(409, "INVALID_REHEARSAL_STATE", "排练已取消");
  const updated = await prisma.$transaction(async (tx) => {
    const rows = await tx.rehearsal.updateMany({
      where: { id: rehearsalId, version, cancelledAt: null },
      data: { cancelledAt: new Date(), version: { increment: 1 } },
    });
    if (rows.count !== 1) throw new AppError(409, "VERSION_CONFLICT", "排练已在其他设备被修改，请刷新后合并");
    return tx.rehearsal.findUniqueOrThrow({ where: { id: rehearsalId } });
  });
  await recordChangeEvent(rehearsalId, membership.id, "REHEARSAL_CANCELLED", { cancelledAt: updated.cancelledAt }, updated.version);
  return { success: true as const, version: updated.version };
}

// ---------------------------------------------------------------------------
// 汇总：声部 + 到齐 + 小节任务
// ---------------------------------------------------------------------------

export async function getRehearsalDetail(userId: string, rehearsalId: string) {
  const { rehearsal } = await getRehearsalForUser(userId, rehearsalId);
  const [ensemble, members, attendanceRows, barTasks] = await Promise.all([
    prisma.ensemble.findUniqueOrThrow({
      where: { id: rehearsal.ensembleId },
      select: { id: true, name: true },
    }),
    prisma.ensembleMember.findMany({
      where: { ensembleId: rehearsal.ensembleId, active: true },
      orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
      include: { user: { select: { displayName: true, defaultInstrument: true } } },
    }),
    prisma.rehearsalAttendance.findMany({ where: { rehearsalId } }),
    prisma.barTask.findMany({
      where: { rehearsalId },
      orderBy: [{ startBar: "asc" }, { createdAt: "asc" }],
      include: {
        assignees: { select: { memberId: true } },
        checkins: { select: { memberId: true, done: true, note: true, occurredAt: true } },
      },
    }),
  ]);

  const rollup: RehearsalRollup = buildRehearsalRollup({
    members: members.map((m) => ({ id: m.id, part: m.part, role: m.role, active: m.active })),
    attendance: attendanceRows.map((a) => ({ memberId: a.memberId, status: a.status })),
    barTasks: barTasks.map((t) => ({
      id: t.id,
      startBar: t.startBar,
      endBar: t.endBar,
      title: t.title,
      status: t.status,
      assignees: t.assignees.map((a) => ({ memberId: a.memberId })),
      checkins: t.checkins.map((c) => ({ memberId: c.memberId, done: c.done })),
    })),
  });

  return {
    rehearsal: {
      ...rehearsal,
      ensembleName: ensemble.name,
    },
    members: members.map((m) => ({
      id: m.id,
      userId: m.userId,
      part: m.part,
      role: m.role,
      displayName: m.user.displayName,
      defaultInstrument: m.user.defaultInstrument,
      attendance: (attendanceRows.find((a) => a.memberId === m.id)?.status ?? "UNKNOWN") as AttendanceStatus,
      attendanceNote: attendanceRows.find((a) => a.memberId === m.id)?.note ?? null,
    })),
    barTasks: barTasks.map((t) => {
      const progress = rollup.barTasks.find((b) => b.id === t.id)!;
      return {
        id: t.id,
        startBar: t.startBar,
        endBar: t.endBar,
        title: t.title,
        instruction: t.instruction,
        status: t.status,
        version: t.version,
        assignees: t.assignees.map((a) => a.memberId),
        checkins: t.checkins,
        progress,
      };
    }),
    rollup,
  };
}

// ---------------------------------------------------------------------------
// 点名（在线批量）
// ---------------------------------------------------------------------------

export async function setAttendanceBulk(
  userId: string,
  rehearsalId: string,
  input: {
    version: number;
    entries: Array<{
      memberId: string;
      status: AttendanceStatus;
      note?: string | null;
      clientEventId?: string;
      baseVersion?: number;
      occurredAt?: Date;
    }>;
  },
  options: { idempotencyKey?: string } = {},
) {
  const { rehearsal, membership } = await getRehearsalForUser(userId, rehearsalId);
  assertVersion(rehearsal.version, input.version);
  await assertMembersBelong(rehearsal.ensembleId, input.entries.map((e) => e.memberId));

  const changed: Array<{ memberId: string; status: AttendanceStatus }> = [];
  let replayed = 0;

  await prisma.$transaction(async (tx) => {
    for (const entry of input.entries) {
      // 离线事件重放：账本里有过该事件（即使其值已被更新事件覆盖）即幂等短路
      if (entry.clientEventId) {
        const seen = await tx.rehearsalProcessedEvent.findUnique({
          where: { rehearsalId_clientEventId: { rehearsalId, clientEventId: entry.clientEventId } },
          select: { id: true },
        });
        if (seen) {
          replayed += 1;
          continue;
        }
      }

      const existing = await tx.rehearsalAttendance.findUnique({
        where: { rehearsalId_memberId: { rehearsalId, memberId: entry.memberId } },
      });
      const occurredAt = entry.occurredAt ?? new Date();
      const incoming = {
        clientEventId: entry.clientEventId ?? `bulk-${occurredAt.getTime()}-${entry.memberId}`,
        occurredAt,
        value: { status: entry.status, note: entry.note ?? null },
      };
      const winner = existing
        ? mergeOfflineValue(
            {
              clientEventId: existing.clientEventId ?? `server-${existing.id}`,
              occurredAt: existing.occurredAt,
              value: { status: existing.status, note: existing.note },
            },
            incoming,
          )
        : incoming;
      const takesEffect = winner.clientEventId === incoming.clientEventId;

      await tx.rehearsalAttendance.upsert({
        where: { rehearsalId_memberId: { rehearsalId, memberId: entry.memberId } },
        create: {
          rehearsalId,
          memberId: entry.memberId,
          status: winner.value.status,
          note: winner.value.note,
          clientEventId: entry.clientEventId ?? null,
          occurredAt: winner.occurredAt,
        },
        update: {
          status: winner.value.status,
          note: winner.value.note,
          occurredAt: winner.occurredAt,
          // 本地事件胜出才接管幂等键；保留服务端值时绝不能顶掉原键
          ...(takesEffect && entry.clientEventId ? { clientEventId: entry.clientEventId } : {}),
        },
      });
      // 无论该事件最终胜出还是被 LWW 判负，都记入账本，防止旧设备重试复活过期值
      if (entry.clientEventId) {
        await tx.rehearsalProcessedEvent.create({
          data: { rehearsalId, clientEventId: entry.clientEventId, kind: "ATTENDANCE_CHANGED" },
        });
      }
      if (takesEffect) changed.push({ memberId: entry.memberId, status: winner.value.status });
    }

    if (changed.length > 0) {
      const bumped = await tx.rehearsal.updateMany({
        where: { id: rehearsalId, version: input.version },
        data: { version: { increment: 1 } },
      });
      if (bumped.count !== 1) {
        throw new AppError(409, "VERSION_CONFLICT", "排练已在其他设备被修改，请刷新后合并");
      }
    }
  });

  // 只有真正写入新值才发通知；纯重放 / 被 LWW 丢弃的过期事件不得打扰成员
  if (changed.length > 0) {
    await recordChangeEvent(
      rehearsalId,
      membership.id,
      "ATTENDANCE_CHANGED",
      { entries: changed, replayedCount: replayed },
      rehearsal.version + 1,
      { idempotencyKey: options.idempotencyKey },
    );
  }
  return getRehearsalDetail(userId, rehearsalId);
}

// ---------------------------------------------------------------------------
// 小节任务
// ---------------------------------------------------------------------------

export async function createBarTask(
  userId: string,
  rehearsalId: string,
  input: { startBar: number; endBar: number; title: string; instruction?: string | null; assigneeIds: string[] },
) {
  const { rehearsal, membership } = await getRehearsalForUser(userId, rehearsalId);
  requireOwner(membership);
  if (rehearsal.cancelledAt) throw new AppError(409, "INVALID_REHEARSAL_STATE", "排练已取消，不能新增小节任务");
  await assertMembersBelong(rehearsal.ensembleId, input.assigneeIds);
  const task = await prisma.barTask.create({
    data: {
      rehearsalId,
      startBar: input.startBar,
      endBar: input.endBar,
      title: input.title,
      instruction: input.instruction ?? null,
      assignees: { create: input.assigneeIds.map((memberId) => ({ memberId })) },
    },
  });
  await recordChangeEvent(
    rehearsalId,
    membership.id,
    "BAR_TASK_CREATED",
    { barTaskId: task.id, startBar: task.startBar, endBar: task.endBar, title: task.title, assigneeIds: input.assigneeIds },
    rehearsal.version,
  );
  return getRehearsalDetail(userId, rehearsalId);
}

export async function updateBarTask(
  userId: string,
  barTaskId: string,
  input: {
    startBar?: number;
    endBar?: number;
    title?: string;
    instruction?: string | null;
    assigneeIds?: string[];
    status?: BarTaskStatus;
    version: number;
  },
) {
  const task = await prisma.barTask.findUnique({
    where: { id: barTaskId },
    select: {
      id: true,
      rehearsalId: true,
      version: true,
      startBar: true,
      endBar: true,
      title: true,
      status: true,
      assignees: { select: { memberId: true } },
    },
  });
  if (!task) throw notFound();
  const { membership } = await getRehearsalForUser(userId, task.rehearsalId);
  requireOwner(membership);
  assertVersion(task.version, input.version, "小节任务已在其他设备被修改，请刷新后合并");
  if (input.assigneeIds) {
    const rehearsal = await getRehearsalWithEnsemble(task.rehearsalId);
    await assertMembersBelong(rehearsal.ensembleId, input.assigneeIds);
  }
  const startBar = input.startBar ?? task.startBar;
  const endBar = input.endBar ?? task.endBar;
  if (endBar < startBar) throw new AppError(400, "VALIDATION_ERROR", "结束小节不能小于开始小节");

  await prisma.$transaction(async (tx) => {
    const rows = await tx.barTask.updateMany({
      where: { id: barTaskId, version: input.version },
      data: {
        ...(input.startBar === undefined ? {} : { startBar: input.startBar }),
        ...(input.endBar === undefined ? {} : { endBar: input.endBar }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
        ...(input.status === undefined ? {} : { status: input.status }),
        version: { increment: 1 },
      },
    });
    if (rows.count !== 1) throw new AppError(409, "VERSION_CONFLICT", "小节任务已在其他设备被修改，请刷新后合并");
    if (input.assigneeIds) {
      await tx.barTaskAssignee.deleteMany({ where: { barTaskId } });
      if (input.assigneeIds.length > 0) {
        await tx.barTaskAssignee.createMany({
          data: input.assigneeIds.map((memberId) => ({ barTaskId, memberId })),
          skipDuplicates: true,
        });
      }
    }
  });
  await recordChangeEvent(
    task.rehearsalId,
    membership.id,
    "BAR_TASK_UPDATED",
    {
      barTaskId,
      ...(input.startBar === undefined ? {} : { startBar: input.startBar }),
      ...(input.endBar === undefined ? {} : { endBar: input.endBar }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.assigneeIds === undefined ? {} : { assigneeIds: input.assigneeIds }),
    },
    task.version + 1,
  );
  return getRehearsalDetail(userId, task.rehearsalId);
}

export async function deleteBarTask(userId: string, barTaskId: string) {
  const task = await prisma.barTask.findUnique({ where: { id: barTaskId }, select: { id: true, rehearsalId: true, title: true } });
  if (!task) throw notFound();
  const { membership } = await getRehearsalForUser(userId, task.rehearsalId);
  requireOwner(membership);
  await prisma.barTask.delete({ where: { id: barTaskId } });
  await recordChangeEvent(task.rehearsalId, membership.id, "BAR_TASK_DELETED", { barTaskId, title: task.title }, 0);
  return { success: true as const };
}

// ---------------------------------------------------------------------------
// 小节确认（单个，支持离线幂等参数）
// ---------------------------------------------------------------------------

export async function confirmBarTask(
  userId: string,
  barTaskId: string,
  input: {
    memberId: string;
    done: boolean;
    note?: string | null;
    clientEventId?: string;
    baseVersion?: number;
    occurredAt?: Date;
  },
  options: { idempotencyKey?: string } = {},
) {
  const task = await prisma.barTask.findUnique({
    where: { id: barTaskId },
    select: { id: true, rehearsalId: true, status: true, assignees: { select: { memberId: true } } },
  });
  if (!task) throw notFound();
  const { membership } = await getRehearsalForUser(userId, task.rehearsalId);
  if (input.memberId !== membership.id && membership.role !== "OWNER") {
    throw forbidden();
  }
  if (task.status === "CANCELLED") throw new AppError(409, "INVALID_BAR_TASK_STATE", "小节任务已取消，不能确认");
  if (!task.assignees.some((a) => a.memberId === input.memberId)) {
    throw new AppError(400, "VALIDATION_ERROR", "该成员没有被指派到这一小节任务");
  }

  // 幂等短路：优先查事件账本（clientEventId），其次查通知事件的 Idempotency-Key
  if (input.clientEventId) {
    const previous = await prisma.rehearsalProcessedEvent.findUnique({
      where: {
        rehearsalId_clientEventId: { rehearsalId: task.rehearsalId, clientEventId: input.clientEventId },
      },
      select: { id: true },
    });
    if (previous) return getRehearsalDetail(userId, task.rehearsalId);
  }
  if (options.idempotencyKey && options.idempotencyKey !== input.clientEventId) {
    const previousNotification = await prisma.rehearsalChangeEvent.findUnique({
      where: { idempotencyKey: options.idempotencyKey },
      select: { id: true },
    });
    if (previousNotification) return getRehearsalDetail(userId, task.rehearsalId);
  }

  const now = input.occurredAt ?? new Date();
  const eventKey = input.clientEventId ?? options.idempotencyKey;
  let appliedDone = false;
  await prisma.$transaction(async (tx) => {
    const existing = await tx.barTaskCheckin.findUnique({
      where: { barTaskId_memberId: { barTaskId, memberId: input.memberId } },
    });
    const incoming = {
      clientEventId: input.clientEventId ?? `request-${now.getTime()}-${input.memberId}`,
      occurredAt: now,
      value: { done: input.done, note: input.note ?? null },
    };
    const winner = existing
      ? mergeOfflineValue(
          {
            clientEventId: existing.clientEventId ?? `server-${existing.id}`,
            occurredAt: existing.occurredAt,
            value: { done: existing.done, note: existing.note },
          },
          incoming,
        )
      : incoming;
    const takesEffect = winner.clientEventId === incoming.clientEventId;

    await tx.barTaskCheckin.upsert({
      where: { barTaskId_memberId: { barTaskId, memberId: input.memberId } },
      create: {
        barTaskId,
        memberId: input.memberId,
        done: winner.value.done,
        note: winner.value.note,
        clientEventId: input.clientEventId ?? null,
        occurredAt: winner.occurredAt,
      },
      update: {
        done: winner.value.done,
        note: winner.value.note,
        occurredAt: winner.occurredAt,
        ...(takesEffect && input.clientEventId ? { clientEventId: input.clientEventId } : {}),
      },
    });
    // 落账（含 LWW 落败事件），保证同事件重试一律走幂等短路
    if (eventKey) {
      await tx.rehearsalProcessedEvent.create({
        data: { rehearsalId: task.rehearsalId, clientEventId: eventKey, kind: "BAR_TASK_CONFIRMED" },
      });
    }
    appliedDone = takesEffect && winner.value.done;
  });

  // 仅当本次确认真正生效且结果为“完成”时通知；过期事件被 LWW 丢弃不打扰成员
  if (appliedDone) {
    await recordChangeEvent(
      task.rehearsalId,
      membership.id,
      "BAR_TASK_CONFIRMED",
      { barTaskId, memberId: input.memberId, done: true },
      input.baseVersion ?? 0,
      { idempotencyKey: options.idempotencyKey, targetMemberId: null },
    );
  }
  return getRehearsalDetail(userId, task.rehearsalId);
}

// ---------------------------------------------------------------------------
// 离线批量同步：事件重放去重 + LWW 合并，整批原子提交
// ---------------------------------------------------------------------------

type OfflineEvent =
  | {
      op: "UPSERT_ATTENDANCE";
      clientEventId: string;
      baseVersion: number;
      memberId: string;
      status: AttendanceStatus;
      note?: string | null;
      occurredAt?: Date;
    }
  | {
      op: "CONFIRM_BAR_TASK";
      clientEventId: string;
      baseVersion: number;
      barTaskId: string;
      memberId: string;
      done: boolean;
      note?: string | null;
      occurredAt?: Date;
    };

export interface OfflineSyncResult {
  applied: string[];
  replayed: string[];
  conflicts: Array<{ clientEventId: string; resolution: "KEPT_SERVER" | "TOOK_LOCAL" }>;
  /** 基于旧版本的事件数（已安全合并，客户端应刷新本地视图） */
  staleCount: number;
  serverVersion: number;
}

export async function syncOfflineEvents(
  userId: string,
  rehearsalId: string,
  events: OfflineEvent[],
): Promise<OfflineSyncResult & { detail: Awaited<ReturnType<typeof getRehearsalDetail>> }> {
  const { rehearsal, membership } = await getRehearsalForUser(userId, rehearsalId);

  // 客户端离线队列携带的 baseVersion 若落后于服务端，说明离线期间排练已被其他设备改动；
  // LWW 仍会逐字段安全合并（见 reduceOfflineSync），这里只把冲突计入响应供客户端提示刷新。
  const staleBaseVersions = events.filter((event) => event.baseVersion < rehearsal.version);

  // 先在事务外完成成员/任务归属校验，避免长事务
  const memberIds = new Set<string>();
  for (const event of events) {
    memberIds.add(event.memberId);
    if (event.op === "CONFIRM_BAR_TASK" && event.memberId !== membership.id && membership.role !== "OWNER") {
      throw forbidden();
    }
  }
  await assertMembersBelong(rehearsal.ensembleId, [...memberIds]);

  const confirmationEvents = events.filter(
    (e): e is Extract<OfflineEvent, { op: "CONFIRM_BAR_TASK" }> => e.op === "CONFIRM_BAR_TASK",
  );
  const barTaskIds = new Set(confirmationEvents.map((e) => e.barTaskId));
  if (barTaskIds.size > 0) {
    const tasks = await prisma.barTask.findMany({
      where: { id: { in: [...barTaskIds] }, rehearsalId },
      select: { id: true, status: true, assignees: { select: { memberId: true } } },
    });
    if (tasks.length !== barTaskIds.size) throw notFound();
    for (const task of tasks) {
      if (task.status === "CANCELLED") throw new AppError(409, "INVALID_BAR_TASK_STATE", `小节任务 ${task.id} 已取消，不能离线确认`);
    }
    for (const event of confirmationEvents) {
      const task = tasks.find((t) => t.id === event.barTaskId)!;
      if (!task.assignees.some((a) => a.memberId === event.memberId)) {
        throw new AppError(400, "VALIDATION_ERROR", `事件 ${event.clientEventId} 的成员未被指派到对应小节任务`);
      }
    }
  }

  // 批内 clientEventId 自去重（同一台设备离线队列里重复事件）
  const seenInBatch = new Set<string>();
  for (const event of events) {
    if (seenInBatch.has(event.clientEventId)) {
      throw new AppError(400, "VALIDATION_ERROR", `批次内存在重复事件 ${event.clientEventId}`);
    }
    seenInBatch.add(event.clientEventId);
  }

  // 1) 载入服务端当前状态 + 已处理事件账本，2) 纯函数归约，3) 事务落库
  const [attendanceRows, checkinRows, processedRows] = await Promise.all([
    prisma.rehearsalAttendance.findMany({ where: { rehearsalId } }),
    prisma.barTaskCheckin.findMany({ where: { barTask: { rehearsalId } } }),
    prisma.rehearsalProcessedEvent.findMany({ where: { rehearsalId }, select: { clientEventId: true } }),
  ]);

  const previous = emptySyncState();
  for (const id of processedRows) previous.processedEventIds.add(id.clientEventId);
  for (const row of attendanceRows) {
    previous.attendance.set(row.memberId, {
      clientEventId: row.clientEventId ?? `server-${row.id}`,
      occurredAt: row.occurredAt,
      value: { status: row.status, note: row.note },
    });
  }
  for (const row of checkinRows) {
    previous.checkins.set(`${row.barTaskId}:${row.memberId}`, {
      clientEventId: row.clientEventId ?? `server-${row.id}`,
      occurredAt: row.occurredAt,
      value: { done: row.done, note: row.note },
    });
  }

  let outcome: ReturnType<typeof reduceOfflineSync>;
  try {
    outcome = reduceOfflineSync(
      previous,
      events.map((event) =>
        event.op === "UPSERT_ATTENDANCE"
          ? {
              op: "UPSERT_ATTENDANCE" as const,
              clientEventId: event.clientEventId,
              memberId: event.memberId,
              occurredAt: event.occurredAt ?? new Date(),
              value: { status: event.status, note: event.note ?? null },
            }
          : {
              op: "CONFIRM_BAR_TASK" as const,
              clientEventId: event.clientEventId,
              barTaskId: event.barTaskId,
              memberId: event.memberId,
              occurredAt: event.occurredAt ?? new Date(),
              value: { done: event.done, note: event.note ?? null },
            },
      ),
    );
  } catch (error) {
    throw new AppError(400, "VALIDATION_ERROR", error instanceof Error ? error.message : "离线事件不合法");
  }

  const result: OfflineSyncResult = {
    applied: outcome.applied,
    replayed: outcome.replayed,
    conflicts: outcome.conflicts,
    staleCount: staleBaseVersions.length,
    serverVersion: rehearsal.version,
  };

  const touchedAttendance = new Set(
    events.filter((e) => e.op === "UPSERT_ATTENDANCE" && outcome.applied.includes(e.clientEventId)).map((e) => e.memberId),
  );
  const touchedCheckins = new Set(
    confirmationEvents
      .filter((e) => outcome.applied.includes(e.clientEventId))
      .map((e) => `${e.barTaskId}:${e.memberId}`),
  );

  await prisma.$transaction(async (tx) => {
    // 幂等账本：所有“非重放”事件都留痕（包括 LWW 落败者），
    // 这样它被更新事件覆盖后原设备重试，仍会被识别为重放而非复活旧值。
    if (outcome.applied.length > 0) {
      const kindByEventId = new Map<string, "ATTENDANCE_CHANGED" | "BAR_TASK_CONFIRMED">(
        events.map((event) => [
          event.clientEventId,
          event.op === "UPSERT_ATTENDANCE" ? "ATTENDANCE_CHANGED" : "BAR_TASK_CONFIRMED",
        ]),
      );
      await tx.rehearsalProcessedEvent.createMany({
        data: outcome.applied.map((clientEventId) => ({
          rehearsalId,
          clientEventId,
          kind: kindByEventId.get(clientEventId) ?? "ATTENDANCE_CHANGED",
        })),
        skipDuplicates: true,
      });
    }

    for (const memberId of touchedAttendance) {
      const winner = outcome.state.attendance.get(memberId)!;
      const isClientEvent = !winner.clientEventId.startsWith("server-");
      await tx.rehearsalAttendance.upsert({
        where: { rehearsalId_memberId: { rehearsalId, memberId } },
        create: {
          rehearsalId,
          memberId,
          status: winner.value.status,
          note: winner.value.note,
          clientEventId: isClientEvent ? winner.clientEventId : null,
          occurredAt: winner.occurredAt,
        },
        update: {
          status: winner.value.status,
          note: winner.value.note,
          occurredAt: winner.occurredAt,
          ...(isClientEvent ? { clientEventId: winner.clientEventId } : {}),
        },
      });
    }

    for (const key of touchedCheckins) {
      const [barTaskId, memberId] = key.split(":");
      const winner = outcome.state.checkins.get(key)!;
      const isClientEvent = !winner.clientEventId.startsWith("server-");
      await tx.barTaskCheckin.upsert({
        where: { barTaskId_memberId: { barTaskId: barTaskId!, memberId: memberId! } },
        create: {
          barTaskId: barTaskId!,
          memberId: memberId!,
          done: winner.value.done,
          note: winner.value.note,
          clientEventId: isClientEvent ? winner.clientEventId : null,
          occurredAt: winner.occurredAt,
        },
        update: {
          done: winner.value.done,
          note: winner.value.note,
          occurredAt: winner.occurredAt,
          ...(isClientEvent ? { clientEventId: winner.clientEventId } : {}),
        },
      });
    }

    if (outcome.effectiveAttendance.length > 0 || outcome.effectiveConfirmations.length > 0) {
      await tx.rehearsal.update({ where: { id: rehearsalId }, data: { version: { increment: 1 } } });
    }
  });

  // 事务提交后再展开通知；recordChangeEvent 自身幂等，重放整批 sync 也不会产生重复通知
  const nextVersion = rehearsal.version + 1;
  if (outcome.effectiveAttendance.length > 0) {
    await recordChangeEvent(
      rehearsalId,
      membership.id,
      "ATTENDANCE_CHANGED",
      { offlineSync: true, entries: outcome.effectiveAttendance },
      nextVersion,
    );
  }
  for (const confirmation of outcome.effectiveConfirmations) {
    await recordChangeEvent(
      rehearsalId,
      membership.id,
      "BAR_TASK_CONFIRMED",
      { offlineSync: true, ...confirmation, done: true },
      nextVersion,
    );
  }

  const detail = await getRehearsalDetail(userId, rehearsalId);
  return { ...result, detail };
}

// ---------------------------------------------------------------------------
// 变更通知：幂等落库 + 收件箱展开
// ---------------------------------------------------------------------------

function hashFingerprint(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * 记录一次变更并展开为成员通知。
 * - 同语义指纹（rehearsalId + kind + target + payload）已存在：整次调用短路，不产生重复通知
 * - 同一 idempotencyKey 重放：同样短路
 * 数据库唯一约束是最终兜底，即使并发请求同时穿透也只会成功一条。
 */
export async function recordChangeEvent(
  rehearsalId: string,
  actorMemberId: string | null,
  kind: RehearsalChangeKind,
  payload: unknown,
  versionSnapshot: number,
  options: { idempotencyKey?: string; targetMemberId?: string | null } = {},
): Promise<{ id: string; deduplicated: boolean }> {
  const fingerprint = hashFingerprint(
    buildChangeFingerprint({
      rehearsalId,
      kind,
      targetMemberId: options.targetMemberId ?? null,
      payload,
    }),
  );

  // 快速路径：指纹或幂等键已存在，直接复用
  const existing = await prisma.rehearsalChangeEvent.findFirst({
    where: {
      OR: [{ rehearsalId, fingerprint }, ...(options.idempotencyKey ? [{ idempotencyKey: options.idempotencyKey }] : [])],
    },
    select: { id: true },
  });
  if (existing) return { id: existing.id, deduplicated: true };

  try {
    const event = await prisma.$transaction(async (tx) => {
      const created = await tx.rehearsalChangeEvent.create({
        data: {
          rehearsalId,
          actorMemberId,
          kind,
          fingerprint,
          idempotencyKey: options.idempotencyKey ?? null,
          versionSnapshot,
          payload: payload as never,
        },
      });
      const recipients = await tx.ensembleMember.findMany({
        where: {
          ensemble: { rehearsals: { some: { id: rehearsalId } } },
          active: true,
          // 定向通知只发给目标成员；群发通知排除操作者本人
          ...(options.targetMemberId
            ? { id: options.targetMemberId }
            : actorMemberId
              ? { id: { not: actorMemberId } }
              : {}),
        },
        select: { id: true },
      });
      if (recipients.length > 0) {
        await tx.rehearsalNotification.createMany({
          data: recipients.map((r) => ({
            rehearsalId,
            changeEventId: created.id,
            recipientId: r.id,
          })),
          skipDuplicates: true,
        });
      }
      return created;
    });
    return { id: event.id, deduplicated: false };
  } catch (error) {
    // 并发下唯一约束冲突：回查已落库的事件，保证调用方拿到一致结果
    if (isUniqueViolation(error)) {
      const raced = await prisma.rehearsalChangeEvent.findFirstOrThrow({
        where: {
          OR: [{ rehearsalId, fingerprint }, ...(options.idempotencyKey ? [{ idempotencyKey: options.idempotencyKey }] : [])],
        },
        select: { id: true },
      });
      return { id: raced.id, deduplicated: true };
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

export async function listNotifications(
  userId: string,
  query: { rehearsalId?: string; status?: "PENDING" | "SENT" | "READ"; cursor?: string; limit: number },
) {
  const memberIds = (
    await prisma.ensembleMember.findMany({ where: { userId, active: true }, select: { id: true } })
  ).map((m) => m.id);
  if (memberIds.length === 0) return { data: [], nextCursor: null, unreadCount: 0 };

  const rows = await prisma.rehearsalNotification.findMany({
    where: {
      recipientId: { in: memberIds },
      ...(query.rehearsalId ? { rehearsalId: query.rehearsalId } : {}),
      ...(query.status ? { status: query.status } : {}),
    },
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    orderBy: { createdAt: "desc" },
    include: {
      changeEvent: { select: { id: true, kind: true, payload: true, versionSnapshot: true, createdAt: true } },
      rehearsal: { select: { id: true, title: true, ensembleId: true } },
    },
  });
  const hasMore = rows.length > query.limit;
  const data = hasMore ? rows.slice(0, query.limit) : rows;
  const unreadCount = await prisma.rehearsalNotification.count({
    where: { recipientId: { in: memberIds }, status: { in: ["PENDING", "SENT"] } },
  });
  return { data, nextCursor: hasMore ? data.at(-1)?.id ?? null : null, unreadCount };
}

export async function markNotificationRead(userId: string, notificationId: string) {
  const memberships = await prisma.ensembleMember.findMany({ where: { userId, active: true }, select: { id: true } });
  const result = await prisma.rehearsalNotification.updateMany({
    where: { id: notificationId, recipientId: { in: memberships.map((m) => m.id) } },
    data: { status: "READ", readAt: new Date() },
  });
  if (result.count !== 1) throw notFound();
  return { success: true as const };
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

async function assertMembersBelong(ensembleId: string, memberIds: string[]): Promise<void> {
  const uniqueIds = [...new Set(memberIds)];
  if (uniqueIds.length === 0) return;
  const count = await prisma.ensembleMember.count({
    where: { ensembleId, active: true, id: { in: uniqueIds } },
  });
  if (count !== uniqueIds.length) {
    throw new AppError(400, "VALIDATION_ERROR", "存在不属于当前合奏团的成员");
  }
}
