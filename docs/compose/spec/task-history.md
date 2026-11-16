---
feature: task-history
status: delivered
updated: 2026-11-15
source: main
---

# 任务历史与审计视图：我的任务都去哪了

## Report

**What was built** — 跨房间任务时间线：`/tasks` 聚合 API（l2_tasks × rooms × devices × decisions × usage_ledger 一次取齐免 N+1）+ `GET /tasks/:id` 详情（prompt/进度/产物/审批/额度流水）+ web「任务」视图（筛选 chips + 抽屉详情 + 房间深链）。Sidebar「任务」入口。

**Verification** — 生产烟测：种入任务+流水后 `/tasks` 联查出耗点 25/进度解析正确；owner_id 置顶过滤沿用多租户硬约束。web tsc 绿。

## [S1] Problem

「派了什么任务、在哪台机器跑的、花了多少额度、产物在哪、卡在哪个审批」今天要翻五个地方（房间流、job_status 工具、设备页、待办、额度条）。用户对长任务产品的信任来自**可追溯**；也是订阅计费争议（这单扣了多少点）的裁决依据。`job_status` 是工具不是视图，且只看单房间。

## [S2] Design

### S2.1 聚合 API

- `GET /tasks?status=&device=&room=&limit=`（会话鉴权，`owner_id = u.id` 置顶过滤——多租户硬约束同款）。
- 行模型：`{ taskId, prompt 摘要(80字), kind, status, roomId, roomName, deviceId, deviceName, createdAt, updatedAt, quotaPoints, artifacts: n, decision: pending|answered|…, link }`。
- 联查：`l2_tasks` LEFT JOIN `devices`（device_id）、`decisions`（ref_id）、`usage_ledger`（idempotency_key = `task:<id>` 取耗点）；房间名走 rooms。分页 50/页。

### S2.2 web「任务」视图

- Sidebar 底部「任务」入口；列表按时间倒序；筛选 chips：状态（排队/进行/完成/失败）+ 设备 + 房间。
- 行点开 → 抽屉：完整 prompt、进度条目（复用 progress JSON）、产物缩略（复用 /artifacts）、审批记录、耗点与退补流水、深链回房间。

### S2.3 边界

- 只读视图，不改任务状态（取消/重发走既有工具面）。
- 额度流水以 `usage_ledger` 为准（含退补），行内显示净耗。

## [S3] Out of Scope

- CSV/审计报表导出（P2）；管理员跨用户审计（团队版再议）；实时推送（轮询 30s 即可）。

## Tasks

- [x] T1: `/tasks` 聚合 API — acceptance: 按用户隔离；状态/设备/房间筛选正确；耗点/产物/审批字段联查无 N+1 毛刺 (covers: S2.1) — ✅ 流水二次查询按页取齐
- [x] T2: 任务视图 + 抽屉详情 — acceptance: 列表/筛选/深链可用；抽屉展示 prompt/进度/产物/耗点 (covers: S2.2) — ✅ 生产烟测驱动

## Journey log

- 2026-11-15：定位为「只读审计面」——状态操作留在既有工具/待办面，避免两套写入口。
- 2026-11-15：耗点取 `usage_ledger` 净额（扣-退），退补透明可见；`idempotency_key = task:<id>` 本就是派发侧约定，联查零迁移。
