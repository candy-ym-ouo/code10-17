import { apiFetch } from "./client.js";

export type AttendanceStatusValue = "PRESENT" | "LATE" | "ABSENT" | "EXCUSED" | "UNKNOWN";

export interface EnsembleSummary {
  id: string;
  name: string;
  description: string | null;
  version: number;
  _count?: { members: number; rehearsals: number };
}

export interface MemberRow {
  id: string;
  userId: string;
  part: string | null;
  role: "OWNER" | "MEMBER";
  displayName: string;
  defaultInstrument: string | null;
  attendance: AttendanceStatusValue;
  attendanceNote: string | null;
}

export interface BarTaskProgress {
  eligibleCount: number;
  confirmedCount: number;
  excludedAssignees: Array<{ memberId: string; attendance: AttendanceStatusValue }>;
  completionRatio: number | null;
}

export interface BarTaskRow {
  id: string;
  startBar: number;
  endBar: number;
  title: string;
  instruction: string | null;
  status: "OPEN" | "DONE" | "CANCELLED";
  version: number;
  assignees: string[];
  checkins: Array<{ memberId: string; done: boolean; note: string | null; occurredAt: string }>;
  progress: BarTaskProgress;
}

export interface RehearsalRollup {
  totalMembers: number;
  presentCount: number;
  lateCount: number;
  absentCount: number;
  excusedCount: number;
  unknownCount: number;
  attendanceRatio: number | null;
  allPresent: boolean;
  overallCompletionRatio: number | null;
}

export interface RehearsalDetail {
  rehearsal: {
    id: string;
    ensembleId: string;
    ensembleName: string;
    title: string;
    scheduledStart: string;
    scheduledEnd: string;
    location: string | null;
    notes: string | null;
    cancelledAt: string | null;
    version: number;
  };
  members: MemberRow[];
  barTasks: BarTaskRow[];
  rollup: RehearsalRollup;
}

export interface OfflineEvent {
  op: "UPSERT_ATTENDANCE" | "CONFIRM_BAR_TASK";
  clientEventId: string;
  baseVersion: number;
  occurredAt: string;
  memberId: string;
  status?: AttendanceStatusValue;
  note?: string | null;
  barTaskId?: string;
  done?: boolean;
}

export interface SyncSummary {
  applied: string[];
  replayed: string[];
  conflicts: Array<{ clientEventId: string; resolution: "KEPT_SERVER" | "TOOK_LOCAL" }>;
  staleCount: number;
  serverVersion: number;
}

// --- 接口封装 ---------------------------------------------------------------

export function listEnsembles(): Promise<{ data: EnsembleSummary[] }> {
  return apiFetch("/api/v1/ensembles");
}

export function createEnsemble(name: string, description: string | null): Promise<unknown> {
  return apiFetch("/api/v1/ensembles", { method: "POST", body: JSON.stringify({ name, description }) });
}

export function createRehearsal(
  ensembleId: string,
  input: { title: string; scheduledStart: string; scheduledEnd: string; location: string | null },
): Promise<RehearsalDetail> {
  return apiFetch(`/api/v1/ensembles/${ensembleId}/rehearsals`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function listRehearsals(
  ensembleId: string,
): Promise<{ data: Array<{ id: string; title: string; scheduledStart: string }> }> {
  return apiFetch(`/api/v1/ensembles/${ensembleId}/rehearsals?limit=50`);
}

export function getRehearsal(rehearsalId: string): Promise<RehearsalDetail> {
  return apiFetch(`/api/v1/rehearsals/${rehearsalId}`);
}

export function setAttendance(
  rehearsalId: string,
  version: number,
  entries: Array<{ memberId: string; status: AttendanceStatusValue; note?: string | null }>,
): Promise<RehearsalDetail> {
  return apiFetch(`/api/v1/rehearsals/${rehearsalId}/attendance`, {
    method: "PUT",
    body: JSON.stringify({ version, entries }),
  });
}

export function createBarTask(
  rehearsalId: string,
  input: { startBar: number; endBar: number; title: string; assigneeIds: string[] },
): Promise<RehearsalDetail> {
  return apiFetch(`/api/v1/rehearsals/${rehearsalId}/bar-tasks`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function confirmBarTask(
  barTaskId: string,
  input: { memberId: string; done: boolean; note?: string | null },
): Promise<RehearsalDetail> {
  return apiFetch(`/api/v1/bar-tasks/${barTaskId}/confirm`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function syncOffline(rehearsalId: string, events: OfflineEvent[]): Promise<SyncSummary & { rehearsal: RehearsalDetail }> {
  return apiFetch(`/api/v1/rehearsals/${rehearsalId}/sync`, {
    method: "POST",
    body: JSON.stringify({ events }),
  });
}

// --- 离线队列（localStorage）-----------------------------------------------

const QUEUE_KEY = "ensemble.offlineQueue.v1";

export function newClientEventId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(16).slice(2, 18);
  return `evt-${Date.now().toString(36)}-${random}`;
}

export function loadOfflineQueue(rehearsalId: string): OfflineEvent[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const all = JSON.parse(raw) as Record<string, OfflineEvent[] | undefined>;
    return all[rehearsalId] ?? [];
  } catch {
    return [];
  }
}

export function saveOfflineQueue(rehearsalId: string, events: OfflineEvent[]): void {
  const raw = localStorage.getItem(QUEUE_KEY);
  const all: Record<string, OfflineEvent[]> = raw ? (JSON.parse(raw) as Record<string, OfflineEvent[]>) : {};
  if (events.length === 0) delete all[rehearsalId];
  else all[rehearsalId] = events;
  localStorage.setItem(QUEUE_KEY, JSON.stringify(all));
}

export function enqueueOfflineEvent(rehearsalId: string, event: OfflineEvent): OfflineEvent[] {
  const queue = [...loadOfflineQueue(rehearsalId), event];
  saveOfflineQueue(rehearsalId, queue);
  return queue;
}

/**
 * 浏览器在线时把本地离线队列推给 /sync 合并；失败则保留队列，由用户稍后重试。
 * 服务端按 clientEventId 幂等，重复推送安全。
 */
export async function flushOfflineQueue(rehearsalId: string): Promise<SyncSummary & { rehearsal: RehearsalDetail }> {
  const queue = loadOfflineQueue(rehearsalId);
  if (queue.length === 0) throw new Error("离线队列为空");
  const result = await syncOffline(rehearsalId, queue);
  // 只有服务端确认接收（applied 或 replayed）才清空；网络错误会直接抛出不会走到这里
  saveOfflineQueue(rehearsalId, []);
  return result;
}
