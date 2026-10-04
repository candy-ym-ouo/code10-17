import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { apiFetch, ApiError } from "../api/client.js";

export interface PendingAttendance {
  /** 稳定幂等键：设备本地生成，离线重试与回放保持不变，服务端据此去重 */
  idempotencyKey: string;
  rehearsalId: string;
  memberId: string;
  status: "CONFIRMED" | "DECLINED";
  note: string | null;
  /** 成员在设备本地做出决定的时刻；服务端按 LWW 合并，不会覆盖更新的点名 */
  clientUpdatedAt: string;
  createdAt: string;
  attempts: number;
  lastError: string | null;
}

const STORAGE_KEY = "ensemble.attendance-queue.v1";

function randomKey(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto?.getRandomValues(bytes);
  return `att-${Date.now().toString(36)}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function loadQueue(): PendingAttendance[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PendingAttendance[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const useAttendanceQueueStore = defineStore("attendanceQueue", () => {
  const queue = ref<PendingAttendance[]>(loadQueue());
  const online = ref<boolean>(typeof navigator === "undefined" ? true : navigator.onLine);
  const flushing = ref(false);

  const pendingCount = computed(() => queue.value.length);
  const hasPending = computed(() => queue.value.length > 0);

  function persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue.value));
  }

  function updateOnline(next: boolean): void {
    online.value = next;
    if (next) void flush();
  }

  /**
   * 提交到勤回复：
   * - 在线：直接 POST 到同步接口，带幂等键；
   * - 离线：写入本地队列，恢复网络后按 clientUpdatedAt 顺序回放。
   */
  async function submit(input: {
    rehearsalId: string;
    memberId: string;
    status: "CONFIRMED" | "DECLINED";
    note?: string | null;
  }): Promise<{ queued: boolean }> {
    const item: PendingAttendance = {
      idempotencyKey: randomKey(),
      rehearsalId: input.rehearsalId,
      memberId: input.memberId,
      status: input.status,
      note: input.note ?? null,
      clientUpdatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      attempts: 0,
      lastError: null,
    };
    if (online.value) {
      try {
        await postSync(item);
        return { queued: false };
      } catch (error) {
        // 网络层失败落入离线队列；业务错误（4xx）直接抛出给界面
        if (error instanceof ApiError && error.status < 500) throw error;
      }
    }
    queue.value.push(item);
    persist();
    return { queued: true };
  }

  async function postSync(item: PendingAttendance): Promise<void> {
    await apiFetch(`/api/v1/rehearsals/${item.rehearsalId}/attendance/me/sync`, {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: item.idempotencyKey,
        clientUpdatedAt: item.clientUpdatedAt,
        responses: [
          {
            memberId: item.memberId,
            status: item.status,
            note: item.note,
            clientUpdatedAt: item.clientUpdatedAt,
            respondedOffline: true,
          },
        ],
      }),
    });
  }

  async function flush(): Promise<number> {
    if (flushing.value || queue.value.length === 0) return 0;
    flushing.value = true;
    let succeeded = 0;
    try {
      // 按决定时间从早到晚回放，保证服务端 LWW 合并顺序确定
      const ordered = [...queue.value].sort((a, b) => a.clientUpdatedAt.localeCompare(b.clientUpdatedAt));
      for (const item of ordered) {
        try {
          item.attempts += 1;
          await postSync(item);
          queue.value = queue.value.filter((queued) => queued.idempotencyKey !== item.idempotencyKey);
          persist();
          succeeded += 1;
        } catch (error) {
          item.lastError = error instanceof Error ? error.message : "同步失败";
          persist();
          // 业务侧 4xx（如已被点名）不重试；网络/5xx 保留待下次
          if (error instanceof ApiError && error.status < 500) {
            queue.value = queue.value.filter((queued) => queued.idempotencyKey !== item.idempotencyKey);
            persist();
          } else {
            break;
          }
        }
      }
    } finally {
      flushing.value = false;
    }
    return succeeded;
  }

  function remove(idempotencyKey: string): void {
    queue.value = queue.value.filter((item) => item.idempotencyKey !== idempotencyKey);
    persist();
  }

  return { queue, online, flushing, pendingCount, hasPending, updateOnline, submit, flush, remove };
});
