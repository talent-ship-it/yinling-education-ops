# 教务宝开放 API：安全配置与数据边界

本系统只通过固定的 HTTPS 网关读取已文档化的 `query_schedule_list`。
API 密钥只供服务端读取，变量名为 `JIAOWUBAO_OPEN_API_SK`。

## API 可读取和真实保存什么

- 课节、班级、课程、教室、老师/助教、日期时间、时长、直播、容量；
- 结课、签到、请假、到达、课时与考试统计；
- API 返回的学员明细、姓名、头像、签到/到达状态和备注。

定时导入会把每条课表业务记录的完整 JSON 保存在私有、不可变的来源快照中，包括顶层 `price_mem`、学员明细中的 `price`，以及供应商后来新增的业务字段。凭证、token、密码、Cookie 等字段会失败关闭，永不持久化。价格值只保存在私有数据库，不会发送到浏览器。

完成态快照随后会投影为学生、老师、课程、班级、教室和课表来源实体，并记录与现有系统资料的匹配、未匹配和冲突状态。教务宝是**多个权威来源之一**：稳定教务宝 ID 优先，完整姓名只在来源与系统两侧都唯一时作为后备；任何歧义都保留为来源实体，不覆盖腾讯总表、教师表、人工资料或原生 Booking。即使教务宝快照没有变化，只要系统学生、老师、课程或 Booking 的版本发生变化，下一次 30 分钟任务也会重新生成匹配投影。当前正式 Open API 合同仍只提供 `query_schedule_list`，因此完整学员目录、合约、课时余额和其他数据域要等供应商提供相应 Open API 工具后接入，不能用网页登录会话冒充无人值守同步。

## 生产环境：只在 Vercel 保存密钥

在项目根目录运行以下命令。先确认是 Insider Leads 账号；预期输出为 `talent-2867`。

```bash
npx vercel --global-config '/Users/nixon/.vercel-profiles/insider-leads' whoami
npx vercel --global-config '/Users/nixon/.vercel-profiles/insider-leads' env add JIAOWUBAO_OPEN_API_SK production --sensitive
```

第二条命令会交互式要求粘贴密钥。只粘贴在该提示中：

- 不要把密钥写进 `.env`、`.env.production`、代码、Supabase、SQL、浏览器控制台或聊天记录；
- 不要使用 `NEXT_PUBLIC_` 前缀；
- 不要把密钥放进 URL、curl 参数或 GitHub Actions 日志；
- 只为 `production` 保存。需要预览环境时，使用单独、可撤销的测试密钥。

Vercel 环境变量在新的部署中生效；添加后再部署应用。密钥轮换时，用同一变量名替换值并重新部署，不需要修改代码。

## 本地一次性测试

不要把密钥写到磁盘。启动本地服务前，在当前 shell 临时注入即可：

```bash
read -s 'JIAOWUBAO_OPEN_API_SK?Jiaowubao API key: '
echo
export JIAOWUBAO_OPEN_API_SK
npm run dev
# 测试结束后，在另一个终端或停止服务后：
unset JIAOWUBAO_OPEN_API_SK
```

## 已接入的读接口

`GET /api/jiaowubao-open-api/schedule-preview?start=YYYY-MM-DD&end=YYYY-MM-DD&page=1&limit=100`

该接口只允许已登录管理员，最长读取 31 天、每页最多 100 条，并使用 `private, no-store`。它返回的是最小化课表 DTO；学生姓名、头像、价格、备注、原始 `stu_list` 和 API 错误消息都不会返回。上游每组织限流为 20 次/分钟；单个应用实例会串行并合并相同请求，跨实例仍以教务宝的 429 为最终限流边界，并会安全返回 429。

## 自动同步（生产）

当前 Vercel 项目是 Hobby，不能运行每 30 分钟的 Vercel Cron。因此生产部署用 Supabase `pg_cron` 每 30 分钟经 `pg_net` 调用受独立 bearer token 保护的 `GET /api/cron/jiaowubao-schedule`。token 只以加密形式保存于 Supabase Vault 和 Vercel 的敏感环境变量 `JIAOWUBAO_SCHEDULE_SYNC_TOKEN`，不进入代码、迁移、Cron 命令、浏览器或日志。每次读取墨尔本当天起 31 天的课表，将所有页面分别写入不可变 staging；只有所有页均通过校验后才短事务发布新的完成态来源指针。发布后，同一事务合同会生成规范化权威实体、匹配率、异常和字段覆盖汇总，并刷新同步页的来源健康状态。无变化的 30 分钟检查也会更新最近成功检查时间。若 API、网络、任一页或投影失败，上一份完整快照保持可读；重复或重叠的 Cron 调用由数据库租约和来源指针 CAS 拦截。

这一同步只处理 `query_schedule_list` 当前可以给出的课表数据。完整来源数据和规范化实体会长期入库，但不会静默创建或覆盖原生学生、老师、课程、Booking、课包或任务；任何原生业务写入仍需独立、可审计的业务合同。

## 一次性课表快照：导出后再分块写入

在数据库迁移
`20260821220000_jiaowubao_open_api_schedule_snapshot_ingest.sql`、
`20260821220001_jiaowubao_open_api_schedule_management_bridge.sql` 与
`20260821220002_fix_jiaowubao_open_api_schedule_management_begin_precedence.sql`
以及 `20260831000500_jiaowubao_authoritative_source_projection.sql`
均已按受控发布流程应用后，才可以运行这个一次性流程。它写入私有来源快照；计划任务会再生成规范化来源实体和安全匹配，但不会创建或覆盖原生学生、Booking、课包、任务、薪资、出勤或 AVA。

先把 API 密钥只留在当前 shell，导出一个最多 31 天的 owner-only 本地目录：

```bash
read -s 'JIAOWUBAO_OPEN_API_SK?Jiaowubao API key: '
echo
export JIAOWUBAO_OPEN_API_SK

node --import tsx scripts/jiaowubao-open-api-schedule-export.ts \
  --start 2026-08-22 --end 2026-09-21 \
  --out /private/tmp/jwb-schedule-2026-08-22

unset JIAOWUBAO_OPEN_API_SK
```

之后，使用已登录的 Insider Leads Supabase CLI 分批写入。这个管理桥接只接受 Supabase Management API 的 `postgres` 会话；不需要、也不允许输入数据库 URL 或运营写入密钥。先确保 CLI 配置文件只有当前 macOS 用户可读：

```bash
chmod 600 /private/tmp/insider-leads-supabase-profile.yaml

node --import tsx scripts/jiaowubao-open-api-schedule-management-staging.ts \
  --input /private/tmp/jwb-schedule-2026-08-22 \
  --profile /private/tmp/insider-leads-supabase-profile.yaml \
  --actor Nixon
```

导入器会逐页执行独立的 `BEGIN → stage → COMMIT`，每页可安全 replay；完成态只在一个短事务中替换来源指针。它不会采用本地 JavaScript 哈希冒充 PostgreSQL 的 JSONB 哈希，最终回执中的 `rowsSha256` 和 `payloadSha256` 均由数据库计算。

默认情况下，只要线上已有不同 revision 的当前快照，导入器就会停止，防止旧导出覆盖新数据。只有在人工核对后，才可额外传入 `--replace-current`；它仍会锁定并比较当前 revision，若期间已有其他发布则失败而不是覆盖。

如果某次 stage 或 complete 的网络结果不确定，命令会先读取该 run 的聚合状态并以非零退出，不会盲目重试。重新运行同一份完整 manifest 会让数据库逐页验证 replay。若受控执行环境有短时长限制，可用 `--page-start N --page-count N` 继续明确的一段页范围；完成函数仍会拒绝有缺页的 run。显式放弃一个未完成 run 时，可以使用同一个输入目录加 `--abort`，或从之前的聚合回执取得 run UUID 后单独执行：

```bash
node --import tsx scripts/jiaowubao-open-api-schedule-management-staging.ts \
  --abort --abort-run-id RUN_UUID \
  --profile /private/tmp/insider-leads-supabase-profile.yaml --actor Nixon
```

已完成 run 永远不能 abort。

## Owner-only：精确八条身份合并批次

`20260821220004_student_import_identity_management_bridge.sql` 是独立的
Supabase Management API `postgres` 会话桥接。它只处理当前来源重新计算后仍然
满足“精确、唯一、已有学生、无未解决重复组”的八条 JWB 身份合并；不会读取或
复制 `OPS_API_SECRET`，也不会改变浏览器使用的公开 RPC。数据库仍会重新锁定
来源、学生版本、身份链接、复核 epoch，并写入原有不可变 command ledger 与审计。

默认命令只做服务端预检，输出确认 key、来源 revision 和聚合计数，不输出姓名、
学生 ID 或原始来源行：

```bash
node --import tsx scripts/student-import-identity-management.ts \
  --profile /private/tmp/insider-leads-supabase-profile.yaml \
  --actor 'Nixon'
```

确认回执中的 `canSubmit=true` 且计数为八条后，才使用同一命令的 `--commit`。该
命令会先重新执行一次预检，再把本次服务器返回的 opaque key 原样提交；它不接受
客户端身份列表、姓名、学生 ID 或决定内容：

```bash
node --import tsx scripts/student-import-identity-management.ts \
  --profile /private/tmp/insider-leads-supabase-profile.yaml \
  --actor 'Nixon' --commit
```

桥接函数在 `internal` schema、`SECURITY INVOKER` 下运行，并同时要求
`session_user` 与 `current_user` 为 `postgres`；没有 `public`、`anon`、
`authenticated` 或 `service_role` 执行授权。脚本只调用 `supabase db query`，
不使用数据库 URL。网络结果不确定时脚本不会盲目重试，需以数据库中的聚合状态和
immutable ledger 为准。
