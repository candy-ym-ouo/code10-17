<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { apiFetch, ApiError } from "../api/client.js";
import LoadingBlock from "../components/LoadingBlock.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { formatDateTime } from "../utils/format.js";

interface Member {
  id: string;
  userId: string | null;
  displayName: string;
  instrument: string;
  part: string;
  role: "OWNER" | "CONDUCTOR" | "MEMBER";
}
interface Rehearsal {
  id: string;
  title: string;
  piece: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  status: "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
}
interface Ensemble {
  id: string;
  name: string;
  description: string | null;
  members: Member[];
  rehearsals: Rehearsal[];
}

const route = useRoute();
const ensembleId = computed(() => String(route.params.ensembleId));
const ensemble = ref<Ensemble | null>(null);
const loading = ref(true);
const error = ref("");
const tab = ref<"members" | "rehearsals">("members");

const memberForm = ref({ displayName: "", instrument: "", part: "", role: "MEMBER" as Member["role"] });
const memberSaving = ref(false);
const memberError = ref("");

const rehearsalForm = ref({
  title: "",
  piece: "",
  location: "",
  startsAt: "",
  endsAt: "",
  notes: "",
});
const rehearsalSaving = ref(false);
const rehearsalError = ref("");

const roleLabels: Record<Member["role"], string> = { OWNER: "组织者", CONDUCTOR: "指挥", MEMBER: "成员" };

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    ensemble.value = (await apiFetch<{ ensemble: Ensemble }>(`/api/v1/ensembles/${ensembleId.value}`)).ensemble;
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "合奏加载失败";
  } finally {
    loading.value = false;
  }
}

async function addMember(): Promise<void> {
  memberError.value = "";
  if (!memberForm.value.displayName.trim() || !memberForm.value.instrument.trim() || !memberForm.value.part.trim()) {
    memberError.value = "姓名、乐器与声部都必填";
    return;
  }
  memberSaving.value = true;
  try {
    await apiFetch(`/api/v1/ensembles/${ensembleId.value}/members`, {
      method: "POST",
      body: JSON.stringify({
        displayName: memberForm.value.displayName.trim(),
        instrument: memberForm.value.instrument.trim(),
        part: memberForm.value.part.trim(),
        role: memberForm.value.role,
      }),
    });
    memberForm.value = { displayName: "", instrument: "", part: "", role: "MEMBER" };
    await load();
  } catch (reason) {
    memberError.value = reason instanceof ApiError ? reason.message : "添加成员失败";
  } finally {
    memberSaving.value = false;
  }
}

async function createRehearsal(): Promise<void> {
  rehearsalError.value = "";
  const f = rehearsalForm.value;
  if (!f.title.trim() || !f.startsAt || !f.endsAt) {
    rehearsalError.value = "标题与起止时间必填";
    return;
  }
  rehearsalSaving.value = true;
  try {
    await apiFetch(`/api/v1/ensembles/${ensembleId.value}/rehearsals`, {
      method: "POST",
      body: JSON.stringify({
        title: f.title.trim(),
        piece: f.piece || null,
        location: f.location || null,
        startsAt: new Date(f.startsAt).toISOString(),
        endsAt: new Date(f.endsAt).toISOString(),
        notes: f.notes || null,
      }),
    });
    rehearsalForm.value = { title: "", piece: "", location: "", startsAt: "", endsAt: "", notes: "" };
    await load();
    tab.value = "rehearsals";
  } catch (reason) {
    rehearsalError.value = reason instanceof ApiError ? reason.message : "创建排练失败";
  } finally {
    rehearsalSaving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div v-if="loading"><LoadingBlock /></div>
    <template v-else-if="ensemble">
      <div class="page-header">
        <div>
          <RouterLink class="muted" to="/ensembles">← 合奏列表</RouterLink>
          <h1>{{ ensemble.name }}</h1>
          <p>{{ ensemble.description || "暂无简介" }}</p>
        </div>
      </div>

      <div class="tabs" style="margin-bottom: 18px">
        <button class="tab" :class="{ active: tab === 'members' }" type="button" @click="tab = 'members'">
          成员与声部（{{ ensemble.members.length }}）
        </button>
        <button class="tab" :class="{ active: tab === 'rehearsals' }" type="button" @click="tab = 'rehearsals'">
          排练（{{ ensemble.rehearsals.length }}）
        </button>
      </div>

      <div v-if="error" class="alert">{{ error }}</div>

      <div v-if="tab === 'members'" class="grid grid-2">
        <div class="card">
          <div class="card-title"><h3>成员声部一览</h3></div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>姓名</th><th>声部</th><th>乐器</th><th>角色</th></tr></thead>
              <tbody>
                <tr v-for="member in ensemble.members" :key="member.id">
                  <td><strong>{{ member.displayName }}</strong></td>
                  <td>{{ member.part }}</td>
                  <td>{{ member.instrument }}</td>
                  <td><span class="badge">{{ roleLabels[member.role] }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <div class="card-title"><h3>添加成员</h3></div>
          <div v-if="memberError" class="alert" style="margin-bottom: 12px">{{ memberError }}</div>
          <form class="stack" @submit.prevent="addMember">
            <label class="field"><span>姓名</span><input v-model="memberForm.displayName" maxlength="80" required /></label>
            <div class="grid grid-2">
              <label class="field"><span>声部</span><input v-model="memberForm.part" maxlength="120" placeholder="一提琴 / 中提琴" required /></label>
              <label class="field"><span>乐器</span><input v-model="memberForm.instrument" maxlength="60" placeholder="小提琴" required /></label>
            </div>
            <label class="field">
              <span>角色</span>
              <select v-model="memberForm.role">
                <option value="MEMBER">成员</option>
                <option value="CONDUCTOR">指挥</option>
                <option value="OWNER">组织者</option>
              </select>
            </label>
            <div class="row end"><button class="button" type="submit" :disabled="memberSaving">{{ memberSaving ? "保存中…" : "＋ 添加成员" }}</button></div>
          </form>
        </div>
      </div>

      <div v-else class="grid grid-2">
        <div class="card">
          <div class="card-title"><h3>排练安排</h3></div>
          <div v-if="ensemble.rehearsals.length === 0" class="empty">还没有排练，先在右侧安排一场。</div>
          <div v-else class="stack">
            <RouterLink v-for="rehearsal in ensemble.rehearsals" :key="rehearsal.id" class="rehearsal-row" :to="`/rehearsals/${rehearsal.id}`">
              <div>
                <strong>{{ rehearsal.title }}</strong>
                <div class="muted">{{ rehearsal.piece || "未指定曲目" }} · {{ rehearsal.location || "地点待定" }}</div>
                <div class="muted">{{ formatDateTime(rehearsal.startsAt) }}</div>
              </div>
              <StatusBadge :value="rehearsal.status" />
            </RouterLink>
          </div>
        </div>
        <div class="card">
          <div class="card-title"><h3>安排排练</h3></div>
          <div v-if="rehearsalError" class="alert" style="margin-bottom: 12px">{{ rehearsalError }}</div>
          <form class="stack" @submit.prevent="createRehearsal">
            <label class="field"><span>标题</span><input v-model="rehearsalForm.title" maxlength="120" placeholder="第一乐章 1-80 小节合排" required /></label>
            <div class="grid grid-2">
              <label class="field"><span>曲目</span><input v-model="rehearsalForm.piece" maxlength="160" /></label>
              <label class="field"><span>地点</span><input v-model="rehearsalForm.location" maxlength="120" /></label>
            </div>
            <div class="grid grid-2">
              <label class="field"><span>开始</span><input v-model="rehearsalForm.startsAt" type="datetime-local" required /></label>
              <label class="field"><span>结束</span><input v-model="rehearsalForm.endsAt" type="datetime-local" required /></label>
            </div>
            <label class="field"><span>说明</span><textarea v-model="rehearsalForm.notes" maxlength="4000"></textarea></label>
            <div class="row end"><button class="button" type="submit" :disabled="rehearsalSaving">{{ rehearsalSaving ? "创建中…" : "＋ 安排排练" }}</button></div>
          </form>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.rehearsal-row { display: flex; justify-content: space-between; align-items: center; gap: 14px; padding: 13px 14px; border: 1px solid var(--line); border-radius: 12px; text-decoration: none; color: inherit; }
.rehearsal-row:hover { border-color: var(--primary); background: var(--primary-soft); }
</style>
