# 教务宝月度薪资来源读取核对

取证日期：2026-11-25；各回执保留独立 observed_at。
范围：系统保存的教务宝已消课学生明细、排课老师角色课时、月度完整性、自动同步推进。
方式：公司批准 helper 包装官方 Supabase CLI；project/orvsgisjjrzgtxuwwsms 与 organization/fgnmdykxtthalhwspelu 已匹配；所有业务 SQL 使用 BEGIN TRANSACTION READ ONLY / ROLLBACK，已读回 transaction_read_only=on。
本次直接教务宝 API 调用数：0；后台既有同步任务的调用及响应从生产只读记录中核对。

## 结论

来源更新有积压。已有完整旧月快照与实际存储条数相符，但不能将其等同于供应商当前最新数据。11月资料仍只覆盖至11月5日。
按系统业务时区，当前采集目标可截至 2026-11-24。10月补读正在推进，现行队列优先完成 collecting/ready 月份。
此外，9月和10月共有5个排课日历项目带 out_of_range 课时标记；不能据此猜测正确课时或自动调整工资。

## 已发布来源

| 月份 | 学生明细 | 排课角色记录 | 覆盖至 | 发布时间（UTC） | 异常学生课时/老师角色课时 |
|---|---:|---:|---|---|---|
| 2026-08 | 2014 | 2014 | 2026-08-31 | 2026-11-02T03:48:38.2354+00:00 | 0 / 0 |
| 2026-09 | 2045 | 2045 | 2026-09-30 | 2026-11-02T07:13:34.934253+00:00 | 2 / 2 |
| 2026-10 | 2316 | 2316 | 2026-10-31 | 2026-11-04T13:54:02.743022+00:00 | 3 / 3 |
| 2026-11 | 201 | 201 | 2026-11-05 | 2026-11-05T16:12:21.340236+00:00 | 0 / 0 |

共核对 4 个已存月份、6576 条学生明细和 6576 条排课记录。未发现已存记录混入未完成课或其他月份。

## 同步推进证据

初次观测（2026-11-25 09:33 UTC）：10月完成644/1219个成员目标。
后续观测（2026-11-25 09:41 UTC）：10月完成693/1219个成员目标，最近页面捕获09:39 UTC。
pg_net 中09:37 UTC发起的任务返回202/in_progress，sourcePageCount=50；09:22一轮返回202但sourcePageCount=0。SQL层 cron succeeded 不能单独证明来源已更新。
线上 pending-month 函数支持当月，但优先采集中的旧月份。没有证据支持“当月被月份格式校验拒绝”的结论。

## 本地验证

5个现有测试文件，共 54 项通过、0失败。没有新增测试代码，没有重复运行已通过的测试集合。
第一组命令：`node --import tsx --test --test-reporter=tap tests/jiaowubao-completed-lessons-client.test.ts tests/jiaowubao-completed-lesson-cron-request.test.ts tests/monthly-hour-period.test.ts tests/jiaowubao-completed-lesson-payroll-evidence.test.ts`，27/27通过。
第二组命令：`node --import tsx --test --test-reporter=tap tests/jiaowubao-monthly-hour-discrepancies.test.ts`，27/27通过。

## 限制与保留的失败

没有直接对教务宝当前接口全量逐笔对账，没有验证每个本系统老师身份映射或工资金额。
之前的公司 Ego Space5 当前不在可用 TaskSpace 中；没有访问其他空间或创建替代登录。未完成薪资页面的真实登录验收。
完整来源逐条 calendar 对应核对查询曾因错误列名42703失败，修正为 snapshot_items.item / snapshot_schedule_events.event 后，该带关联子查询的检查触发10秒57014超时。没有提高超时或声称该检查通过；改用分组的结构/数量/月份/课时标记核对后成功。故不声明所有学生明细与排课已逐条匹配。
原失败SQL保留在私有scratch，audit-query-attempts.json保留失败记录。

## 复用 / 新增 / 后续

复用：现有双来源月度快照、自动任务、异常课时规则、已安装官方CLI与项目凭据helper。
新增：本只读核对报告和私有聚合回执。没有新增读取服务；未修改应用代码、同步配置、工资、费率、付款或供应商记录。
后续范围：先完成来源同步积压，复验11月覆盖日期，并回查5个异常课时项目；如需调整生产任务或重建快照，先确认该生产写入范围。

聚合回执目录：`/Users/nixon/.hermes/profiles/insiderleads/cache/scratch/jiaowubao-payroll-read-audit-20261125`。
