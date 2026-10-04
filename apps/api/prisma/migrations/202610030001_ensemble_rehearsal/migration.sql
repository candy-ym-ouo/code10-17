-- CreateEnum
CREATE TYPE "EnsembleMemberRole" AS ENUM ('OWNER', 'MEMBER');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "BarTaskStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RehearsalChangeKind" AS ENUM ('REHEARSAL_CREATED', 'REHEARSAL_UPDATED', 'REHEARSAL_CANCELLED', 'ATTENDANCE_CHANGED', 'BAR_TASK_CREATED', 'BAR_TASK_UPDATED', 'BAR_TASK_DELETED', 'BAR_TASK_CONFIRMED');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'READ');

-- CreateTable
CREATE TABLE "ensembles" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ensembles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ensemble_members" (
    "id" UUID NOT NULL,
    "ensemble_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "part" VARCHAR(60),
    "role" "EnsembleMemberRole" NOT NULL DEFAULT 'MEMBER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ensemble_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rehearsals" (
    "id" UUID NOT NULL,
    "ensemble_id" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "scheduled_start" TIMESTAMPTZ(6) NOT NULL,
    "scheduled_end" TIMESTAMPTZ(6) NOT NULL,
    "location" VARCHAR(120),
    "notes" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rehearsals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rehearsal_attendances" (
    "id" UUID NOT NULL,
    "rehearsal_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "status" "AttendanceStatus" NOT NULL DEFAULT 'UNKNOWN',
    "note" VARCHAR(500),
    "client_event_id" VARCHAR(80),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rehearsal_attendances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bar_tasks" (
    "id" UUID NOT NULL,
    "rehearsal_id" UUID NOT NULL,
    "start_bar" INTEGER NOT NULL,
    "end_bar" INTEGER NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "instruction" TEXT,
    "status" "BarTaskStatus" NOT NULL DEFAULT 'OPEN',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bar_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bar_task_assignees" (
    "id" UUID NOT NULL,
    "bar_task_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bar_task_assignees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bar_task_checkins" (
    "id" UUID NOT NULL,
    "bar_task_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "done" BOOLEAN NOT NULL,
    "note" VARCHAR(1000),
    "client_event_id" VARCHAR(80),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bar_task_checkins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rehearsal_change_events" (
    "id" UUID NOT NULL,
    "rehearsal_id" UUID NOT NULL,
    "actor_member_id" UUID,
    "kind" "RehearsalChangeKind" NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "idempotency_key" VARCHAR(80),
    "version_snapshot" INTEGER NOT NULL,
    "payload" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rehearsal_change_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rehearsal_notifications" (
    "id" UUID NOT NULL,
    "rehearsal_id" UUID NOT NULL,
    "change_event_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rehearsal_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- 离线事件幂等账本：含 LWW 落败事件，保证被覆盖后重试仍识别为重放
CREATE TABLE "rehearsal_processed_events" (
    "id" UUID NOT NULL,
    "rehearsal_id" UUID NOT NULL,
    "client_event_id" VARCHAR(80) NOT NULL,
    "kind" "RehearsalChangeKind" NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rehearsal_processed_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ensemble_members_ensemble_id_user_id_key" ON "ensemble_members"("ensemble_id", "user_id");

-- CreateIndex
CREATE INDEX "ensemble_members_ensemble_id_active_idx" ON "ensemble_members"("ensemble_id", "active");

-- CreateIndex
CREATE INDEX "rehearsals_ensemble_id_scheduled_start_idx" ON "rehearsals"("ensemble_id", "scheduled_start");

-- CreateIndex
CREATE UNIQUE INDEX "rehearsal_attendances_rehearsal_id_member_id_key" ON "rehearsal_attendances"("rehearsal_id", "member_id");

-- CreateIndex
-- client_event_id 为 NULL 时 Postgres 不限制重复，仅离线事件参与去重
CREATE UNIQUE INDEX "attendance_event_idempotency" ON "rehearsal_attendances"("rehearsal_id", "client_event_id");

-- CreateIndex
CREATE INDEX "rehearsal_attendances_rehearsal_id_status_idx" ON "rehearsal_attendances"("rehearsal_id", "status");

-- CreateIndex
CREATE INDEX "bar_tasks_rehearsal_id_start_bar_idx" ON "bar_tasks"("rehearsal_id", "start_bar");

-- CreateIndex
CREATE UNIQUE INDEX "bar_task_assignees_bar_task_id_member_id_key" ON "bar_task_assignees"("bar_task_id", "member_id");

-- CreateIndex
CREATE INDEX "bar_task_assignees_member_id_idx" ON "bar_task_assignees"("member_id");

-- CreateIndex
CREATE UNIQUE INDEX "bar_task_checkins_bar_task_id_member_id_key" ON "bar_task_checkins"("bar_task_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "checkin_event_idempotency" ON "bar_task_checkins"("bar_task_id", "client_event_id");

-- CreateIndex
CREATE INDEX "bar_task_checkins_bar_task_id_done_idx" ON "bar_task_checkins"("bar_task_id", "done");

-- CreateIndex
CREATE UNIQUE INDEX "change_event_fingerprint" ON "rehearsal_change_events"("rehearsal_id", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "change_event_idempotency_key" ON "rehearsal_change_events"("idempotency_key");

-- CreateIndex
CREATE INDEX "rehearsal_change_events_rehearsal_id_created_at_idx" ON "rehearsal_change_events"("rehearsal_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "rehearsal_notifications_change_event_id_recipient_id_key" ON "rehearsal_notifications"("change_event_id", "recipient_id");

-- CreateIndex
CREATE INDEX "rehearsal_notifications_recipient_id_status_created_at_idx" ON "rehearsal_notifications"("recipient_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "rehearsal_processed_events_rehearsal_id_client_event_id_key" ON "rehearsal_processed_events"("rehearsal_id", "client_event_id");

-- CreateIndex
CREATE INDEX "rehearsal_processed_events_rehearsal_id_processed_at_idx" ON "rehearsal_processed_events"("rehearsal_id", "processed_at");

-- AddForeignKey
ALTER TABLE "ensembles" ADD CONSTRAINT "ensembles_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ensemble_members" ADD CONSTRAINT "ensemble_members_ensemble_id_fkey" FOREIGN KEY ("ensemble_id") REFERENCES "ensembles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ensemble_members" ADD CONSTRAINT "ensemble_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rehearsals" ADD CONSTRAINT "rehearsals_ensemble_id_fkey" FOREIGN KEY ("ensemble_id") REFERENCES "ensembles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rehearsal_attendances" ADD CONSTRAINT "rehearsal_attendances_rehearsal_id_fkey" FOREIGN KEY ("rehearsal_id") REFERENCES "rehearsals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rehearsal_attendances" ADD CONSTRAINT "rehearsal_attendances_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "ensemble_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bar_tasks" ADD CONSTRAINT "bar_tasks_rehearsal_id_fkey" FOREIGN KEY ("rehearsal_id") REFERENCES "rehearsals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bar_task_assignees" ADD CONSTRAINT "bar_task_assignees_bar_task_id_fkey" FOREIGN KEY ("bar_task_id") REFERENCES "bar_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bar_task_assignees" ADD CONSTRAINT "bar_task_assignees_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "ensemble_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bar_task_checkins" ADD CONSTRAINT "bar_task_checkins_bar_task_id_fkey" FOREIGN KEY ("bar_task_id") REFERENCES "bar_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bar_task_checkins" ADD CONSTRAINT "bar_task_checkins_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "ensemble_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rehearsal_change_events" ADD CONSTRAINT "rehearsal_change_events_rehearsal_id_fkey" FOREIGN KEY ("rehearsal_id") REFERENCES "rehearsals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rehearsal_notifications" ADD CONSTRAINT "rehearsal_notifications_rehearsal_id_fkey" FOREIGN KEY ("rehearsal_id") REFERENCES "rehearsals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rehearsal_notifications" ADD CONSTRAINT "rehearsal_notifications_change_event_id_fkey" FOREIGN KEY ("change_event_id") REFERENCES "rehearsal_change_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rehearsal_notifications" ADD CONSTRAINT "rehearsal_notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "ensemble_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rehearsal_processed_events" ADD CONSTRAINT "rehearsal_processed_events_rehearsal_id_fkey" FOREIGN KEY ("rehearsal_id") REFERENCES "rehearsals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
