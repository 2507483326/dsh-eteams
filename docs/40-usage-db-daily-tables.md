# 40 Token 消耗入库：SQLite 双表

> 状态：**已实施**（2026-09-05，按用户简化决策）。存储改为「DB 即唯一存储」：无文件台账、无对账、不强一致。采集、归属、日界、口径语义与 28 号设计完全不变。

## 1. 决策与范围

28 号功能原本用 JSONL 台账（`usage.jsonl` + `usage-archive.jsonl` + `usage-checkpoint.json` 水位）做记账真相：读请求全量扫描 + `(session_id, seq)` 去重 + 重启补折。本次用户拍板简化：**这是个小功能，不需要保证完全一致性——完全不使用文件存储，也不做对账**。因此：

- 采集面不变：root-scope `session/event` firehose 旁路监听（`assistant/message` 带 usage 记行；`request/header` / `request/context` 折叠模型路线）。
- 归属不变：member → captain-child → captain（领队行 mainSessionId）→ conversation（面板绑定）→ workspace 五级优先，10 秒 TTL 身份缓存。
- 计量语义不变：`day` = 记录时按宿主本地时区折算的 `yyyy-MM-dd` 快照；`total_tokens` = input + output + cache_read + cache_write（reasoning 不计入，只单独存列）。
- 存储整体替换：整个文件台账机制（追加、轮转、归档、水位、启动对账、读路径文件回退）全部删除，SQLite 两表是唯一存储。

## 2. 表设计（schema 编号 11 / 12）

DDL 以 `src/host/state/schema.sql` 第 11/12 节为准（与 `db.ts` 内嵌 `SCHEMA_SQL` 逐字一致；`getDb` 每次连接都跑全量 `CREATE TABLE IF NOT EXISTS`，存量库自动获得新表，`db_schema_version` 不 bump）。沿用库既定约定：无外键/CHECK/UNIQUE/触发器，时间列 `*_time` Unix 毫秒，表尾 `created_time`/`update_time`。

**`usage_detail`（明细，一行 = 一次带 usage 的模型回复步）**

| 列 | 说明 |
| --- | --- |
| `usage_detail_id` | 自增主键 |
| `day` | 消耗日 `yyyy-MM-dd`（记录时快照，之后不再重算） |
| `event_time` | 事件发生时刻（Unix 毫秒） |
| `session_id` / `seq` | 会话 ID + 会话内事件序号（索引用，**不再承担幂等去重**，见 §4） |
| `team_key` | 归属团队的台账文本 ID；NULL=工作区桶；松引用不校验存在 |
| `member_name` | 归属成员名；非成员为 NULL |
| `role_kind` | captain / captain-child / member / conversation / workspace |
| `provider` / `model` | 模型路线快照（路线缓存折叠自 request/header·context） |
| `input_tokens` / `output_tokens` | 计费输入（不含缓存读）/ 输出；非有限值钳为 0 |
| `cache_read_tokens` / `cache_write_tokens` / `reasoning_tokens` | 可空：适配器未上报（≤0 或缺失）为 NULL |
| `total_tokens` | input + output + cache_read + cache_write（reasoning 排除） |

索引：`(session_id, seq)`、`day`、部分索引 `(team_key, day) WHERE team_key IS NOT NULL`。

**`usage_daily_total`（总和，一行 = 一天，全应用口径）**

`day` TEXT PRIMARY KEY（仿 schema_meta 的键即主键例外）；7 个数值列（input/output/cache_read/cache_write/reasoning/total_tokens + `calls` 明细行数）全部 `NOT NULL DEFAULT 0`。写入按事件增量 upsert 累加，不做与明细表的定期核对。

## 3. 写路径（src/host/state/usageStore.ts + src/host/runtime/usage.ts）

`recordUsage(db, row)` 一次调用完成两表写入，单事务：

```
BEGIN IMMEDIATE
  INSERT INTO usage_detail (...17 列..., total_tokens, created_time, update_time)
  INSERT INTO usage_daily_total (...VALUES(..., 1, now, now)...)
    ON CONFLICT(day) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      ... (每列同式) ..., total_tokens = total_tokens + excluded.total_tokens,
      calls = calls + 1, update_time = excluded.update_time
COMMIT   -- 异常时 ROLLBACK 并抛出
```

要点：

- **串行队列**：firehose 回调同步段只做 Map 读写与入队，`recordUsage` 在模块级 Promise 串行队列里执行——同进程内按事件到达顺序入库，且绝不阻塞会话事件循环的同步段。
- **两表不会漂移**：明细 INSERT 与日总和增量在同一事务里同生共死；不对账的实质代价只有「事件丢失」，不是「两表不一致」。
- **失败降级**：DB 写失败吞错 + 1 分钟节流 warn（「降级继续」），计量绝不影响会话；监听器同步段异常同样吞掉。
- **无去重**：cordis 对每个已提交事件、每个监听者恰好投递一次，正常不会重复；不为「假设性的重复投递」增加 `(session_id, seq)` 查重复杂度——万一真出现重复投递，代价只是计数略多，接受（最终一致口径）。

## 4. 明确放弃项（用户拍板的边界）

| 放弃项 | 后果 |
| --- | --- |
| 不对账、无水位、无轮转归档 | 没有补折机制；状态根下不再产生任何 usage 文件 |
| 历史不回补 | 代码没有任何启动导入/对账逻辑。存量 JSONL 台账已于 2026-09-05 人工一次性导入生产库一次（schema_meta 里残留的 `usage_file_import_v1` 标记代码已不再读取；旧 JSONL 文件留在盘上不再读写） |
| 存量文件作废 | 已有的 `usage.jsonl`/`usage-archive.jsonl`/`usage-checkpoint.json` 保留在盘但不再读写、不迁移 |
| 冷恢复会话不补 | 冷恢复（cold resume）重放的重启前事件同样不补行 |
| 不做幂等去重 | 依赖 cordis 单次投递语义；重复投递只会多计，不防 |

## 5. 读路径（响应形状不变，客户端零改动）

- **团队口径** `readUsageCalendar(stateRoot, teamId, year)`：`usage_detail WHERE team_key = ? GROUP BY day`——精确口径，与明细天然一致。
- **全应用口径** `readAppUsageCalendar(roots, year)`：每个工作区 `usage_daily_total` 直读（行即全应用日总和），多根 `mergeUsageCalendars` 逐格相加。
- 两者都返回**零填充全年日格** `{days, totals}`（`totals.firstDay`/`lastDay` = 有数据的首末日），`webui.ts` 两条路由的响应体、客户端组件零改动。

## 6. 测试

- `tests/usage.test.ts`（14 项）：归属五级、路线折叠 + 跳过无 usage 消息、非有限值钳制与 NULL 语义、同日增量 upsert、**不落地任何 usage 文件**回归、团队口径跨月聚合/跨年跨队过滤、全应用口径计数、多根合并、未来年零格、监听器异常不外抛。
- `tests/webui.test.ts`（2 项）：团队/应用两条日历路由 200/400/404 组合（fixture 由写 JSONL 文件改为 `recordUsage` 直插 DB）。

## 7. 装机冒烟（真实宿主）

1. 建队、拉人、派发几轮后查 `<stateRoot>/db/eteams.db`：`usage_detail` 有行且 `role_kind`/`team_key` 归属正确；`usage_daily_total` 当日 `calls` 随调用增长。
2. 看板「Token 消耗」卡当天出现数值（团队页与全应用口径）。
3. 确认状态根目录下不再新增 `usage.jsonl`。
