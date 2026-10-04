<script setup lang="ts">
import { onMounted, ref } from "vue";
import { apiFetch, ApiError } from "../api/client.js";
import EmptyState from "../components/EmptyState.vue";
import LoadingBlock from "../components/LoadingBlock.vue";
import { formatDateTime } from "../utils/format.js";

interface NotificationRow {
  id: string;
  status: "UNREAD" | "READ";
  notification: {
    id: string;
    type: string;
    title: string;
    body: string | null;
    changeSeq: number;
    rehearsalId: string;
    createdAt: string;
  };
}

const items = ref<NotificationRow[]>([]);
const unreadCount = ref(0);
const loading = ref(true);
const error = ref("");

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const result = await apiFetch<{ data: NotificationRow[]; unreadCount: number }>("/api/v1/notifications?limit=50");
    items.value = result.data;
    unreadCount.value = result.unreadCount;
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "通知加载失败";
  } finally {
    loading.value = false;
  }
}

async function markAllRead(): Promise<void> {
  await apiFetch("/api/v1/notifications/read", { method: "POST", body: JSON.stringify({ all: true }) });
  await load();
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>排练通知</h1>
        <p>每次变更只通知一次；重复提交与离线回放命中同一变更指纹时不会产生重复通知。</p>
      </div>
      <button v-if="unreadCount > 0" class="button secondary" type="button" @click="markAllRead">全部标为已读（{{ unreadCount }}）</button>
    </div>

    <div v-if="loading"><LoadingBlock /></div>
    <div v-else-if="error" class="alert">{{ error }}</div>
    <EmptyState v-else-if="items.length === 0" title="暂无通知" description="排练安排、到勤与小节任务变更会出现在这里。" />
    <div v-else class="stack">
      <RouterLink v-for="item in items" :key="item.id" class="card notification-row" :class="{ unread: item.status === 'UNREAD' }"
        :to="`/rehearsals/${item.notification.rehearsalId}`">
        <div>
          <div class="row">
            <strong>{{ item.notification.title }}</strong>
            <span v-if="item.status === 'UNREAD'" class="unread-dot"></span>
            <span class="badge">#{{ item.notification.changeSeq }}</span>
          </div>
          <p v-if="item.notification.body" class="muted" style="margin: 6px 0 0">{{ item.notification.body }}</p>
          <small class="muted">{{ formatDateTime(item.notification.createdAt) }}</small>
        </div>
      </RouterLink>
    </div>
  </div>
</template>

<style scoped>
.notification-row { text-decoration: none; color: inherit; display: block; }
.notification-row.unread { border-color: var(--primary); background: #f4faf8; }
.unread-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--primary); }
</style>
