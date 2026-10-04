import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  attendanceBulkSchema,
  barTaskConfirmSchema,
  barTaskCreateSchema,
  barTaskUpdateSchema,
  ensembleCreateSchema,
  ensembleUpdateSchema,
  memberInviteSchema,
  memberListQuerySchema,
  memberUpdateSchema,
  notificationListQuerySchema,
  offlineSyncSchema,
  rehearsalCreateSchema,
  rehearsalListQuerySchema,
  rehearsalUpdateSchema,
} from "@practice/contracts";
import { AppError } from "../lib/errors.js";
import { parseOrThrow } from "../lib/validation.js";
import { audit } from "../lib/audit.js";
import {
  cancelRehearsal,
  confirmBarTask,
  createBarTask,
  createEnsemble,
  createRehearsal,
  deleteBarTask,
  getEnsemble,
  getRehearsalDetail,
  inviteMember,
  listEnsembles,
  listMembers,
  listNotifications,
  listRehearsals,
  markNotificationRead,
  removeMember,
  setAttendanceBulk,
  syncOfflineEvents,
  updateBarTask,
  updateEnsemble,
  updateMember,
  updateRehearsal,
} from "../services/ensemble-service.js";

/** 从标准头读取客户端幂等键（CORS 已允许 x-idempotency-key）。 */
function idempotencyKey(request: { headers: Record<string, unknown> }): string | undefined {
  const raw = request.headers["x-idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return undefined;
  return trimmed;
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  // ---- 合奏团 ----
  app.get("/ensembles", async (request) => ({ data: await listEnsembles(request.authUser!.id) }));

  app.post("/ensembles", async (request, reply) => {
    const input = parseOrThrow(ensembleCreateSchema, request.body);
    const ensemble = await createEnsemble(request.authUser!.id, input);
    await audit(request, "ENSEMBLE_CREATED", "ENSEMBLE", ensemble.id, "SUCCESS");
    return reply.status(201).send({ ensemble });
  });

  app.get("/ensembles/:ensembleId", async (request) => {
    const { ensembleId } = request.params as { ensembleId: string };
    return { ensemble: await getEnsemble(request.authUser!.id, ensembleId) };
  });

  app.patch("/ensembles/:ensembleId", async (request) => {
    const { ensembleId } = request.params as { ensembleId: string };
    const input = parseOrThrow(ensembleUpdateSchema, request.body);
    return { ensemble: await updateEnsemble(request.authUser!.id, ensembleId, input) };
  });

  // ---- 成员 / 声部 ----
  app.get("/ensembles/:ensembleId/members", async (request) => {
    const { ensembleId } = request.params as { ensembleId: string };
    const query = parseOrThrow(memberListQuerySchema, request.query);
    return { data: await listMembers(request.authUser!.id, ensembleId, query.part) };
  });

  app.post("/ensembles/:ensembleId/members", async (request, reply) => {
    const { ensembleId } = request.params as { ensembleId: string };
    const input = parseOrThrow(memberInviteSchema, request.body);
    const member = await inviteMember(request.authUser!.id, ensembleId, input);
    return reply.status(201).send({ member });
  });

  app.patch("/ensembles/:ensembleId/members/:memberId", async (request) => {
    const { ensembleId, memberId } = request.params as { ensembleId: string; memberId: string };
    const input = parseOrThrow(memberUpdateSchema, request.body);
    return { member: await updateMember(request.authUser!.id, ensembleId, memberId, input) };
  });

  app.delete("/ensembles/:ensembleId/members/:memberId", async (request) => {
    const { ensembleId, memberId } = request.params as { ensembleId: string; memberId: string };
    return removeMember(request.authUser!.id, ensembleId, memberId);
  });

  // ---- 排练 ----
  app.get("/ensembles/:ensembleId/rehearsals", async (request) => {
    const { ensembleId } = request.params as { ensembleId: string };
    const query = parseOrThrow(rehearsalListQuerySchema, request.query);
    return listRehearsals(request.authUser!.id, ensembleId, query);
  });

  app.post("/ensembles/:ensembleId/rehearsals", async (request, reply) => {
    const { ensembleId } = request.params as { ensembleId: string };
    const input = parseOrThrow(rehearsalCreateSchema, request.body);
    const detail = await createRehearsal(request.authUser!.id, ensembleId, input);
    await audit(request, "REHEARSAL_CREATED", "REHEARSAL", detail.rehearsal.id, "SUCCESS");
    return reply.status(201).send(detail);
  });

  app.get("/rehearsals/:rehearsalId", async (request) => {
    const { rehearsalId } = request.params as { rehearsalId: string };
    return getRehearsalDetail(request.authUser!.id, rehearsalId);
  });

  app.patch("/rehearsals/:rehearsalId", async (request) => {
    const { rehearsalId } = request.params as { rehearsalId: string };
    const input = parseOrThrow(rehearsalUpdateSchema, request.body);
    return updateRehearsal(request.authUser!.id, rehearsalId, input);
  });

  app.post("/rehearsals/:rehearsalId/cancel", async (request) => {
    const { rehearsalId } = request.params as { rehearsalId: string };
    const input = parseOrThrow(
      z.object({ version: z.coerce.number().int().nonnegative() }),
      request.body ?? {},
    );
    return cancelRehearsal(request.authUser!.id, rehearsalId, input.version);
  });

  // ---- 到齐状态（点名）----
  app.put("/rehearsals/:rehearsalId/attendance", async (request) => {
    const { rehearsalId } = request.params as { rehearsalId: string };
    const input = parseOrThrow(attendanceBulkSchema, request.body);
    return setAttendanceBulk(request.authUser!.id, rehearsalId, input, {
      idempotencyKey: idempotencyKey(request),
    });
  });

  // ---- 小节任务 ----
  app.post("/rehearsals/:rehearsalId/bar-tasks", async (request, reply) => {
    const { rehearsalId } = request.params as { rehearsalId: string };
    const input = parseOrThrow(barTaskCreateSchema, request.body);
    const detail = await createBarTask(request.authUser!.id, rehearsalId, input);
    return reply.status(201).send(detail);
  });

  app.patch("/bar-tasks/:barTaskId", async (request) => {
    const { barTaskId } = request.params as { barTaskId: string };
    const input = parseOrThrow(barTaskUpdateSchema, request.body);
    return updateBarTask(request.authUser!.id, barTaskId, input);
  });

  app.delete("/bar-tasks/:barTaskId", async (request) => {
    const { barTaskId } = request.params as { barTaskId: string };
    return deleteBarTask(request.authUser!.id, barTaskId);
  });

  // ---- 小节确认（单条，幂等头 + 可选 clientEventId 双重保障）----
  app.post("/bar-tasks/:barTaskId/confirm", async (request) => {
    const { barTaskId } = request.params as { barTaskId: string };
    const input = parseOrThrow(barTaskConfirmSchema, request.body);
    const key = idempotencyKey(request);
    if (key && input.clientEventId && key !== input.clientEventId) {
      throw new AppError(400, "VALIDATION_ERROR", "Idempotency-Key 与 clientEventId 不一致");
    }
    return confirmBarTask(request.authUser!.id, barTaskId, {
      ...input,
      clientEventId: input.clientEventId ?? key,
    }, { idempotencyKey: key });
  });

  // ---- 离线批量同步 ----
  app.post("/rehearsals/:rehearsalId/sync", async (request) => {
    const { rehearsalId } = request.params as { rehearsalId: string };
    const input = parseOrThrow(offlineSyncSchema, request.body);
    const result = await syncOfflineEvents(request.authUser!.id, rehearsalId, input.events);
    const { detail, ...summary } = result;
    return { ...summary, rehearsal: detail };
  });

  // ---- 通知收件箱 ----
  app.get("/notifications", async (request) => {
    const query = parseOrThrow(notificationListQuerySchema, request.query);
    return listNotifications(request.authUser!.id, query);
  });

  app.post("/notifications/:id/read", async (request) => {
    const { id } = request.params as { id: string };
    return markNotificationRead(request.authUser!.id, id);
  });
};

export default routes;
