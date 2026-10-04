import type { FastifyPluginAsync } from "fastify";
import {
  attendanceBatchSchema,
  attendanceResponseSchema,
  barTaskCreateSchema,
  barTaskStatusSchema,
  barTaskUpdateSchema,
  ensembleCreateSchema,
  ensembleUpdateSchema,
  memberCreateSchema,
  memberUpdateSchema,
  notificationListQuerySchema,
  rehearsalCreateSchema,
  rehearsalTransitionSchema,
  rehearsalUpdateSchema,
  rollCallSchema,
} from "@practice/contracts";
import { AppError } from "../lib/errors.js";
import { parseOrThrow } from "../lib/validation.js";
import { withIdempotency } from "../services/idempotency.js";
import {
  addMember,
  batchRespondAttendance,
  createBarTask,
  createEnsemble,
  createRehearsal,
  getEnsemble,
  getRehearsal,
  getRehearsalSummary,
  listAttendance,
  listBarTasks,
  listEnsembles,
  listMembers,
  listNotifications,
  listRehearsals,
  markNotificationsRead,
  removeMember,
  respondAttendance,
  rollCall,
  setBarTaskStatus,
  transitionRehearsal,
  updateBarTask,
  updateEnsemble,
  updateMember,
  updateRehearsal,
} from "../services/ensemble-service.js";

const uuidParam = (params: unknown, name: string): string => {
  const value = (params as Record<string, unknown>)[name];
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError(400, "VALIDATION_ERROR", `${name} 不是合法的 UUID`);
  }
  return value;
};

const ensembleRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  // ---- 合奏 ----
  app.get("/ensembles", async (request) => listEnsembles(request.authUser!.id));

  app.post("/ensembles", async (request, reply) => {
    const input = parseOrThrow(ensembleCreateSchema, request.body);
    const ensemble = await createEnsemble(request.authUser!.id, input);
    return reply.status(201).send({ ensemble });
  });

  app.get("/ensembles/:ensembleId", async (request) => {
    const ensembleId = uuidParam(request.params, "ensembleId");
    return { ensemble: await getEnsemble(request.authUser!.id, ensembleId) };
  });

  app.patch("/ensembles/:ensembleId", async (request) => {
    const ensembleId = uuidParam(request.params, "ensembleId");
    const input = parseOrThrow(ensembleUpdateSchema, request.body);
    return { ensemble: await updateEnsemble(request.authUser!.id, ensembleId, input) };
  });

  // ---- 成员 / 声部 ----
  app.get("/ensembles/:ensembleId/members", async (request) => {
    const ensembleId = uuidParam(request.params, "ensembleId");
    return listMembers(request.authUser!.id, ensembleId);
  });

  app.post("/ensembles/:ensembleId/members", async (request, reply) => {
    const ensembleId = uuidParam(request.params, "ensembleId");
    const input = parseOrThrow(memberCreateSchema, request.body);
    const member = await addMember(request.authUser!.id, ensembleId, input);
    return reply.status(201).send({ member });
  });

  app.patch("/ensembles/:ensembleId/members/:memberId", async (request) => {
    const ensembleId = uuidParam(request.params, "ensembleId");
    const memberId = uuidParam(request.params, "memberId");
    const input = parseOrThrow(memberUpdateSchema, request.body);
    return { member: await updateMember(request.authUser!.id, ensembleId, memberId, input) };
  });

  app.delete("/ensembles/:ensembleId/members/:memberId", async (request) => {
    const ensembleId = uuidParam(request.params, "ensembleId");
    const memberId = uuidParam(request.params, "memberId");
    return removeMember(request.authUser!.id, ensembleId, memberId);
  });

  // ---- 排练 ----
  app.get("/ensembles/:ensembleId/rehearsals", async (request) => {
    const ensembleId = uuidParam(request.params, "ensembleId");
    const status = typeof request.query === "object" && request.query && "status" in request.query
      ? (request.query as { status?: string }).status
      : undefined;
    return listRehearsals(
      request.authUser!.id,
      ensembleId,
      status && ["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"].includes(status)
        ? (status as "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED")
        : undefined,
    );
  });

  app.post("/ensembles/:ensembleId/rehearsals", async (request, reply) => {
    const ensembleId = uuidParam(request.params, "ensembleId");
    const input = parseOrThrow(rehearsalCreateSchema, request.body);
    const rehearsal = await createRehearsal(request.authUser!.id, ensembleId, input);
    return reply.status(201).send({ rehearsal });
  });

  app.get("/rehearsals/:rehearsalId", async (request) => {
    const rehearsalId = uuidParam(request.params, "rehearsalId");
    return { rehearsal: await getRehearsal(request.authUser!.id, rehearsalId) };
  });

  app.patch("/rehearsals/:rehearsalId", async (request) => {
    const rehearsalId = uuidParam(request.params, "rehearsalId");
    const input = parseOrThrow(rehearsalUpdateSchema, request.body);
    return { rehearsal: await updateRehearsal(request.authUser!.id, rehearsalId, input) };
  });

  app.post("/rehearsals/:rehearsalId/transition", async (request) => {
    const rehearsalId = uuidParam(request.params, "rehearsalId");
    const input = parseOrThrow(rehearsalTransitionSchema, request.body);
    const rehearsal = await transitionRehearsal(request.authUser!.id, rehearsalId, input.status, input.version);
    return { rehearsal };
  });

  // ---- 到勤 ----
  app.get("/rehearsals/:rehearsalId/attendance", async (request) => {
    const rehearsalId = uuidParam(request.params, "rehearsalId");
    return listAttendance(request.authUser!.id, rehearsalId);
  });

  // 成员在线回复本人到勤
  app.put("/rehearsals/:rehearsalId/attendance/me", async (request) => {
    const rehearsalId = uuidParam(request.params, "rehearsalId");
    const input = parseOrThrow(attendanceResponseSchema, request.body);
    if (input.status !== "CONFIRMED" && input.status !== "DECLINED") {
      throw new AppError(400, "VALIDATION_ERROR", "成员只能提交「确认参加」或「请假」");
    }
    const record = await respondAttendance(request.authUser!.id, rehearsalId, input);
    return { record };
  });

  // 离线确认合并：整段离线期间产生的多条回复按 clientUpdatedAt 顺序回放，幂等键防重放
  app.post("/rehearsals/:rehearsalId/attendance/me/sync", async (request, reply) => {
    const rehearsalId = uuidParam(request.params, "rehearsalId");
    const input = parseOrThrow(attendanceBatchSchema, request.body);
    for (const response of input.responses) {
      if (response.status !== "CONFIRMED" && response.status !== "DECLINED") {
        throw new AppError(400, "VALIDATION_ERROR", "同步的到勤回复只能是「确认参加」或「请假」");
      }
    }
    const fingerprint = { rehearsalId, responses: input.responses, clientUpdatedAt: input.clientUpdatedAt ?? null };
    const outcome = await withIdempotency(
      request.authUser!.id,
      `attendance-sync:${rehearsalId}`,
      input.idempotencyKey,
      fingerprint,
      async () => {
        const result = await batchRespondAttendance(request.authUser!.id, rehearsalId, input);
        return { statusCode: 200, body: result };
      },
    );
    return reply.status(outcome.replay ? 200 : outcome.statusCode).header("x-idempotent-replay", outcome.replay ? "true" : "false").send(outcome.body);
  });

  // 组织者点名（到场/迟到/缺席），幂等
  app.post("/rehearsals/:rehearsalId/attendance/:memberId/roll-call", async (request, reply) => {
    const rehearsalId = uuidParam(request.params, "rehearsalId");
    const memberId = uuidParam(request.params, "memberId");
    const input = parseOrThrow(rollCallSchema, request.body);
    const fingerprint = { rehearsalId, memberId, status: input.status, note: input.note ?? null };
    const outcome = await withIdempotency(
      request.authUser!.id,
      `roll-call:${rehearsalId}:${memberId}`,
      input.idempotencyKey,
      fingerprint,
      async () => {
        const record = await rollCall(request.authUser!.id, rehearsalId, memberId, input);
        return { statusCode: 200, body: { record } };
      },
    );
    return reply.status(outcome.statusCode).header("x-idempotent-replay", outcome.replay ? "true" : "false").send(outcome.body);
  });

  // ---- 小节任务 ----
  app.get("/rehearsals/:rehearsalId/bar-tasks", async (request) => {
    const rehearsalId = uuidParam(request.params, "rehearsalId");
    return listBarTasks(request.authUser!.id, rehearsalId);
  });

  app.post("/rehearsals/:rehearsalId/bar-tasks", async (request, reply) => {
    const rehearsalId = uuidParam(request.params, "rehearsalId");
    const input = parseOrThrow(barTaskCreateSchema, request.body);
    const task = await createBarTask(request.authUser!.id, rehearsalId, input);
    return reply.status(201).send({ task });
  });

  app.patch("/bar-tasks/:taskId", async (request) => {
    const taskId = uuidParam(request.params, "taskId");
    const input = parseOrThrow(barTaskUpdateSchema, request.body);
    return { task: await updateBarTask(request.authUser!.id, taskId, input) };
  });

  // 任务状态变更（含离线回放），幂等键 + 乐观锁
  app.post("/bar-tasks/:taskId/status", async (request, reply) => {
    const taskId = uuidParam(request.params, "taskId");
    const input = parseOrThrow(barTaskStatusSchema, request.body);
    const fingerprint = { taskId, status: input.status };
    const outcome = await withIdempotency(
      request.authUser!.id,
      `bar-task-status:${taskId}`,
      input.idempotencyKey,
      fingerprint,
      async () => {
        const task = await setBarTaskStatus(request.authUser!.id, taskId, input.status, input.version);
        return { statusCode: 200, body: { task } };
      },
    );
    return reply.status(outcome.statusCode).header("x-idempotent-replay", outcome.replay ? "true" : "false").send(outcome.body);
  });

  // ---- 汇总：成员声部 + 到齐状态 + 小节任务完成度 ----
  app.get("/rehearsals/:rehearsalId/summary", async (request) => {
    const rehearsalId = uuidParam(request.params, "rehearsalId");
    return getRehearsalSummary(request.authUser!.id, rehearsalId);
  });

  // ---- 通知收件箱 ----
  app.get("/notifications", async (request) => {
    const query = parseOrThrow(notificationListQuerySchema, request.query);
    return listNotifications(request.authUser!.id, query);
  });

  app.post("/notifications/read", async (request) => {
    const body = (request.body ?? {}) as { ids?: string[]; all?: boolean };
    const all = body.all === true;
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
    if (!all && ids.length === 0) throw new AppError(400, "VALIDATION_ERROR", "请提供要标记的通知 ID，或传 all=true");
    if (ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw new AppError(400, "VALIDATION_ERROR", "通知 ID 不合法");
    return markNotificationsRead(request.authUser!.id, ids.slice(0, 200), all);
  });
};

export default ensembleRoutes;
