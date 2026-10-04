<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ApiError } from "../api/client.js";
import { useAuthStore } from "../stores/auth.js";
import {
  confirmBarTask,
  createBarTask,
  createEnsemble,
  createRehearsal,
  enqueueOfflineEvent,
  flushOfflineQueue,
  getRehearsal,
  listEnsembles,
  listRehearsals,
  loadOfflineQueue,
  newClientEventId,
  saveOfflineQueue,
  setAttendance,
  type AttendanceStatusValue,
  type EnsembleSummary,
  type OfflineEvent,
  type RehearsalDetail,
} from "../api/ensemble.js";
import EmptyState from "../components/EmptyState.vue";
import LoadingBlock from "../components/LoadingBlock.vue";

const ATTENDANCE_OPTIONS: Array<{ value: AttendanceStatusValue; label: string }> = [
  { value: "PRESENT", label: "准时" },
  { value: "LATE", label: "迟到" },
  { value: "ABSENT", label: "缺席" },
  { value: "EXCUSED", label: "请假" },
];

const ensembles = ref<EnsembleSummary[]>([]);
const selectedEnsembleId = ref("");
const rehearsalList = ref<Array<{ id: string; title: string; scheduledStart: string }>>([]);
const rehearsalId = ref("");
const detail = ref<RehearsalDetail | null>(null);
const offlineQueue = ref<OfflineEvent[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const notice = ref("");

const newEnsembleName = ref("");
const newRehearsalTitle = ref("");
const newTask = ref({ startBar: 1, endBar: 8, title: "", assigneeIds: [] as string[] });

const online = ref(navigator.onLine);
window.addEventListener("online", () => (online.value = true));
window.addEventListener("offline", () => (online.value = false));

const memberName = new Map<string, string>();
function memberLabel(memberId: string): string {
  const member = detail.value?.members.find((m) => m.id === memberId);
  return member ? `${member.displayName}${member.part ? `（${member.part}）` : ""}` : memberId.slice(0, 8);
}

const attendanceLabel: Record<AttendanceStatusValue, string> = {
  PRESENT: "准时",
  LATE: "迟到",
  ABSENT: "缺席",
  EXCUSED: "请假",
  UNKNOWN: "未点名",
};

function formatRatio(value: number | null): string {
  // null 表示口径不可统计（无人出席/任务取消），绝不能展示为 0% 或 100%
  if (value === null || value === undefined) return "暂不可统计";
  return `${Math.round(value * 100)}%`;
}

const auth = useAuthStore();

/** 当前登录用户在本场排练中的成员身份（用于确认按钮可用性） */
const myMemberId = computed(() => detail.value?.members.find((m) => m.userId === auth.user?.id)?.id ?? "");

async function loadEnsembles(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const result = await listEnsembles();
    ensembles.value = result.data;
    if (result.data[0]) {
      selectedEnsembleId.value = result.data[0].id;
      await onEnsembleChange();
    }
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "合奏团加载失败";
  } finally {
    loading.value = false;
  }
}

async function createNewEnsemble(): Promise<void> {
  if (!newEnsembleName.value.trim()) return;
  busy.value = true;
  error.value = "";
  try {
    await createEnsemble(newEnsembleName.value.trim(), null);
    newEnsembleName.value = "";
    await loadEnsembles();
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "创建合奏团失败";
  } finally {
    busy.value = false;
  }
}

async function onEnsembleChange(): Promise<void> {
  rehearsalList.value = [];
  detail.value = null;
  const result = await listRehearsals(selectedEnsembleId.value);
  rehearsalList.value = result.data;
  if (result.data[0]) await openRehearsal(result.data[0].id);
}

async function createNewRehearsal(): Promise<void> {
  if (!newRehearsalTitle.value.trim()) return;
  busy.value = true;
  try {
    const start = new Date();
    start.setMinutes(start.getMinutes() + 30, 0, 0);
    const end = new Date(start.getTime() + 90 * 60_000);
    detail.value = await createRehearsal(selectedEnsembleId.value, {
      title: newRehearsalTitle.value.trim(),
      scheduledStart: start.toISOString(),
      scheduledEnd: end.toISOString(),
      location: null,
    });
    rehearsalId.value = detail.value.rehearsal.id;
    newRehearsalTitle.value = "";
    await onEnsembleChange();
    await openRehearsal(rehearsalId.value);
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "创建排练失败";
  } finally {
    busy.value = false;
  }
}

async function openRehearsal(id: string): Promise<void> {
  rehearsalId.value = id;
  loading.value = true;
  try {
    detail.value = await getRehearsal(id);
    offlineQueue.value = loadOfflineQueue(id);
    for (const member of detail.value.members) memberName.set(member.id, member.displayName);
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "排练详情加载失败";
  } finally {
    loading.value = false;
  }
}

/** 点名：在线直接提交；离线写入本地队列，用 clientEventId 保证后续合并幂等 */
async function markAttendance(memberId: string, status: AttendanceStatusValue): Promise<void> {
  if (!detail.value) return;
  if (!online.value) {
    enqueueAttendance(memberId, status);
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    detail.value = await setAttendance(detail.value.rehearsal.id, detail.value.rehearsal.version, [{ memberId, status }]);
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "点名失败";
  } finally {
    busy.value = false;
  }
}

function enqueueAttendance(memberId: string, status: AttendanceStatusValue): void {
  if (!detail.value) return;
  const event: OfflineEvent = {
    op: "UPSERT_ATTENDANCE",
    clientEventId: newClientEventId(),
    baseVersion: detail.value.rehearsal.version,
    occurredAt: new Date().toISOString(),
    memberId,
    status,
  };
  offlineQueue.value = enqueueOfflineEvent(detail.value.rehearsal.id, event);
  // 离线期间本地乐观展示，恢复在线并合并后以服务端结果为准
  const member = detail.value.members.find((m) => m.id === memberId);
  if (member) member.attendance = status;
  notice.value = "当前离线，已加入待同步队列";
}

/** 小节确认同样支持离线入队；缺席成员的确认不会进入服务端完成度口径 */
async function toggleConfirm(barTaskId: string, memberId: string, done: boolean): Promise<void> {
  if (!detail.value) return;
  if (!online.value) {
    enqueueConfirmation(barTaskId, memberId, done);
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    detail.value = await confirmBarTask(barTaskId, { memberId, done });
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "小节确认失败";
  } finally {
    busy.value = false;
  }
}

function enqueueConfirmation(barTaskId: string, memberId: string, done: boolean): void {
  if (!detail.value) return;
  const event: OfflineEvent = {
    op: "CONFIRM_BAR_TASK",
    clientEventId: newClientEventId(),
    baseVersion: detail.value.rehearsal.version,
    occurredAt: new Date().toISOString(),
    barTaskId,
    memberId,
    done,
  };
  offlineQueue.value = enqueueOfflineEvent(detail.value.rehearsal.id, event);
  notice.value = "当前离线，确认已加入待同步队列";
}

async function flushQueue(): Promise<void> {
  if (!detail.value || offlineQueue.value.length === 0) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await flushOfflineQueue(detail.value.rehearsal.id);
    detail.value = result.rehearsal;
    offlineQueue.value = [];
    const parts: string[] = [];
    if (result.applied.length) parts.push(`合并 ${result.applied.length} 条`);
    if (result.replayed.length) parts.push(`重放去重 ${result.replayed.length} 条`);
    if (result.conflicts.length) parts.push(`冲突裁决 ${result.conflicts.length} 条`);
    if (result.staleCount > 0) parts.push(`${result.staleCount} 条基于旧版本，已合并最新数据`);
    notice.value = parts.join("，") || "无变更";
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "离线同步失败，队列已保留";
  } finally {
    busy.value = false;
  }
}

function dropOfflineEvent(clientEventId: string): void {
  if (!detail.value) return;
  offlineQueue.value = offlineQueue.value.filter((e) => e.clientEventId !== clientEventId);
  saveOfflineQueue(detail.value.rehearsal.id, offlineQueue.value);
}

async function addBarTask(): Promise<void> {
  if (!detail.value || !newTask.value.title.trim()) return;
  busy.value = true;
  try {
    detail.value = await createBarTask(detail.value.rehearsal.id, {
      startBar: newTask.value.startBar,
      endBar: newTask.value.endBar,
      title: newTask.value.title.trim(),
      assigneeIds: newTask.value.assigneeIds,
    });
    newTask.value.title = "";
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "小节任务创建失败";
  } finally {
    busy.value = false;
  }
}

function toggleAssignee(memberId: string): void {
  const list = newTask.value.assigneeIds;
  const index = list.indexOf(memberId);
  if (index >= 0) list.splice(index, 1);
  else list.push(memberId);
}

onMounted(loadEnsembles);
</script>

<template>
  <section class="ensemble-coordination">
    <div class="row" style="justify-content: space-between; align-items: center">
      <h1>合奏排练协调</h1>
      <span class="badge" :class="online ? 'badge-success' : 'badge-warning'">
        {{ online ? "在线" : `离线 · ${offlineQueue.length} 条待同步` }}
      </span>
    </div>

    <LoadingBlock v-if="loading" />
    <EmptyState v-else-if="ensembles.length === 0" title="还没有合奏团" description="创建合奏团后即可管理声部、点名与小节任务">
      <div class="row" style="gap: 8px; margin-top: 12px">
        <input class="field" v-model="newEnsembleName" placeholder="合奏团名称，如：星海弦乐四重奏" maxlength="120" />
        <button class="button" :disabled="busy" @click="createNewEnsemble">创建合奏团</button>
      </div>
    </EmptyState>

    <template v-else>
      <div class="card">
        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <select class="field" v-model="selectedEnsembleId" @change="onEnsembleChange">
            <option v-for="ensemble in ensembles" :key="ensemble.id" :value="ensemble.id">{{ ensemble.name }}</option>
          </select>
          <input class="field" v-model="newRehearsalTitle" placeholder="新排练标题" maxlength="120" />
          <button class="button" :disabled="busy" @click="createNewRehearsal">安排排练</button>
          <input class="field" v-model="newEnsembleName" placeholder="或创建新合奏团" maxlength="120" />
          <button class="button ghost" :disabled="busy" @click="createNewEnsemble">新建合奏团</button>
        </div>
        <div class="row" style="gap: 8px; margin-top: 10px">
          <button
            v-for="rehearsal in rehearsalList"
            :key="rehearsal.id"
            class="button small"
            :class="rehearsal.id === rehearsalId ? '' : 'ghost'"
            @click="openRehearsal(rehearsal.id)"
          >
            {{ rehearsal.title }}
          </button>
        </div>
      </div>

      <p v-if="error" class="badge badge-danger" role="alert">{{ error }}</p>
      <p v-if="notice" class="badge badge-success">{{ notice }}</p>

      <EmptyState
        v-if="!detail"
        title="该合奏团还没有排练"
        description="先安排一场排练，再进行声部点名和小节任务分工"
      />

      <template v-else>
        <div class="grid grid-4" style="margin-top: 12px">
          <div class="card metric"><strong>{{ detail.rollup.totalMembers }}</strong><small>声部成员</small></div>
          <div class="card metric">
            <strong>{{ detail.rollup.presentCount + detail.rollup.lateCount }}/{{ detail.rollup.totalMembers }}</strong>
            <small>到齐（准时 {{ detail.rollup.presentCount }} · 迟到 {{ detail.rollup.lateCount }}）</small>
          </div>
          <div class="card metric">
            <strong>{{ formatRatio(detail.rollup.attendanceRatio) }}</strong>
            <small>到齐率（缺席 {{ detail.rollup.absentCount }} · 请假 {{ detail.rollup.excusedCount }} · 未点名 {{ detail.rollup.unknownCount }}）</small>
          </div>
          <div class="card metric">
            <strong>{{ formatRatio(detail.rollup.overallCompletionRatio) }}</strong>
            <small>小节任务整体完成度</small>
          </div>
        </div>

        <div class="card" style="margin-top: 12px">
          <h2 class="card-title">声部与点名</h2>
          <table>
            <thead>
              <tr><th>成员</th><th>声部</th><th>当前状态</th><th>点名操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="member in detail.members" :key="member.id">
                <td>{{ member.displayName }}</td>
                <td>{{ member.part ?? "—" }}</td>
                <td>
                  <span class="badge" :class="{
                    'badge-success': member.attendance === 'PRESENT',
                    'badge-warning': member.attendance === 'LATE' || member.attendance === 'UNKNOWN',
                    'badge-danger': member.attendance === 'ABSENT' || member.attendance === 'EXCUSED',
                  }">{{ attendanceLabel[member.attendance] }}</span>
                </td>
                <td>
                  <div class="row" style="gap: 6px">
                    <button
                      v-for="option in ATTENDANCE_OPTIONS"
                      :key="option.value"
                      class="button small"
                      :class="member.attendance === option.value ? '' : 'ghost'"
                      :disabled="busy"
                      @click="markAttendance(member.id, option.value)"
                    >
                      {{ option.label }}
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="card" style="margin-top: 12px">
          <h2 class="card-title">小节任务</h2>
          <div class="row" style="gap: 8px; flex-wrap: wrap; margin-bottom: 10px">
            <input class="field" type="number" min="1" v-model.number="newTask.startBar" style="width: 90px" aria-label="开始小节" />
            <span>—</span>
            <input class="field" type="number" min="1" v-model.number="newTask.endBar" style="width: 90px" aria-label="结束小节" />
            <input class="field" v-model="newTask.title" placeholder="任务标题，如：17-24 小节渐强齐奏" maxlength="120" />
            <select class="field" v-model="newTask.assigneeIds" multiple style="min-width: 220px; height: 44px">
              <option v-for="member in detail.members" :key="member.id" :value="member.id">
                {{ member.displayName }}{{ member.part ? `（${member.part}）` : "" }}
              </option>
            </select>
            <button class="button" :disabled="busy" @click="addBarTask">添加任务</button>
          </div>

          <div v-for="task in detail.barTasks" :key="task.id" class="card" style="margin-bottom: 10px">
            <div class="row" style="justify-content: space-between">
              <strong>第 {{ task.startBar }}–{{ task.endBar }} 小节 · {{ task.title }}</strong>
              <span class="badge" :class="task.progress.completionRatio === null ? 'badge-warning' : 'badge-success'">
                {{ task.progress.confirmedCount }}/{{ task.progress.eligibleCount }} · {{ formatRatio(task.progress.completionRatio) }}
              </span>
            </div>
            <p v-if="task.progress.excludedAssignees.length" style="margin: 6px 0; color: var(--color-text-muted, #888)">
              不计入完成度：{{ task.progress.excludedAssignees.map((e) => `${memberLabel(e.memberId)}（${attendanceLabel[e.attendance]}）`).join("、") }}
            </p>
            <div class="row" style="gap: 6px; flex-wrap: wrap; margin-top: 6px">
              <template v-for="memberId in task.assignees" :key="memberId">
                <button
                  class="button small"
                  :class="task.checkins.some((c) => c.memberId === memberId && c.done) ? '' : 'ghost'"
                  :disabled="busy || memberId !== myMemberId"
                  :title="memberId === myMemberId ? '确认你的小节完成状态' : '只有成员本人或团长可以确认'"
                  @click="toggleConfirm(task.id, memberId, !task.checkins.some((c) => c.memberId === memberId && c.done))"
                >
                  {{ memberLabel(memberId) }}：{{ task.checkins.some((c) => c.memberId === memberId && c.done) ? "已完成" : "待确认" }}
                </button>
              </template>
              <span v-if="task.assignees.length === 0" style="color: var(--color-text-muted, #888)">尚未指派人</span>
            </div>
          </div>
        </div>

        <div v-if="offlineQueue.length > 0" class="card" style="margin-top: 12px">
          <h2 class="card-title">离线待同步（{{ offlineQueue.length }}）</h2>
          <ul>
            <li v-for="event in offlineQueue" :key="event.clientEventId">
              <span class="badge">{{ event.op === "UPSERT_ATTENDANCE" ? "点名" : "小节确认" }}</span>
              {{ event.op === "UPSERT_ATTENDANCE" ? `${memberLabel(event.memberId)} → ${event.status ? attendanceLabel[event.status] : ""}` : `${memberLabel(event.memberId)} 确认小节 ${event.barTaskId?.slice(0, 8)}` }}
              <small style="margin-left: 8px">{{ new Date(event.occurredAt).toLocaleTimeString() }}</small>
              <button class="button small ghost" @click="dropOfflineEvent(event.clientEventId)">移除</button>
            </li>
          </ul>
          <button class="button" :disabled="busy || !online" @click="flushQueue">
            {{ online ? "立即同步（幂等合并）" : "恢复网络后可同步" }}
          </button>
        </div>
      </template>
    </template>
  </section>
</template>
