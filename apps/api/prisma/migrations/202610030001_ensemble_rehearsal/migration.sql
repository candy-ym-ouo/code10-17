-- CreateEnum
CREATE TYPE "EnsembleMemberRole" AS ENUM ('OWNER', 'CONDUCTOR', 'MEMBER');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DECLINED', 'PRESENT', 'LATE', 'ABSENT');

-- CreateEnum
CREATE TYPE "RehearsalStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BarTaskStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'DONE', 'SKIPPED');

-- CreateEnum
CREATE TYPE "RehearsalNotificationType" AS ENUM (
  'REHEARSAL_CREATED',
  'REHEARSAL_UPDATED',
  'REHEARSAL_CANCELLED',
  'MEMBER_ADDED',
  'MEMBER_REMOVED',
  'ATTENDANCE_UPDATED',
  'BAR_TASK_ASSIGNED',
  'BAR_TASK_UPDATED'
);

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('UNREAD', 'READ');

-- CreateTable
CREATE TABLE "ensembles" (
  "id"          UUID         NOT NULL,
  "owner_id"    UUID         NOT NULL,
  "name"        VARCHAR(120) NOT NULL,
  "description" TEXT,
  "version"     INTEGER      NOT NULL DEFAULT 0,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ensembles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ensemble_members" (
  "id"           UUID                 NOT NULL,
  "ensemble_id"  UUID                 NOT NULL,
  "user_id"      UUID,
  "display_name" VARCHAR(80)          NOT NULL,
  "instrument"   VARCHAR(60)          NOT NULL,
  "part"         VARCHAR(120)         NOT NULL,
  "role"         "EnsembleMemberRole" NOT NULL DEFAULT 'MEMBER',
  "is_active"    BOOLEAN              NOT NULL DEFAULT true,
  "left_at"      TIMESTAMPTZ(6),
  "version"      INTEGER              NOT NULL DEFAULT 0,
  "created_at"   TIMESTAMPTZ(6)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMPTZ(6)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ensemble_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rehearsals" (
  "id"          UUID              NOT NULL,
  "ensemble_id" UUID              NOT NULL,
  "title"       VARCHAR(120)      NOT NULL,
  "piece"       VARCHAR(160),
  "location"    VARCHAR(120),
  "starts_at"   TIMESTAMPTZ(6)    NOT NULL,
  "ends_at"     TIMESTAMPTZ(6)    NOT NULL,
  "status"      "RehearsalStatus" NOT NULL DEFAULT 'SCHEDULED',
  "notes"       TEXT,
  "notification_seq" INTEGER    NOT NULL DEFAULT 0,
  "version"     INTEGER           NOT NULL DEFAULT 0,
  "created_at"  TIMESTAMPTZ(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rehearsals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_records" (
  "id"                UUID               NOT NULL,
  "rehearsal_id"      UUID               NOT NULL,
  "member_id"         UUID               NOT NULL,
  "status"            "AttendanceStatus" NOT NULL DEFAULT 'PENDING',
  "responded_offline" BOOLEAN            NOT NULL DEFAULT false,
  "responded_at"      TIMESTAMPTZ(6),
  "note"              VARCHAR(500),
  "client_updated_at" TIMESTAMPTZ(6),
  "created_at"        TIMESTAMPTZ(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMPTZ(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bar_tasks" (
  "id"            UUID           NOT NULL,
  "rehearsal_id"  UUID           NOT NULL,
  "assignee_id"   UUID,
  "start_bar"     INTEGER        NOT NULL,
  "end_bar"       INTEGER        NOT NULL,
  "title"         VARCHAR(160)   NOT NULL,
  "focus"         VARCHAR(500),
  "status"        "BarTaskStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "completed_at"  TIMESTAMPTZ(6),
  "version"       INTEGER        NOT NULL DEFAULT 0,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bar_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rehearsal_notifications" (
  "id"           UUID                         NOT NULL,
  "rehearsal_id" UUID                         NOT NULL,
  "type"         "RehearsalNotificationType" NOT NULL,
  "change_seq"   INTEGER                      NOT NULL,
  "dedupe_key"   VARCHAR(160)                 NOT NULL,
  "actor_id"     UUID,
  "title"        VARCHAR(160)                 NOT NULL,
  "body"         TEXT,
  "payload"      JSONB,
  "created_at"   TIMESTAMPTZ(6)               NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rehearsal_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivered_notifications" (
  "id"              UUID                 NOT NULL,
  "notification_id" UUID                 NOT NULL,
  "user_id"         UUID                 NOT NULL,
  "status"          "NotificationStatus" NOT NULL DEFAULT 'UNREAD',
  "read_at"         TIMESTAMPTZ(6),
  "created_at"      TIMESTAMPTZ(6)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "delivered_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ensembles_owner_id_idx" ON "ensembles"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "ensemble_members_ensemble_id_user_id_key" ON "ensemble_members"("ensemble_id", "user_id");
CREATE INDEX "ensemble_members_user_id_idx" ON "ensemble_members"("user_id");
CREATE INDEX "ensemble_members_ensemble_id_is_active_idx" ON "ensemble_members"("ensemble_id", "is_active");

-- CreateIndex
CREATE INDEX "rehearsals_ensemble_id_starts_at_idx" ON "rehearsals"("ensemble_id", "starts_at" DESC);
CREATE INDEX "rehearsals_status_starts_at_idx" ON "rehearsals"("status", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_rehearsal_id_member_id_key" ON "attendance_records"("rehearsal_id", "member_id");
CREATE INDEX "attendance_records_member_id_status_idx" ON "attendance_records"("member_id", "status");

-- CreateIndex
CREATE INDEX "bar_tasks_rehearsal_id_start_bar_idx" ON "bar_tasks"("rehearsal_id", "start_bar");
CREATE INDEX "bar_tasks_assignee_id_status_idx" ON "bar_tasks"("assignee_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rehearsal_notifications_dedupe_key_key" ON "rehearsal_notifications"("dedupe_key");
CREATE INDEX "rehearsal_notifications_rehearsal_id_change_seq_idx" ON "rehearsal_notifications"("rehearsal_id", "change_seq");

-- CreateIndex
CREATE UNIQUE INDEX "delivered_notifications_notification_id_user_id_key" ON "delivered_notifications"("notification_id", "user_id");
CREATE INDEX "delivered_notifications_user_id_status_created_at_idx" ON "delivered_notifications"("user_id", "status", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "ensembles" ADD CONSTRAINT "ensembles_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ensemble_members" ADD CONSTRAINT "ensemble_members_ensemble_id_fkey"
  FOREIGN KEY ("ensemble_id") REFERENCES "ensembles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ensemble_members" ADD CONSTRAINT "ensemble_members_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "rehearsals" ADD CONSTRAINT "rehearsals_ensemble_id_fkey"
  FOREIGN KEY ("ensemble_id") REFERENCES "ensembles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_rehearsal_id_fkey"
  FOREIGN KEY ("rehearsal_id") REFERENCES "rehearsals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_member_id_fkey"
  FOREIGN KEY ("member_id") REFERENCES "ensemble_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bar_tasks" ADD CONSTRAINT "bar_tasks_rehearsal_id_fkey"
  FOREIGN KEY ("rehearsal_id") REFERENCES "rehearsals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bar_tasks" ADD CONSTRAINT "bar_tasks_assignee_id_fkey"
  FOREIGN KEY ("assignee_id") REFERENCES "ensemble_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "rehearsal_notifications" ADD CONSTRAINT "rehearsal_notifications_rehearsal_id_fkey"
  FOREIGN KEY ("rehearsal_id") REFERENCES "rehearsals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delivered_notifications" ADD CONSTRAINT "delivered_notifications_notification_id_fkey"
  FOREIGN KEY ("notification_id") REFERENCES "rehearsal_notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delivered_notifications" ADD CONSTRAINT "delivered_notifications_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "idempotency_records" (
  "id"              UUID         NOT NULL,
  "user_id"         UUID         NOT NULL,
  "idempotency_key" VARCHAR(80)  NOT NULL,
  "scope"           VARCHAR(160) NOT NULL,
  "request_hash"    CHAR(8)      NOT NULL,
  "status_code"     INTEGER      NOT NULL,
  "response_body"   JSONB,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_user_id_scope_idempotency_key_key"
  ON "idempotency_records"("user_id", "scope", "idempotency_key");
CREATE INDEX "idempotency_records_created_at_idx" ON "idempotency_records"("created_at");
