<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { apiFetch, ApiError } from "../api/client.js";
import LoadingBlock from "../components/LoadingBlock.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { useAttendanceQueueStore } from "../stores/attendanceQueue.js";
import {
  attendanceLabels,
  barTaskStatusLabels,
  formatDateTime,
  formatPercent,
} from "../utils/format.js";

interface AttendanceRow {
  id: string;
  memberId: string;
  status: keyof typeof attendanceLabels;
  respondedOffline: boolean;
  note: string | null;
  member: { displayName: string; part: string; instrument: string; userId: string | null };
}
interface BarTask {
  id: string;
  startBar: number;
  endBar: number;
  title: string;
  focus: string | null;
  status: keyof typeof barTaskStatusLabels;
  version: number;
  assignee: { id: string; displayName: string; part: string; instrument: string } | null;
}
interface Summary {
  memberCount: number;
  attendance: Record<string, number> & { respondedOffline: number; presentTotal: number; missingTotal: number };
  parts: Array<{ part: string; instrument: string; members: number; present: number; absent: number; pending: number }>;
  tasks: {
    total: number; done: number; inProgress: number; notStarted: number; skipped: number;
    totalBars: number; doneBars: number;
    accountableTotal: number; accountableDone: number;
    completionRate: number; barWeightedCompletionRate: number;
  };
  unresolvedMembers: string[];
  members: Array<{
    memberId: string | null; displayName: string; part: string; instrument: string;
    attendanceStatus: keyof typeof attendanceLabels; respondedOffline: boolean;
    assignedTotal: number; assignedBars: number; doneTotal: number; doneBars: number;
    suspectDoneWhileAbsent: number;
  }>;
}
interface Rehearsal {
  id: string; title: string; piece: string | null; location: string | null;
  startsAt: string; endsAt: string; status: string; version: number;
}

const route = useRoute();
const rehearsalId = computed(() => String(route.params.rehearsalId));
const queue = useAttendanceQueueStore();

const loading = ref(true);
const error = ref("");
const rehearsal = ref<Rehearsal | null>(null);
const attendance = ref<AttendanceRow[]>([]);
const barTasks = ref<BarTask[]>([]);
const summary = ref<Summary | null>(null);
const tab = ref<"summary" | "attendance" | "tasks">("summary");

const currentUserId = ref<string | null>(null);
const myMemberId = ref<string | null>(null);
const myAttendance = ref<AttendanceRow | null>(null);

const taskForm = ref({ startBar: "", endBar: "", title: "", focus: "", assigneeId: "" });
const taskSaving = ref(false);
const taskError = ref("");

const memberById = computed(() => new Map(summary.value?.members.map((m) => [m.memberId, m])));
const memberOptions = computed(() =>
  (summary.value?.members ?? []).filter((m): m is typeof m & { memberId: string } => Boolean(m.memberId)),
);

async function loadCurrentUser(): Promise<void> {
  try {
    currentUserId.value = (await apiFetch<{ user: { id: string } }>("/api/v1/users/me")).user.id;
  } catch {
    currentUserId.value = null;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const [detail, att, taskList, sum] = await Promise.all([
      apiFetch<{ rehearsal: Rehearsal }>(`/api/v1/rehearsals/${rehearsalId.value}`),
      apiFetch<{ data: AttendanceRow[] }>(`/api/v1/rehearsals/${rehearsalId.value}/attendance`),
      apiFetch<{ data: BarTask[] }>(`/api/v1/rehearsals/${rehearsalId.value}/bar-tasks`),
      apiFetch<{ rehearsal: Rehearsal; summary: Summary }>(`/api/v1/rehearsals/${rehearsalId.value}/summary`),
    ]);
    rehearsal.value = detail.rehearsal;
    attendance.value = att.data;
    barTasks.value = taskList.data;
    summary.value = sum.summary;
    myAttendance.value = att.data.find((row) => row.member.userId === currentUserId.value) ?? null;
    myMemberId.value = myAttendance.value?.memberId ?? null;
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "排练详情加载失败";
  } finally {
    loading.value = false;
  }
}

async function respond(status: "CONFIRMED" | "DECLINED"): Promise<void> {
  if (!myMemberId.value) return;
  error.value = "";
  try {
    const result = await queue.submit({ rehearsalId: rehearsalId.value, memberId: myMemberId.value, status });
    if (result.queued) {
      // 离线：本地排队，UI 先反映意图
      const row = attendance.value.find((r) => r.id === myAttendance.value?.id);
      if (row) { row.status = status; row.respondedOffline = true; }
    } else {
      await load();
    }
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "到勤回复失败";
  }
}

async function rollCall(row: AttendanceRow, status: "PRESENT" | "LATE" | "ABSENT"): Promise<void> {
  error.value = "";
  const idempotencyKey = `rc-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
  try {
    await apiFetch(`/api/v1/rehearsals/${rehearsalId.value}/attendance/${row.memberId}/roll-call`, {
      method: "POST",
      body: JSON.stringify({ status, idempotencyKey }),
    });
    await load();
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "点名失败";
  }
}

async function createTask(): Promise<void> {
  taskError.value = "";
  const startBar = Number(taskForm.value.startBar);
  const endBar = Number(taskForm.value.endBar);
  if (!Number.isInteger(startBar) || !Number.isInteger(endBar) || endBar < startBar || !taskForm.value.title.trim()) {
    taskError.value = "请检查小节范围与标题";
    return;
  }
  taskSaving.value = true;
  try {
    await apiFetch(`/api/v1/rehearsals/${rehearsalId.value}/bar-tasks`, {
      method: "POST",
      body: JSON.stringify({
        startBar,
        endBar,
        title: taskForm.value.title.trim(),
        focus: taskForm.value.focus || null,
        assigneeId: taskForm.value.assigneeId || null,
      }),
    });
    taskForm.value = { startBar: "", endBar: "", title: "", focus: "", assigneeId: "" };
    await load();
  } catch (reason) {
    taskError.value = reason instanceof ApiError ? reason.message : "小节任务创建失败";
  } finally {
    taskSaving.value = false;
  }
}

async function cycleTaskStatus(task: BarTask): Promise<void> {
  error.value = "";
  const order = ["NOT_STARTED", "IN_PROGRESS", "DONE", "SKIPPED"] as const;
  const next = order[(order.indexOf(task.status) + 1) % order.length] as BarTask["status"];
  const idempotencyKey = `bt-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
  try {
    await apiFetch(`/api/v1/bar-tasks/${task.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: next, version: task.version, idempotencyKey }),
    });
    await load();
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "任务状态更新失败";
  }
}

onMounted(async () => {
  await loadCurrentUser();
  await load();
});
</script>

<template>
  <div class="page">
    <div v-if="loading"><LoadingBlock /></div>
    <template v-else-if="rehearsal && summary">
      <div class="page-header">
        <div>
          <button class="muted back-link" type="button" @click="$router.back()">← 返回</button>
          <h1>{{ rehearsal.title }}</h1>
          <p>
            {{ rehearsal.piece || "未指定曲目" }} · {{ rehearsal.location || "地点待定" }} ·
            {{ formatDateTime(rehearsal.startsAt) }} – {{ formatDateTime(rehearsal.endsAt) }}
          </p>
        </div>
        <StatusBadge :value="rehearsal.status" />
      </div>

      <div v-if="error" class="alert" style="margin-bottom: 16px">{{ error }}</div>
      <div v-if="queue.hasPending" class="alert warning" style="margin-bottom: 16px">
        有 {{ queue.pendingCount }} 条离线到勤回复待同步，恢复网络后将自动按提交时间合并——已点名的状态不会被覆盖。
        <button class="button small" type="button" style="margin-left: 10px" @click="queue.flush()">立即同步</button>
      </div>

      <!-- 我的到勤：在线 / 离线同一入口 -->
      <div v-if="myAttendance" class="card" style="margin-bottom: 18px">
        <div class="row between wrap">
          <div>
            <h3 style="margin: 0 0 4px">我的到勤</h3>
            <div class="row">
              <StatusBadge :value="myAttendance.status" />
              <span v-if="myAttendance.respondedOffline" class="badge">离线确认</span>
              <span v-if="!queue.online" class="badge">当前离线</span>
            </div>
          </div>
          <div class="row">
            <button class="button secondary" type="button" @click="respond('CONFIRMED')">✓ 确认参加</button>
            <button class="button ghost" type="button" @click="respond('DECLINED')">请假</button>
          </div>
        </div>
      </div>

      <div class="tabs" style="margin-bottom: 18px">
        <button class="tab" :class="{ active: tab === 'summary' }" type="button" @click="tab = 'summary'">汇总</button>
        <button class="tab" :class="{ active: tab === 'attendance' }" type="button" @click="tab = 'attendance'">到勤点名（{{ attendance.length }}）</button>
        <button class="tab" :class="{ active: tab === 'tasks' }" type="button" @click="tab = 'tasks'">小节任务（{{ barTasks.length }}）</button>
      </div>

      <!-- 汇总 -->
      <div v-if="tab === 'summary'" class="stack">
        <div class="grid grid-4">
          <div class="card metric"><strong>{{ summary.attendance.presentTotal }}/{{ summary.memberCount }}</strong><span>已到齐（含迟到）</span></div>
          <div class="card metric"><strong class="warn">{{ summary.attendance.missingTotal }}</strong><span>尚未到齐</span></div>
          <div class="card metric">
            <strong>{{ formatPercent(summary.tasks.completionRate) }}</strong>
            <span>任务完成度（已排除缺席/跳过）</span>
            <div class="progress-bar" style="margin-top: 6px"><span :style="{ width: formatPercent(summary.tasks.completionRate) }"></span></div>
          </div>
          <div class="card metric">
            <strong>{{ formatPercent(summary.tasks.barWeightedCompletionRate) }}</strong>
            <span>小节加权完成度（{{ summary.tasks.accountableDone }}/{{ summary.tasks.accountableTotal }} 个任务）</span>
            <div class="progress-bar" style="margin-top: 6px"><span :style="{ width: formatPercent(summary.tasks.barWeightedCompletionRate) }"></span></div>
          </div>
        </div>

        <div class="alert info">
          完成度口径：明确缺席（缺席/请假）成员名下的任务整体排除在分子与分母之外，
          缺席不会被算成「未完成」，缺席者自报的「已完成」也不会抬高完成度；已跳过任务同样排除。
        </div>

        <div class="grid grid-2">
          <div class="card">
            <div class="card-title"><h3>声部到齐</h3></div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>声部</th><th>乐器</th><th>人数</th><th>到场</th><th>缺席/请假</th><th>待回复</th></tr></thead>
                <tbody>
                  <tr v-for="part in summary.parts" :key="`${part.part}-${part.instrument}`">
                    <td><strong>{{ part.part }}</strong></td>
                    <td>{{ part.instrument }}</td>
                    <td>{{ part.members }}</td>
                    <td :class="part.present === part.members ? 'good' : ''">{{ part.present }}</td>
                    <td :class="part.absent > 0 ? 'bad' : ''">{{ part.absent }}</td>
                    <td>{{ part.pending }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="card">
            <div class="card-title"><h3>成员任务明细</h3></div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>成员</th><th>声部</th><th>到勤</th><th>任务完成</th><th>小节</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="row in summary.members" :key="row.memberId ?? `unassigned-${row.displayName}`">
                    <td>{{ row.displayName }}</td>
                    <td>{{ row.part }}</td>
                    <td><StatusBadge :value="row.attendanceStatus" /></td>
                    <td>{{ row.doneTotal }}/{{ row.assignedTotal }}</td>
                    <td>{{ row.doneBars }}/{{ row.assignedBars }}</td>
                    <td>
                      <span v-if="row.suspectDoneWhileAbsent > 0" class="badge ABSENT" :title="'缺席却有任务标记完成，排练后需核实'">
                        ⚠ {{ row.suspectDoneWhileAbsent }} 条待核实
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <!-- 到勤点名 -->
      <div v-else-if="tab === 'attendance'" class="card">
        <div class="card-title"><h3>到勤状态</h3><span class="muted">组织者点名结果优先；成员回复不会覆盖已点名状态</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>成员</th><th>声部 / 乐器</th><th>状态</th><th>备注</th><th>点名</th></tr></thead>
            <tbody>
              <tr v-for="row in attendance" :key="row.id">
                <td><strong>{{ row.member.displayName }}</strong></td>
                <td>{{ row.member.part }} · {{ row.member.instrument }}</td>
                <td>
                  <div class="row">
                    <StatusBadge :value="row.status" />
                    <span v-if="row.respondedOffline" class="badge">离线</span>
                  </div>
                </td>
                <td class="muted">{{ row.note || "—" }}</td>
                <td>
                  <div class="row">
                    <button class="button small secondary" type="button" @click="rollCall(row, 'PRESENT')">到场</button>
                    <button class="button small ghost" type="button" @click="rollCall(row, 'LATE')">迟到</button>
                    <button class="button small danger" type="button" @click="rollCall(row, 'ABSENT')">缺席</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 小节任务 -->
      <div v-else class="grid grid-2">
        <div class="card">
          <div class="card-title"><h3>小节任务（按小节排序）</h3></div>
          <div v-if="barTasks.length === 0" class="empty">还没有小节任务。</div>
          <div v-else class="stack">
            <div v-for="task in barTasks" :key="task.id" class="task-row" :class="task.status">
              <div>
                <div class="row">
                  <span class="badge bar-badge">{{ task.startBar }}-{{ task.endBar }} 小节</span>
                  <strong>{{ task.title }}</strong>
                </div>
                <div class="muted">{{ task.focus || "无重点说明" }}</div>
                <div class="muted" v-if="task.assignee">指派：{{ task.assignee.displayName }}（{{ task.assignee.part }}）</div>
              </div>
              <div class="row">
                <button class="button small ghost" type="button" @click="cycleTaskStatus(task)">
                  {{ barTaskStatusLabels[task.status] }} ↻
                </button>
              </div>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-title"><h3>新建小节任务</h3></div>
          <div v-if="taskError" class="alert" style="margin-bottom: 12px">{{ taskError }}</div>
          <form class="stack" @submit.prevent="createTask">
            <div class="grid grid-2">
              <label class="field"><span>起始小节</span><input v-model="taskForm.startBar" type="number" min="1" required /></label>
              <label class="field"><span>结束小节</span><input v-model="taskForm.endBar" type="number" min="1" required /></label>
            </div>
            <label class="field"><span>任务标题</span><input v-model="taskForm.title" maxlength="160" placeholder="主题进入的弓法统一" required /></label>
            <label class="field"><span>练习重点</span><input v-model="taskForm.focus" maxlength="500" /></label>
            <label class="field">
              <span>指派成员</span>
              <select v-model="taskForm.assigneeId">
                <option value="">不指派（全体）</option>
                <option v-for="m in memberOptions" :key="m.memberId" :value="m.memberId ?? ''">{{ m.displayName }} · {{ m.part }}</option>
              </select>
            </label>
            <div class="row end"><button class="button" type="submit" :disabled="taskSaving">{{ taskSaving ? "创建中…" : "＋ 添加任务" }}</button></div>
          </form>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.back-link { background: none; border: 0; padding: 0; cursor: pointer; font-size: .92rem; }
.warn { color: var(--warning); }
.good { color: var(--primary); font-weight: 750; }
.bad { color: var(--danger); font-weight: 750; }
.task-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 13px 14px; border: 1px solid var(--line); border-radius: 12px; }
.task-row.DONE { border-color: #b8dcc9; background: #f2f9f5; }
.task-row.SKIPPED { opacity: .65; }
.bar-badge { font-variant-numeric: tabular-nums; }
</style>
