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

## 合奏排练协调

成员声部、到齐状态与小节任务在同一汇总口径下维护。所有接口挂在 `/api/v1` 下，需要登录并属于对应合奏（组织者/指挥可写，普通成员只能管理本人到勤与自己被指派的任务）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/ensembles` | 合奏列表 / 创建合奏（创建者自动成为 OWNER 成员） |
| GET/PATCH | `/ensembles/:id` | 合奏详情（含成员与最近排练）/ 乐观锁更新 |
| GET/POST | `/ensembles/:id/members` | 成员声部列表 / 添加成员（可关联已注册用户） |
| PATCH/DELETE | `/ensembles/:id/members/:memberId` | 编辑声部角色 / 软移除（保留历史数据） |
| GET/POST | `/ensembles/:id/rehearsals` | 排练列表 / 安排排练并为全员初始化 PENDING 到勤 |
| GET/PATCH | `/rehearsals/:id` | 排练详情 / 乐观锁更新（自动发去重变更通知） |
| POST | `/rehearsals/:id/transition` | 排练状态机：SCHEDULED→IN_PROGRESS→COMPLETED/CANCELLED |
| GET | `/rehearsals/:id/summary` | **汇总：声部到齐 + 到勤计数 + 小节任务完成度** |
| GET | `/rehearsals/:id/attendance` | 到勤列表 |
| PUT | `/rehearsals/:id/attendance/me` | 成员在线回复 CONFIRMED/DECLINED |
| POST | `/rehearsals/:id/attendance/me/sync` | **离线确认合并**（幂等键 + `clientUpdatedAt` LWW） |
| POST | `/rehearsals/:id/attendance/:memberId/roll-call` | 组织者点名 PRESENT/LATE/ABSENT（幂等键） |
| GET/POST | `/rehearsals/:id/bar-tasks` | 小节任务列表 / 创建并指派 |
| PATCH | `/bar-tasks/:id` | 编辑任务（乐观锁） |
| POST | `/bar-tasks/:id/status` | 任务状态推进（幂等键 + 乐观锁） |
| GET | `/notifications` | 当前用户的变更通知收件箱（`unreadOnly`/光标分页） |
| POST | `/notifications/read` | `{ "ids": [...] }` 或 `{ "all": true }`，幂等 |

### 通知幂等

- 每条通知有 `dedupe_key = rehearsalId:type:entityId:contentHash`，对 `rehearsal_notifications.dedupe_key` 建唯一约束；内容指纹不变的重复提交（重试、双击、离线回放）直接命中，绝不重复通知。
- 请求级变更（点名、离线同步、任务状态）另需客户端提供 `idempotencyKey`（8–80 字符），服务端在 `idempotency_records` 记录首次结果；同键不同请求体返回 `409 IDEMPOTENCY_KEY_REUSE`，重放返回原结果并带 `x-idempotent-replay: true`。
- 通知按每场排练单调递增 `changeSeq`，客户端可据此判断是否有遗漏变更。

### 离线确认合并

离线设备把回复（含 `clientUpdatedAt`）排队，恢复网络后按时间顺序 POST 到 `/attendance/me/sync`：

1. 相同状态重复回放为 no-op；
2. 按 `clientUpdatedAt` 做 last-write-wins——较早的离线确认不会覆盖更晚的在线点名；
3. 已点名（PRESENT/LATE/ABSENT）后，成员回复（CONFIRMED/DECLINED/PENDING）无法把状态改回去；点名状态之间允许组织者用更新时间纠偏；
4. 同步接口必须携带 `idempotencyKey`，断网重试安全。

### 完成度口径（缺席不能误算）

`/rehearsals/:id/summary` 的完成度只统计当场可核实的任务：

- 明确缺席（`ABSENT`/`DECLINED`）成员名下任务整体排除在分子与分母之外——缺席既不算「未完成」，其自报 DONE 也不会抬高完成度；
- `SKIPPED` 任务不计入分母；
- 同时返回按小节数加权的 `barWeightedCompletionRate` 与成员级 `suspectDoneWhileAbsent`（缺席却有 DONE 任务，需排练后核实）；
- 没有可核实任务时完成度为 `0`（而非误导性的 100%）。

## 健康检查

| 路径 | 说明 |
|---|---|
| `/health/live` | 仅检查进程存活 |
| `/health/ready` | 检查 PostgreSQL、Redis 和对象存储 |
| `/metrics` | Prometheus 文本指标 |
