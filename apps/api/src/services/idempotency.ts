import { Prisma } from "@prisma/client";
import { stableContentHash } from "@practice/contracts";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";

export interface IdempotentOutcome<T> {
  replay: boolean;
  statusCode: number;
  body: T;
}

const compoundKey = (userId: string, scope: string, idempotencyKey: string) => ({
  userId_scope_idempotencyKey: { userId, scope, idempotencyKey },
});

/**
 * 幂等包装：
 * 1. 先占用 (userId, scope, idempotencyKey) 记录，并发/重试的第二个请求立刻命中，
 *    不会把变更副作用（含通知）执行第二遍；
 * 2. 首次请求完成后回放其状态码与响应体；
 * 3. 同一幂等键携带不同请求内容时返回 409，杜绝“复用一个键提交不同变更”。
 *
 * 通知另有 rehearsal_notifications.dedupe_key 唯一约束兜底，这里是请求层防护。
 */
export async function withIdempotency<T>(
  userId: string,
  scope: string,
  idempotencyKey: string,
  fingerprintBody: unknown,
  handler: () => Promise<{ statusCode: number; body: T }>,
): Promise<IdempotentOutcome<T>> {
  const requestHash = stableContentHash(fingerprintBody);

  const existing = await prisma.idempotencyRecord.findUnique({
    where: compoundKey(userId, scope, idempotencyKey),
  });
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new AppError(409, "IDEMPOTENCY_KEY_REUSE", "该幂等键已用于不同的请求内容，请更换后重试");
    }
    if (existing.responseBody == null) {
      throw new AppError(409, "IDEMPOTENCY_IN_PROGRESS", "相同请求正在处理中，请稍后重试");
    }
    return { replay: true, statusCode: existing.statusCode, body: existing.responseBody as T };
  }

  try {
    await prisma.idempotencyRecord.create({
      data: { userId, scope, idempotencyKey, requestHash, statusCode: 0 },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await prisma.idempotencyRecord.findUniqueOrThrow({
        where: compoundKey(userId, scope, idempotencyKey),
      });
      if (winner.requestHash !== requestHash) {
        throw new AppError(409, "IDEMPOTENCY_KEY_REUSE", "该幂等键已用于不同的请求内容，请更换后重试");
      }
      if (winner.responseBody == null) {
        throw new AppError(409, "IDEMPOTENCY_IN_PROGRESS", "相同请求正在处理中，请稍后重试");
      }
      return { replay: true, statusCode: winner.statusCode, body: winner.responseBody as T };
    }
    throw error;
  }

  const result = await handler();
  await prisma.idempotencyRecord.update({
    where: compoundKey(userId, scope, idempotencyKey),
    data: { statusCode: result.statusCode, responseBody: result.body as object },
  });
  return { replay: false, statusCode: result.statusCode, body: result.body };
}
