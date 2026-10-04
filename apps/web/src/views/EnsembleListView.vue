<script setup lang="ts">
import { onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { apiFetch, ApiError } from "../api/client.js";
import EmptyState from "../components/EmptyState.vue";
import LoadingBlock from "../components/LoadingBlock.vue";

interface Ensemble {
  id: string;
  name: string;
  description: string | null;
  version: number;
  _count: { members: number; rehearsals: number };
}

const ensembles = ref<Ensemble[]>([]);
const loading = ref(true);
const error = ref("");
const creating = ref(false);
const form = ref({ name: "", description: "" });

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    ensembles.value = (await apiFetch<{ data: Ensemble[] }>("/api/v1/ensembles")).data;
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "合奏列表加载失败";
  } finally {
    loading.value = false;
  }
}

async function createEnsemble(): Promise<void> {
  if (!form.value.name.trim()) return;
  creating.value = true;
  error.value = "";
  try {
    await apiFetch("/api/v1/ensembles", {
      method: "POST",
      body: JSON.stringify({ name: form.value.name.trim(), description: form.value.description || null }),
    });
    form.value = { name: "", description: "" };
    await load();
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "创建合奏失败";
  } finally {
    creating.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>合奏排练</h1>
        <p>汇总成员声部、到齐状态与小节任务；通知按变更去重，离线回复恢复网络后自动合并。</p>
      </div>
    </div>

    <div v-if="loading"><LoadingBlock /></div>
    <div v-else class="stack">
      <div v-if="error" class="alert">{{ error }}</div>

      <div class="card">
        <div class="card-title"><h3>创建合奏</h3></div>
        <form class="form-grid" @submit.prevent="createEnsemble">
          <label class="field">
            <span>合奏名称</span>
            <input v-model="form.name" maxlength="120" placeholder="如：城市青年交响乐团" required />
          </label>
          <label class="field">
            <span>简介</span>
            <input v-model="form.description" maxlength="2000" placeholder="可选" />
          </label>
          <div class="field full row end">
            <button class="button" type="submit" :disabled="creating">{{ creating ? "创建中…" : "＋ 创建合奏" }}</button>
          </div>
        </form>
      </div>

      <EmptyState v-if="ensembles.length === 0" title="还没有合奏" description="创建一个合奏，添加成员声部并安排第一次排练。" />
      <div v-else class="grid grid-3">
        <RouterLink v-for="ensemble in ensembles" :key="ensemble.id" class="card ensemble-card" :to="`/ensembles/${ensemble.id}`">
          <div class="card-title">
            <h3>{{ ensemble.name }}</h3>
          </div>
          <p class="muted ensemble-desc">{{ ensemble.description || "暂无简介" }}</p>
          <div class="row wrap" style="margin-top: 12px">
            <span class="badge">{{ ensemble._count.members }} 名成员</span>
            <span class="badge">{{ ensemble._count.rehearsals }} 场排练</span>
          </div>
        </RouterLink>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ensemble-card { text-decoration: none; color: inherit; display: block; transition: transform .12s ease, box-shadow .12s ease; }
.ensemble-card:hover { transform: translateY(-2px); box-shadow: var(--shadow); }
.ensemble-desc { margin: 0; min-height: 2.6em; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
</style>
