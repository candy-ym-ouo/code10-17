import { Prisma, type AttendanceStatus, type RehearsalNotificationType, type BarTaskStatus as DbBarTaskStatus } from "@prisma/client";
import {
  buildNotificationDedupeKey,
  canTransitionRehearsal,
  mergeAttendance,
  stableContentHash,
  summarizeRehearsal,
  type AttendanceStatus as ContractAttendanceStatus,
  type BarTaskStatus,
  type EnsembleMemberRole,
  type RehearsalStatus,
} from "@practice/contracts";
import type { z } from "zod";
import type {
  attendanceBatchSchema,
  attendanceResponseSchema,
  barTaskCreateSchema,
  barTaskUpdateSchema,
  ensembleCreateSchema,
  ensembleUpdateSchema,
  memberCreateSchema,
  memberUpdateSchema,
  rehearsalCreateSchema,
  rehearsalUpdateSchema,
  rollCallSchema,
} from "@practice/contracts";
import { AppError, notFound } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";

type Tx = Prisma.TransactionClient;

const memberSelect = {
  id: true,
  userId: true,
  displayName: true,
  instrument: true,
  part: true,
  role: true,
  isActive: true,
  version: true,
} satisfies Prisma.EnsembleMemberSelect;

const rehearsalInclude = {
  ensemble: { select: { id: true, name: true, ownerId: true } },
  attendance: { include: { member: { select: memberSelect } } },
  barTasks: { orderBy: [{ startBar: "asc" }, { endBar: "asc" }] },
} satisfies Prisma.RehearsalInclude;

// ---------------------------------------------------------------------------
// 权限
// ---------------------------------------------------------------------------

async function requireMembership(client: Tx | typeof prisma, ensembleId: string, userId: string) {
  const ensemble = await client.ensemble.findFirst({ where: { id: ensembleId } });
  if (!ensemble) throw notFound();
  const member = await client.ensembleMember.findFirst({
    where: { ensembleId, userId, isActive: true },
    select: memberSelect,
  });
  if (!member) throw new AppError(403, "FORBIDDEN", "你不是该合奏的成员");
  return { ensemble, member };
}

async function requireManager(client: Tx | typeof prisma, ensembleId: string, userId: string) {
  const access = await requireMembership(client, ensembleId, userId);
  const isManager = access.member.role === "OWNER" || access.member.role === "CONDUCTOR";
  if (!isManager && access.ensemble.ownerId !== userId) {
    throw new AppError(403, "FORBIDDEN", "只有组织者或指挥可以执行此操作");
  }
  return access;
}

async function requireRehearsal(
  client: Tx | typeof prisma,
  rehearsalId: string,
  userId: string,
  manager = false,
) {
  const rehearsal = await client.rehearsal.findUnique({ where: { id: rehearsalId } });
  if (!rehearsal) throw notFound();
  const access = manager
    ? await requireManager(client, rehearsal.ensembleId, userId)
    : await requireMembership(client, rehearsal.ensembleId, userId);
  return { rehearsal, ...access };
}

// ---------------------------------------------------------------------------
// 通知（事务内、按 dedupe_key 幂等）
// ---------------------------------------------------------------------------

async function emitNotification(
  tx: Tx,
  input: {
    rehearsalId: string;
    ensembleId: string;
    type: RehearsalNotificationType;
    actorId: string;
    entityId?: string | null;
    title: string;
    body?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  const contentHash = stableContentHash({
    title: input.title,
    body: input.body ?? null,
    payload: input.payload ?? null,
  });
  const dedupeKey = buildNotificationDedupeKey({
    rehearsalId: input.rehearsalId,
    type: input.type,
    entityId: input.entityId ?? null,
    contentHash,
  });

  // 重复变更（重试、双击、离线回放）内容指纹一致时直接命中，绝不重复通知。
  const already = await tx.rehearsalNotification.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (already) return;

  const bumped = await tx.rehearsal.updateMany({
    where: { id: input.rehearsalId },
    data: { notificationSeq: { increment: 1 } },
  });
  if (bumped.count !== 1) return;
  const rehearsal = await tx.rehearsal.findUniqueOrThrow({
    where: { id: input.rehearsalId },
    select: { notificationSeq: true },
  });

  // 唯一约束是最终防线：并发时输掉的一方静默跳过，不使外层事务失败。
  await tx.rehearsalNotification.createMany({
    data: [
      {
        rehearsalId: input.rehearsalId,
        type: input.type,
        changeSeq: rehearsal.notificationSeq,
        dedupeKey,
        actorId: input.actorId,
        title: input.title,
        body: input.body ?? null,
        payload: input.payload as never,
      },
    ],
    skipDuplicates: true,
  });

  const notification = await tx.rehearsalNotification.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (!notification) return;

  const recipients = await tx.ensembleMember.findMany({
    where: { ensembleId: input.ensembleId, isActive: true, userId: { not: null } },
    select: { userId: true },
  });
  if (recipients.length > 0) {
    await tx.deliveredNotification.createMany({
      data: recipients
        .filter((recipient) => recipient.userId !== input.actorId)
        .map((recipient) => ({ notificationId: notification.id, userId: recipient.userId as string })),
      skipDuplicates: true,
    });
  }
}

// ---------------------------------------------------------------------------
// 合奏与成员
// ---------------------------------------------------------------------------

export async function listEnsembles(userId: string) {
  const data = await prisma.ensemble.findMany({
    where: { members: { some: { userId, isActive: true } } },
    include: { _count: { select: { members: true, rehearsals: true } } },
    orderBy: { updatedAt: "desc" },
  });
  return { data };
}

export async function createEnsemble(userId: string, input: z.infer<typeof ensembleCreateSchema>) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { defaultInstrument: true, displayName: true },
  });
  return prisma.$transaction(async (tx) => {
    const ensemble = await tx.ensemble.create({
      data: {
        ownerId: userId,
        name: input.name,
        description: input.description ?? null,
      },
    });
    await tx.ensembleMember.create({
      data: {
        ensembleId: ensemble.id,
        userId,
        displayName: user.displayName,
        instrument: user.defaultInstrument ?? "指挥",
        part: "组织者",
        role: "OWNER",
      },
    });
    return ensemble;
  });
}

export async function getEnsemble(userId: string, ensembleId: string) {
  await requireMembership(prisma, ensembleId, userId);
  return prisma.ensemble.findUniqueOrThrow({
    where: { id: ensembleId },
    include: {
      members: {
        where: { isActive: true },
        orderBy: [{ role: "asc" }, { part: "asc" }, { displayName: "asc" }],
      },
      rehearsals: { orderBy: { startsAt: "desc" }, take: 20 },
    },
  });
}

export async function updateEnsemble(userId: string, ensembleId: string, input: z.infer<typeof ensembleUpdateSchema>) {
  const { ensemble } = await requireManager(prisma, ensembleId, userId);
  if (ensemble.ownerId !== userId) throw new AppError(403, "FORBIDDEN", "只有合奏创建者可以修改合奏信息");
  const result = await prisma.ensemble.updateMany({
    where: { id: ensembleId, version: input.version },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      version: { increment: 1 },
    },
  });
  if (result.count !== 1) throw new AppError(409, "VERSION_CONFLICT", "合奏信息已在其他窗口被修改");
  return getEnsemble(userId, ensembleId);
}

export async function listMembers(userId: string, ensembleId: string) {
  await requireMembership(prisma, ensembleId, userId);
  const data = await prisma.ensembleMember.findMany({
    where: { ensembleId, isActive: true },
    orderBy: [{ role: "asc" }, { part: "asc" }, { displayName: "asc" }],
  });
  return { data };
}

export async function addMember(userId: string, ensembleId: string, input: z.infer<typeof memberCreateSchema>) {
  await requireManager(prisma, ensembleId, userId);
  if (input.userId) {
    const target = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true } });
    if (!target) throw new AppError(400, "VALIDATION_ERROR", "关联用户不存在");
    const existing = await prisma.ensembleMember.findUnique({
      where: { ensembleId_userId: { ensembleId, userId: input.userId } },
    });
    if (existing) {
      if (existing.isActive) throw new AppError(409, "MEMBER_ALREADY_EXISTS", "该用户已在合奏中");
      // 重新激活历史成员
      const reactivated = await prisma.ensembleMember.update({
        where: { id: existing.id },
        data: {
          displayName: input.displayName,
          instrument: input.instrument,
          part: input.part,
          role: input.role,
          isActive: true,
          leftAt: null,
          version: { increment: 1 },
        },
      });
      await backfillAttendance(ensembleId, existing.id);
      return reactivated;
    }
  }

  const member = await prisma.ensembleMember.create({
    data: {
      ensembleId,
      userId: input.userId ?? null,
      displayName: input.displayName,
      instrument: input.instrument,
      part: input.part,
      role: input.role,
    },
  });
  await backfillAttendance(ensembleId, member.id);

  const upcoming = await prisma.rehearsal.findMany({
    where: { ensembleId, status: "SCHEDULED" },
    select: { id: true },
    orderBy: { startsAt: "asc" },
  });
  await prisma.$transaction(async (tx) => {
    for (const rehearsal of upcoming) {
      await emitNotification(tx, {
        rehearsalId: rehearsal.id,
        ensembleId,
        type: "MEMBER_ADDED",
        actorId: userId,
        entityId: member.id,
        title: `新成员加入：${member.displayName}（${member.part}）`,
        body: `${member.instrument} · ${member.part}`,
      });
    }
  });

  return member;
}

async function backfillAttendance(ensembleId: string, memberId: string): Promise<void> {
  const scheduled = await prisma.rehearsal.findMany({
    where: { ensembleId, status: "SCHEDULED" },
    select: { id: true },
  });
  if (scheduled.length === 0) return;
  await prisma.attendanceRecord.createMany({
    data: scheduled.map((rehearsal) => ({ rehearsalId: rehearsal.id, memberId })),
    skipDuplicates: true,
  });
}

export async function updateMember(
  userId: string,
  ensembleId: string,
  memberId: string,
  input: z.infer<typeof memberUpdateSchema>,
) {
  await requireManager(prisma, ensembleId, userId);
  const member = await prisma.ensembleMember.findFirst({ where: { id: memberId, ensembleId, isActive: true } });
  if (!member) throw notFound();
  if (member.role === "OWNER" && (input.role !== undefined || input.isActive === false)) {
    throw new AppError(409, "INVALID_MEMBER_STATE", "合奏创建者的身份不能被降级或移除");
  }
  const result = await prisma.ensembleMember.updateMany({
    where: { id: memberId, ensembleId, version: input.version },
    data: {
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.instrument === undefined ? {} : { instrument: input.instrument }),
      ...(input.part === undefined ? {} : { part: input.part }),
      ...(input.role === undefined ? {} : { role: input.role as EnsembleMemberRole }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive, leftAt: input.isActive ? null : new Date() }),
      version: { increment: 1 },
    },
  });
  if (result.count !== 1) throw new AppError(409, "VERSION_CONFLICT", "成员信息已在其他窗口被修改");
  return prisma.ensembleMember.findUniqueOrThrow({ where: { id: memberId } });
}

export async function removeMember(userId: string, ensembleId: string, memberId: string) {
  const { ensemble } = await requireManager(prisma, ensembleId, userId);
  const member = await prisma.ensembleMember.findFirst({ where: { id: memberId, ensembleId, isActive: true } });
  if (!member) throw notFound();
  if (member.userId === ensemble.ownerId || member.role === "OWNER") {
    throw new AppError(409, "INVALID_MEMBER_STATE", "合奏创建者不能被移除");
  }
  await prisma.ensembleMember.update({
    where: { id: memberId },
    data: { isActive: false, leftAt: new Date(), version: { increment: 1 } },
  });
  const upcoming = await prisma.rehearsal.findMany({
    where: { ensembleId, status: "SCHEDULED" },
    select: { id: true },
  });
  await prisma.$transaction(async (tx) => {
    for (const rehearsal of upcoming) {
      await emitNotification(tx, {
        rehearsalId: rehearsal.id,
        ensembleId,
        type: "MEMBER_REMOVED",
        actorId: userId,
        entityId: memberId,
        title: `成员已离开：${member.displayName}`,
      });
    }
  });
  return { success: true, memberId };
}

// ---------------------------------------------------------------------------
// 排练
// ---------------------------------------------------------------------------

export async function listRehearsals(userId: string, ensembleId: string, status?: RehearsalStatus) {
  await requireMembership(prisma, ensembleId, userId);
  const data = await prisma.rehearsal.findMany({
    where: { ensembleId, ...(status ? { status } : {}) },
    orderBy: { startsAt: "desc" },
    take: 100,
  });
  return { data };
}

export async function createRehearsal(userId: string, ensembleId: string, input: z.infer<typeof rehearsalCreateSchema>) {
  await requireManager(prisma, ensembleId, userId);
  const members = await prisma.ensembleMember.findMany({
    where: { ensembleId, isActive: true },
    select: { id: true },
  });

  return prisma.$transaction(async (tx) => {
    const rehearsal = await tx.rehearsal.create({
      data: {
        ensembleId,
        title: input.title,
        piece: input.piece ?? null,
        location: input.location ?? null,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        notes: input.notes ?? null,
      },
    });
    if (members.length > 0) {
      await tx.attendanceRecord.createMany({
        data: members.map((member) => ({ rehearsalId: rehearsal.id, memberId: member.id })),
        skipDuplicates: true,
      });
    }
    await emitNotification(tx, {
      rehearsalId: rehearsal.id,
      ensembleId,
      type: "REHEARSAL_CREATED",
      actorId: userId,
      title: `新排练：${rehearsal.title}`,
      body: input.location ? `地点：${input.location}` : null,
      payload: { startsAt: rehearsal.startsAt.toISOString(), endsAt: rehearsal.endsAt.toISOString() },
    });
    return tx.rehearsal.findUniqueOrThrow({ where: { id: rehearsal.id }, include: rehearsalInclude });
  });
}

export async function getRehearsal(userId: string, rehearsalId: string) {
  await requireRehearsal(prisma, rehearsalId, userId);
  return prisma.rehearsal.findUniqueOrThrow({ where: { id: rehearsalId }, include: rehearsalInclude });
}

export async function updateRehearsal(
  userId: string,
  rehearsalId: string,
  input: z.infer<typeof rehearsalUpdateSchema>,
) {
  const access = await requireRehearsal(prisma, rehearsalId, userId, true);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.rehearsal.updateMany({
      where: { id: rehearsalId, version: input.version, status: { not: "CANCELLED" } },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.piece === undefined ? {} : { piece: input.piece }),
        ...(input.location === undefined ? {} : { location: input.location }),
        ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }),
        ...(input.endsAt === undefined ? {} : { endsAt: input.endsAt }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new AppError(409, "VERSION_CONFLICT", "排练已在其他窗口被修改，请刷新后合并");
    const rehearsal = await tx.rehearsal.findUniqueOrThrow({ where: { id: rehearsalId } });
    await emitNotification(tx, {
      rehearsalId,
      ensembleId: access.ensemble.id,
      type: "REHEARSAL_UPDATED",
      actorId: userId,
      title: `排练变更：${rehearsal.title}`,
      payload: {
        title: rehearsal.title,
        piece: rehearsal.piece,
        location: rehearsal.location,
        startsAt: rehearsal.startsAt.toISOString(),
        endsAt: rehearsal.endsAt.toISOString(),
        notes: rehearsal.notes,
      },
    });
    return rehearsal;
  }).then(() => getRehearsal(userId, rehearsalId));
}

export async function transitionRehearsal(
  userId: string,
  rehearsalId: string,
  status: RehearsalStatus,
  version: number,
) {
  const access = await requireRehearsal(prisma, rehearsalId, userId, true);
  if (!canTransitionRehearsal(access.rehearsal.status, status)) {
    throw new AppError(409, "INVALID_REHEARSAL_STATE", `排练不能从 ${access.rehearsal.status} 切换到 ${status}`);
  }
  await prisma.$transaction(async (tx) => {
    const updated = await tx.rehearsal.updateMany({
      where: { id: rehearsalId, version, status: access.rehearsal.status },
      data: { status, version: { increment: 1 } },
    });
    if (updated.count !== 1) throw new AppError(409, "VERSION_CONFLICT", "排练已在其他窗口被修改，请刷新后重试");
    if (status === "CANCELLED") {
      await emitNotification(tx, {
        rehearsalId,
        ensembleId: access.ensemble.id,
        type: "REHEARSAL_CANCELLED",
        actorId: userId,
        title: `排练已取消：${access.rehearsal.title}`,
      });
    }
  });
  return getRehearsal(userId, rehearsalId);
}

// ---------------------------------------------------------------------------
// 到勤：在线回复、离线合并、点名
// ---------------------------------------------------------------------------

interface AttendanceApplyInput {
  status: AttendanceStatus;
  note?: string | null;
  clientUpdatedAt?: Date | null;
  respondedOffline?: boolean;
  allowRollCall: boolean;
}

async function applyAttendance(tx: Tx, rehearsalId: string, memberId: string, input: AttendanceApplyInput) {
  const record = await tx.attendanceRecord.findUnique({
    where: { rehearsalId_memberId: { rehearsalId, memberId } },
  });
  if (!record) throw new AppError(404, "ATTENDANCE_NOT_FOUND", "该成员不在本场排练名单中");

  if (!input.allowRollCall && (input.status === "PRESENT" || input.status === "LATE" || input.status === "ABSENT")) {
    throw new AppError(403, "FORBIDDEN", "到场/缺席状态只能由组织者点名设置");
  }

  const { merged, changed } = mergeAttendance(
    {
      status: record.status,
      note: record.note,
      clientUpdatedAt: record.clientUpdatedAt,
      respondedOffline: record.respondedOffline,
      updatedAt: record.updatedAt,
    },
    {
      status: input.status as ContractAttendanceStatus,
      note: input.note ?? null,
      clientUpdatedAt: input.clientUpdatedAt ?? null,
      respondedOffline: input.respondedOffline ?? false,
    },
  );
  if (!changed) return { record, changed: false as const };

  const updated = await tx.attendanceRecord.update({
    where: { id: record.id },
    data: {
      status: merged.status as AttendanceStatus,
      note: merged.note ?? null,
      clientUpdatedAt: merged.clientUpdatedAt ?? null,
      respondedOffline: merged.respondedOffline,
      respondedAt: new Date(),
    },
  });
  return { record: updated, changed: true as const };
}

export async function respondAttendance(userId: string, rehearsalId: string, input: z.infer<typeof attendanceResponseSchema>) {
  const access = await requireRehearsal(prisma, rehearsalId, userId);
  return prisma.$transaction(async (tx) => {
    const { changed } = await applyAttendance(tx, rehearsalId, access.member.id, {
      status: input.status as AttendanceStatus,
      note: input.note ?? null,
      clientUpdatedAt: input.clientUpdatedAt ?? null,
      respondedOffline: input.respondedOffline,
      allowRollCall: false,
    });
    if (changed) {
      await emitNotification(tx, {
        rehearsalId,
        ensembleId: access.ensemble.id,
        type: "ATTENDANCE_UPDATED",
        actorId: userId,
        entityId: access.member.id,
        title: `${access.member.displayName} ${attendanceLabel(input.status as AttendanceStatus)}`,
        payload: { memberId: access.member.id, status: input.status },
      });
    }
    return tx.attendanceRecord.findUniqueOrThrow({
      where: { rehearsalId_memberId: { rehearsalId, memberId: access.member.id } },
      include: { member: { select: { displayName: true, part: true, instrument: true } } },
    });
  });
}

export async function batchRespondAttendance(
  userId: string,
  rehearsalId: string,
  input: z.infer<typeof attendanceBatchSchema>,
) {
  const access = await requireRehearsal(prisma, rehearsalId, userId);
  const now = new Date();
  const applied = await prisma.$transaction(async (tx) => {
    const changedRecords = [];
    for (const response of input.responses) {
      // 成员只能替自己提交；点名状态需要组织者权限
      if (response.memberId !== access.member.id) {
        throw new AppError(403, "FORBIDDEN", "只能提交本人的到勤回复");
      }
      const result = await applyAttendance(tx, rehearsalId, response.memberId, {
        status: response.status as AttendanceStatus,
        note: response.note ?? null,
        clientUpdatedAt: response.clientUpdatedAt ?? input.clientUpdatedAt ?? now,
        respondedOffline: response.respondedOffline,
        allowRollCall: false,
      });
      if (result.changed) {
        changedRecords.push({ memberId: response.memberId, status: response.status as AttendanceStatus });
        await emitNotification(tx, {
          rehearsalId,
          ensembleId: access.ensemble.id,
          type: "ATTENDANCE_UPDATED",
          actorId: userId,
          entityId: response.memberId,
          title: `${access.member.displayName} ${attendanceLabel(response.status as AttendanceStatus)}`,
          payload: { memberId: response.memberId, status: response.status, offline: response.respondedOffline },
        });
      }
    }
    return changedRecords;
  });
  return {
    applied: applied.length,
    data: await prisma.attendanceRecord.findMany({ where: { rehearsalId, memberId: access.member.id } }),
  };
}

export async function rollCall(
  userId: string,
  rehearsalId: string,
  memberId: string,
  input: z.infer<typeof rollCallSchema>,
) {
  const access = await requireRehearsal(prisma, rehearsalId, userId, true);
  return prisma.$transaction(async (tx) => {
    const member = await tx.ensembleMember.findFirst({
      where: { id: memberId, ensembleId: access.ensemble.id, isActive: true },
      select: { id: true, displayName: true },
    });
    if (!member) throw notFound();
    const { changed } = await applyAttendance(tx, rehearsalId, memberId, {
      status: input.status as AttendanceStatus,
      note: input.note ?? null,
      clientUpdatedAt: new Date(),
      respondedOffline: false,
      allowRollCall: true,
    });
    if (changed) {
      await emitNotification(tx, {
        rehearsalId,
        ensembleId: access.ensemble.id,
        type: "ATTENDANCE_UPDATED",
        actorId: userId,
        entityId: memberId,
        title: `点名：${member.displayName} ${attendanceLabel(input.status as AttendanceStatus)}`,
        payload: { memberId, status: input.status, rollCall: true },
      });
    }
    return tx.attendanceRecord.findUniqueOrThrow({
      where: { rehearsalId_memberId: { rehearsalId, memberId } },
      include: { member: { select: { displayName: true, part: true, instrument: true } } },
    });
  });
}

export async function listAttendance(userId: string, rehearsalId: string) {
  await requireRehearsal(prisma, rehearsalId, userId);
  const data = await prisma.attendanceRecord.findMany({
    where: { rehearsalId },
    orderBy: { member: { displayName: "asc" } },
    include: { member: { select: { displayName: true, part: true, instrument: true, userId: true } } },
  });
  return { data };
}

function attendanceLabel(status: AttendanceStatus): string {
  const labels: Record<AttendanceStatus, string> = {
    PENDING: "待回复",
    CONFIRMED: "确认参加",
    DECLINED: "请假",
    PRESENT: "已到场",
    LATE: "迟到",
    ABSENT: "缺席",
  };
  return labels[status];
}

// ---------------------------------------------------------------------------
// 小节任务
// ---------------------------------------------------------------------------

export async function listBarTasks(userId: string, rehearsalId: string) {
  await requireRehearsal(prisma, rehearsalId, userId);
  const data = await prisma.barTask.findMany({
    where: { rehearsalId },
    orderBy: [{ startBar: "asc" }, { endBar: "asc" }],
    include: { assignee: { select: { id: true, displayName: true, part: true, instrument: true } } },
  });
  return { data };
}

export async function createBarTask(userId: string, rehearsalId: string, input: z.infer<typeof barTaskCreateSchema>) {
  const access = await requireRehearsal(prisma, rehearsalId, userId, true);
  if (input.assigneeId) {
    const assignee = await prisma.ensembleMember.findFirst({
      where: { id: input.assigneeId, ensembleId: access.ensemble.id, isActive: true },
      select: { id: true },
    });
    if (!assignee) throw new AppError(400, "VALIDATION_ERROR", "指派对象不属于该合奏");
  }
  return prisma.$transaction(async (tx) => {
    const task = await tx.barTask.create({
      data: {
        rehearsalId,
        assigneeId: input.assigneeId ?? null,
        startBar: input.startBar,
        endBar: input.endBar,
        title: input.title,
        focus: input.focus ?? null,
      },
      include: { assignee: { select: { id: true, displayName: true, part: true } } },
    });
    if (input.assigneeId) {
      await emitNotification(tx, {
        rehearsalId,
        ensembleId: access.ensemble.id,
        type: "BAR_TASK_ASSIGNED",
        actorId: userId,
        entityId: task.id,
        title: `新小节任务：${input.startBar}-${input.endBar} 小节 ${input.title}`,
        body: input.focus ?? null,
        payload: { taskId: task.id, bars: [input.startBar, input.endBar] },
      });
    }
    return task;
  });
}

export async function updateBarTask(userId: string, taskId: string, input: z.infer<typeof barTaskUpdateSchema>) {
  const task = await prisma.barTask.findUnique({ where: { id: taskId } });
  if (!task) throw notFound();
  const access = await requireRehearsal(prisma, task.rehearsalId, userId, true);

  if (input.assigneeId) {
    const assignee = await prisma.ensembleMember.findFirst({
      where: { id: input.assigneeId, ensembleId: access.ensemble.id, isActive: true },
      select: { id: true },
    });
    if (!assignee) throw new AppError(400, "VALIDATION_ERROR", "指派对象不属于该合奏");
  }
  const nextStart = input.startBar ?? task.startBar;
  const nextEnd = input.endBar ?? task.endBar;
  if (nextEnd < nextStart) throw new AppError(400, "VALIDATION_ERROR", "结束小节不能小于开始小节");

  return prisma.$transaction(async (tx) => {
    const result = await tx.barTask.updateMany({
      where: { id: taskId, version: input.version },
      data: {
        ...(input.startBar === undefined ? {} : { startBar: input.startBar }),
        ...(input.endBar === undefined ? {} : { endBar: input.endBar }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.focus === undefined ? {} : { focus: input.focus }),
        ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }),
        version: { increment: 1 },
      },
    });
    if (result.count !== 1) throw new AppError(409, "VERSION_CONFLICT", "小节任务已在其他窗口被修改");
    const updated = await tx.barTask.findUniqueOrThrow({ where: { id: taskId } });
    await emitNotification(tx, {
      rehearsalId: task.rehearsalId,
      ensembleId: access.ensemble.id,
      type: "BAR_TASK_UPDATED",
      actorId: userId,
      entityId: taskId,
      title: `任务变更：${updated.startBar}-${updated.endBar} 小节 ${updated.title}`,
      payload: { taskId, bars: [updated.startBar, updated.endBar], title: updated.title },
    });
    return updated;
  });
}

export async function setBarTaskStatus(userId: string, taskId: string, status: BarTaskStatus, version: number) {
  const task = await prisma.barTask.findUnique({ where: { id: taskId } });
  if (!task) throw notFound();
  // 先按普通成员取访问权；再判定是否有权更新这条任务
  const access = await requireRehearsal(prisma, task.rehearsalId, userId);
  const isManager = access.member.role === "OWNER" || access.member.role === "CONDUCTOR" || access.ensemble.ownerId === userId;
  // 成员只能更新自己被指派的任务；未指派任务只有组织者能更新
  if (task.assigneeId !== access.member.id && !isManager) {
    throw new AppError(403, "FORBIDDEN", "只能更新自己被指派的小节任务");
  }

  return prisma.$transaction(async (tx) => {
    const result = await tx.barTask.updateMany({
      where: { id: taskId, version },
      data: {
        status: status as DbBarTaskStatus,
        completedAt: status === "DONE" ? new Date() : null,
        version: { increment: 1 },
      },
    });
    if (result.count !== 1) throw new AppError(409, "VERSION_CONFLICT", "小节任务已在其他窗口被修改");
    const updated = await tx.barTask.findUniqueOrThrow({ where: { id: taskId } });
    await emitNotification(tx, {
      rehearsalId: task.rehearsalId,
      ensembleId: access.ensemble.id,
      type: "BAR_TASK_UPDATED",
      actorId: userId,
      entityId: taskId,
      title: `任务进度：${updated.startBar}-${updated.endBar} 小节 ${updated.title} → ${barTaskLabel(status)}`,
      payload: { taskId, status },
    });
    return updated;
  });
}

function barTaskLabel(status: BarTaskStatus): string {
  const labels: Record<BarTaskStatus, string> = {
    NOT_STARTED: "未开始",
    IN_PROGRESS: "进行中",
    DONE: "已完成",
    SKIPPED: "已跳过",
  };
  return labels[status];
}

// ---------------------------------------------------------------------------
// 汇总：声部 + 到齐 + 小节任务
// ---------------------------------------------------------------------------

export async function getRehearsalSummary(userId: string, rehearsalId: string) {
  await requireRehearsal(prisma, rehearsalId, userId);
  const rehearsal = await prisma.rehearsal.findUniqueOrThrow({
    where: { id: rehearsalId },
    include: {
      attendance: true,
      barTasks: true,
      ensemble: {
        select: {
          members: {
            where: { isActive: true },
            select: { id: true, displayName: true, instrument: true, part: true, isActive: true },
          },
        },
      },
    },
  });

  const attendanceByMember = new Map(rehearsal.attendance.map((record) => [record.memberId, record]));
  const members = rehearsal.ensemble.members.map((member) => {
    const record = attendanceByMember.get(member.id);
    return {
      ...member,
      attendance: record
        ? { status: record.status as ContractAttendanceStatus, respondedOffline: record.respondedOffline }
        : null,
    };
  });
  const tasks = rehearsal.barTasks.map((task) => ({
    id: task.id,
    startBar: task.startBar,
    endBar: task.endBar,
    title: task.title,
    status: task.status as BarTaskStatus,
    assigneeId: task.assigneeId,
  }));

  return {
    rehearsal: {
      id: rehearsal.id,
      title: rehearsal.title,
      piece: rehearsal.piece,
      location: rehearsal.location,
      startsAt: rehearsal.startsAt,
      endsAt: rehearsal.endsAt,
      status: rehearsal.status,
      version: rehearsal.version,
    },
    summary: summarizeRehearsal(members, tasks),
  };
}

// ---------------------------------------------------------------------------
// 收件箱
// ---------------------------------------------------------------------------

export async function listNotifications(userId: string, query: { unreadOnly: boolean; cursor?: string; limit: number }) {
  const rows = await prisma.deliveredNotification.findMany({
    where: { userId, ...(query.unreadOnly ? { status: "UNREAD" } : {}) },
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    orderBy: { createdAt: "desc" },
    include: {
      notification: {
        select: {
          id: true,
          type: true,
          title: true,
          body: true,
          payload: true,
          changeSeq: true,
          createdAt: true,
          rehearsalId: true,
        },
      },
    },
  });
  const hasMore = rows.length > query.limit;
  const data = hasMore ? rows.slice(0, query.limit) : rows;
  const unreadCount = await prisma.deliveredNotification.count({ where: { userId, status: "UNREAD" } });
  return { data, nextCursor: hasMore ? data.at(-1)?.id ?? null : null, unreadCount };
}

export async function markNotificationsRead(userId: string, ids: string[], all = false) {
  if (all) {
    const result = await prisma.deliveredNotification.updateMany({
      where: { userId, status: "UNREAD" },
      data: { status: "READ", readAt: new Date() },
    });
    return { updated: result.count };
  }
  const uniqueIds = [...new Set(ids)];
  const result = await prisma.deliveredNotification.updateMany({
    where: { userId, id: { in: uniqueIds }, status: "UNREAD" },
    data: { status: "READ", readAt: new Date() },
  });
  // 越权/不存在的 ID 不计数也不报错（标记已读天然幂等）
  return { updated: result.count };
}
