# API 契约

基础路径：`/api/v1`。除注册、登录和刷新外，请求使用 `Authorization: Bearer <accessToken>`。

错误统一返回：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "请求字段不合法",
    "details": [],
    "traceId": "req-..."
  }
}
```

## 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/register` | 注册并返回 Access Token，同时设置 Refresh Cookie |
| POST | `/auth/login` | 登录并轮换 Refresh Cookie |
| POST | `/auth/refresh` | 使用 Cookie 轮换刷新令牌 |
| POST | `/auth/logout` | 撤销当前 Refresh Session 并清除 Cookie |

Refresh Cookie 路径为 `/api/v1/auth`，生产环境在 HTTPS 下自动使用 `Secure`。

## 用户与设置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/users/me` | 当前用户 |
| PATCH | `/users/me` | 更新展示名、默认乐器、时区和语言 |
| POST | `/users/me/password` | 修改密码并撤销其他会话 |

## 练习

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sessions` | 光标分页、搜索、筛选和排序 |
| POST | `/sessions` | 创建练习 |
| GET | `/sessions/:id` | 详情，包含音频、标记、目标和复盘 |
| PATCH | `/sessions/:id` | 乐观锁更新；请求必须带 `version` |
| POST | `/sessions/:id/start-review` | 存在已就绪音频时进入 `IN_REVIEW` |
| GET | `/sessions/:id/completion-check` | 返回结构化缺失项 |
| POST | `/sessions/:id/complete` | 原子完成复盘 |
| POST | `/sessions/:id/archive` | 归档已完成练习 |
| POST | `/sessions/:id/restore` | 恢复归档练习 |
| DELETE | `/sessions/:id` | 必须提交完整 `confirmationTitle` |

创建练习：

```json
{
  "title": "协奏曲第二乐章 17-24 小节",
  "instrument": "小提琴",
  "startedAt": "2026-09-29T12:00:00.000Z",
  "focus": "换把后的音准",
  "location": "琴房 A",
  "notes": "节拍器 84 BPM",
  "actualDurationMs": 1800000
}
```

## 音频上传

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/sessions/:sessionId/media/uploads` | 创建上传会话并返回预签名 PUT URL |
| POST | `/media/:mediaId/complete-upload` | 校验对象大小/SHA-256 并投递探测任务 |
| GET | `/media/:mediaId` | 状态、元数据与波形峰值 |
| GET | `/media/:mediaId/playback-url` | 获取短期私有播放地址 |
| POST | `/media/:mediaId/retry-probe` | 重试音频探测 |
| DELETE | `/media/:mediaId` | 删除对象和关联标记 |

创建上传会话：

```json
{
  "originalName": "practice.wav",
  "mimeType": "audio/wav",
  "sizeBytes": 2646000,
  "sha256": "64-hex-characters"
}
```

预签名请求的 `Content-Type` 和 `x-amz-meta-sha256` 已纳入签名，必须使用返回的 `requiredHeaders` 原样上传。

## 标记

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sessions/:sessionId/annotations` | 标记列表 |
| POST | `/sessions/:sessionId/annotations` | 新增标记 |
| PATCH | `/annotations/:id` | 编辑标记 |
| DELETE | `/annotations/:id` | 删除标记 |

区间使用毫秒整数，最小时长 100 ms，且不能超过音频时长。问题类型为 `RHYTHM`、`FINGERING` 或 `EMOTION`。

## 复盘与目标

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sessions/:sessionId/review` | 获取复盘 |
| PUT | `/sessions/:sessionId/review` | 保存复盘草稿 |
| POST | `/sessions/:sessionId/review/complete` | 完成复盘事务 |
| GET/POST | `/goals` | 目标列表/创建 |
| GET/PATCH | `/goals/:id` | 目标详情/更新 |
| POST | `/goals/:id/activate` | 重新激活取消或逾期目标 |
| POST | `/goals/:id/cancel` | 带原因取消 |
| POST | `/goals/:id/complete` | 用户确认完成 |
| GET/POST | `/goals/:id/progress` | 进度列表/新增 |

完成复盘请求会原子写入复盘、目标、进度并更新练习状态。任一步失败时全部回滚，返回 `REVIEW_INCOMPLETE` 且 `details` 为缺失项数组。

## 统计与导出

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/statistics/overview` | 总览指标 |
| GET | `/statistics/trends` | 按用户时区分日趋势 |
| GET | `/statistics/issues` | 问题类型、严重度和困难片段 |
| GET | `/statistics/goals` | 目标完成率和逾期 |
| GET | `/statistics/instruments` | 各乐器聚合 |
| GET | `/statistics/dashboard` | 首页聚合 |
| POST | `/exports` | 创建 JSON/CSV 用户数据导出 |
| GET | `/exports/:id` | 查询导出状态和短时下载地址 |

统计接口必须传 `from`、`to` 和 IANA `timezone`。

## 健康检查

| 路径 | 说明 |
|---|---|
| `/health/live` | 仅检查进程存活 |
| `/health/ready` | 检查 PostgreSQL、Redis 和对象存储 |
| `/metrics` | Prometheus 文本指标 |

## 合奏排练协调

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/ensembles` | 合奏团列表 / 创建（创建者自动成为 OWNER） |
| GET/PATCH | `/ensembles/:ensembleId` | 详情（含声部成员）/ 乐观锁更新 |
| GET/POST | `/ensembles/:ensembleId/members` | 声部成员列表（可按 `part` 过滤）/ 邮箱邀请 |
| PATCH/DELETE | `/ensembles/:ensembleId/members/:memberId` | 调整声部/角色 / 软移除 |
| GET/POST | `/ensembles/:ensembleId/rehearsals` | 排练列表（光标分页）/ 创建 |
| GET/PATCH | `/rehearsals/:rehearsalId` | 排练汇总 / 乐观锁更新 |
| POST | `/rehearsals/:rehearsalId/cancel` | 取消排练 |
| PUT | `/rehearsals/:rehearsalId/attendance` | 批量点名（乐观锁 + 幂等） |
| POST | `/rehearsals/:rehearsalId/bar-tasks` | 新建小节任务 |
| PATCH/DELETE | `/bar-tasks/:barTaskId` | 更新小节任务（含指派人）/ 删除 |
| POST | `/bar-tasks/:barTaskId/confirm` | 成员确认小节完成（可带 `Idempotency-Key`） |
| POST | `/rehearsals/:rehearsalId/sync` | 离线事件批量合并 |
| GET | `/notifications` | 当前用户通知收件箱（含 `unreadCount`） |
| POST | `/notifications/:id/read` | 标记已读 |

### 排练汇总口径

`GET /rehearsals/:id` 一次返回 `members`（声部与出勤）、`barTasks`（含每个任务的 `progress`）与
`rollup` 汇总。完成度分母**只包含被指派且实际出席（`PRESENT`/`LATE`）的成员**：

- `ABSENT`、`EXCUSED` 与未点名（`UNKNOWN`）的被指派人进入 `excludedAssignees`，绝不计入分母；
- 缺席成员的打卡既不会抬高也不会拉低完成度；
- 分母为 0（任务取消、无人出席或未指派）时 `completionRatio` 为 `null`，
  客户端必须展示“暂不可统计”，不能当作 0% 或 100%；
- 只要有一个小节任务不可统计，整场 `overallCompletionRatio` 即为 `null`。

### 通知变更幂等

变更先写 `rehearsal_change_events`，再按成员展开通知。事件指纹为
`SHA256(rehearsalId | kind | targetMemberId | 规范化 payload)`，`(rehearsal_id, fingerprint)`
唯一；写接口同时接受 `Idempotency-Key` 头并做全局唯一。同语义变更重放（含并发穿透唯一约束冲突）
只复用原事件，不产生重复通知。

### 离线确认合并

- 每条事件携带客户端生成的 `clientEventId`（≥8 字符）与事件发生时间 `occurredAt`；
- 同一 `clientEventId` 重放（包括它曾被更新事件 LWW 覆盖的情况）返回 `replayed`，不复活旧值；
- 不同设备对同一出勤/确认的并发写按 `occurredAt` last-writer-wins，时间戳相同时按
  `clientEventId` 字典序破平，保证多端收敛；冲突结果在响应 `conflicts` 中明示；
- `/sync` 整批校验、整批事务提交，不产生半写入。
