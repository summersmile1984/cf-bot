---
feature: schedule-reliability
status: delivered
updated: 2026-11-15
source: main
---

# 例程可靠性：失败重试与错过补跑

## Report

**What was built** — 例程失败重试（`retry_at` 退避 1/5 分钟，第 3 次判死）+ 同窗口 run 记录 upsert（`window_at` + `attempt` 累进，created_at 保首跑）+ 错过标记 catch_up（窗口过期 >10 分钟即标；多窗口只补最近一期由既有 claim/advance 语义天然保证）+ 控制台运行记录徽标（第 N 次 / 补跑）。计量幂等键改按窗口（`turn:sched:<id>:<windowAt>`）重试不双扣。

**Verification** — `spike-schedules` 6/6（同窗口 upsert/attempt 累进/retry 出队与清理/listRuns 新字段）。

## [S1] Problem

现状：tick 触发一次 `orchestrator.generate`，失败只记 `schedule_runs.status=failed`——没有重试；Worker 冷启动/上游抖动/额度瞬时不足都会让例程静默漏跑（`next_run_at` 已推进，窗口一去不返）。定时任务是产品对用户的「承诺」，漏了就是失信。

## [S2] Design

### S2.1 失败重试

- `schedule_runs` 加 `attempt INTEGER DEFAULT 1`；失败后不吞：把 `next_run_at` 拉回 `now + backoff`（1 分钟 / 5 分钟），attempt+1；**attempt ≥ 3 判死**（记 failed 终态，等下个正常周期）。
- 重试复用同一 run 记录（同 `schedule_id + 窗口`），面板显示 attempt 数。

### S2.2 错过补跑（catch-up）

- tick 增加扫描：`enabled=1 AND next_run_at < now - 超时阈值（默认 10 分钟）` 且未在重试中——说明窗口被错过（部署中断/冷启动堆积）。
- 补跑策略：**每窗口只补一次**（幂等键 `sched:<id>:<窗口>`），补跑标记 `catch_up=1`，跑完推进到下一未来窗口；连续错过多个窗口只补最近一期（不追跑历史风暴）。

### S2.3 记录与展示

- `schedule_runs` 加 `catch_up INTEGER DEFAULT 0`；控制台例程面板运行记录列显示「第 N 次尝试 / 补跑」徽标；失败终态带原因摘要（已有 detail）。

## [S3] Out of Scope

- 多副本调度锁（单 Worker + tick 原子 claim 已串行）；精确到秒的准时性（分钟级 tick）；暂停中的例程补偿。

## Tasks

- [x] T1: 失败重试 — acceptance: 人为制造失败后 1/5 分钟自动重试，第 3 次判死；幂等不双跑 (covers: S2.1) — ✅ spike 验证 + tick 双通道（normal/retry）
- [x] T2: 错过补跑 — acceptance: 回拨 next_run_at 模拟错过，tick 补跑一次并标记 catch_up；多窗口只补最近一期 (covers: S2.2) — ✅ catch_up 标记；单补语义由 claim/advance 天然保证
- [x] T3: 记录面徽标 — acceptance: 运行记录显示 attempt/catch_up (covers: S2.3) — ✅ L2 控制台运行记录

## Journey log

- 2026-11-15：重试与补跑都走「同一 run 记录 + 幂等键」——审计上一期任务到底跑了几次、是否补跑，比静默重排 next_run_at 诚实。
- 2026-11-15：实现走 `schedules.retry_at` 独立列而非覆盖 `next_run_at`——保住已算好的下期 cron 点，重试窗口与正常窗口互不干扰；run 记录按 `window_at` upsert（id=run-<sid 尾>-<windowAt>）。catch_up 判定「窗口过期 >10 分钟」，多窗口只补最近一期是既有 claim+advance 语义的天然性质（记为设计确认而非新代码）。
