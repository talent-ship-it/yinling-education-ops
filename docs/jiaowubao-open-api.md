# 教务宝开放 API：安全配置与数据边界

本系统只通过固定的 HTTPS 网关读取已文档化的 `query_schedule_list` 与 `query_lesson_list`。
API 密钥只供服务端读取，变量名为 `JIAOWUBAO_OPEN_API_SK`。

## API 可读取和真实保存什么

- 课节、班级、课程、教室、老师/助教、日期时间、时长、直播、容量；
- 结课、签到、请假、到达、课时与考试统计；
- API 返回的学员明细、姓名、头像、签到/到达状态和备注。

定时导入会把每条课表业务记录的完整 JSON 保存在私有、不可变的来源快照中，包括顶层 `price_mem`、学员明细中的 `price`，以及供应商后来新增的业务字段。凭证、token、密码、Cookie 等字段会失败关闭，永不持久化。价格值只保存在私有数据库，不会发送到浏览器。

完成态快照随后会投影为学生、老师、课程、班级、教室和课表来源实体，并记录与现有系统资料的匹配、未匹配和冲突状态。教务宝是**多个权威来源之一**：稳定教务宝 ID 优先，完整姓名只在来源与系统两侧都唯一时作为后备；任何歧义都保留为来源实体，不覆盖腾讯总表、教师表、人工资料或原生 Booking。即使教务宝快照没有变化，只要系统学生、老师、课程或 Booking 的版本发生变化，下一次 30 分钟任务也会重新生成匹配投影。现有合同仍未提供完整学员目录、合约、课时余额和其他数据域；这些必须等待供应商提供相应 Open API，不能用网页登录会话冒充无人值守同步。

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

Vercel 环境变量在新的部署中生效；添加后仍由 GitHub 合并到生产分支触发部署，不能从本地直接执行 Vercel 代码发布。密钥轮换时，用同一变量名替换值，再由 GitHub 流程触发一个新部署，不需要修改代码。

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

## 已消课月度薪资证据：双源 `over=1` 快照

每月薪资核对固定读取同一完整自然月的两份教务宝资料；两者职责不可互换，浏览器和调用者都不能改变查询范围或完成态筛选。

- `query_lesson_list(start, end, sign=-1, over=1, mem_id)` 是**学生/签到/试听明细**来源。线上网关要求额外限定学员、课程或班级；系统固定按学员 `mem_id` 查询，绝不再发送会被拒绝的整月无筛选请求。它的 `hours` 是学员消课课时，只能出现在学生核对行，绝不用于老师计薪。
- `query_schedule_list(start, end, order=asc, over=1)` 是**老师角色课时**来源。只有其中的 `teacher_hour`、`teacher_s_hour`、`teacher_t_hour` 分别对应主讲、助教和第三老师的老师课时。
- 两份来源只按 `cal_id` 尝试关联；学生来源含 `branch_id` 而排课来源不含。若同一 `cal_id` 跨 branch、老师角色/名称/日期/课程不一致、缺一份来源，或试听与常规学生混在同一课节，系统保留为“待核对”，不会猜测老师总课时。
- 少量历史 `query_lesson_list` 记录可能完全不返回 `branch_id`，或用空值/全零表示未知分校。系统会用保留标记保存该学生消课行并在 Excel 显示“未知（历史来源未提供）”；该标记绝不参与双源课节关联或老师计薪。若未知分校行形成重复来源键，整次发布失败关闭，不能静默合并跨分校记录。`cal_id` 与 `mem_id` 仍必须是有效非零来源 ID。
- 少量历史一对一记录会把原始 `team_title` 返回为 numeric `0`、缺失值或空白。系统只在供应商原始边界把这些哨兵规范成 `null`；正常字符串先做 NFKC，把历史 `U+0009–U+000D` 换行空白转换为可见空格，再 trim 并折叠连续 ASCII 空格；其他类型、过长值及其余控制字符均失败关闭，日志只记录固定结构类别。已落库的快照 DTO 仍严格要求 `string | null`，同时兼容旧快照中通用文本字段曾保留的连续可见空格。
- 学员 ID 清单在每次月度采集开始时冻结，为当前教务宝导入名册、主表已确认 ID、身份链接、系统保留的当前/历史 ID 与该月已结课排课 `stu_list[].mem_id` 的去重并集；因此试听共享账号、已停课或没有出现在当前排课页的历史学员不会只因单一来源缺失而被跳过。清单只保存在私有数据库，不返回浏览器。
- `query_lesson_list` 每次固定 `limit=100`，并以该学员响应中的 `data.total` 计算精确页数；第一页锁定 total，后续任一页 total 改变、行数不符、混入其他学员或出现重复来源键都会失败关闭。每个学员、每页与游标版本均单独落库，可在下一次任务安全续跑，不用靠“短页”或额外空页猜测结束。
- 完整月来源最多 31 天、每个查询最多 60 页、合计最多 6,000 条，单页最多 100 条。重复来源键、跨月记录、非完成态、超大/未知字段或不完整分页都会失败关闭。
- 数据库只保存白名单裁剪后的证据：课节/成员/课程/老师来源 ID 与显示名、日期时间、学员消课课时、签到、试听标记、老师角色课时与来源键。价格、联系方式、头像、备注、原始响应、Cookie、token 和密钥不会保存或发送到浏览器。
- 应用在 stage 前重新验证每份已捕获来源页及组合清单的散列；数据库再对实际 staged 的行和页计算独立散列。来源清单哈希是捕获出处，不把它描述为第三方签名或绕过数据库校验的凭据。
- 只有冻结清单中的每个学员都达到 `collected_count = total`，且结束时重新读取的已结课排课 revision、参与者 ID 集合与开始时完全相同，两份来源才会原子发布同一个月度 revision。同步失败、分页不完整或当前指针冲突时，已发布快照不被覆盖；失败 staging run 会记录原因、已暂存数量和指针版本后审计退役。若上游数据真实回退到一个历史上已完整验证的 revision，数据库只在当前指针 CAS 仍匹配时重新发布该不可变历史快照，不会重写历史行。
- 浏览器每个来源每页最多读取 250 条。所有续页必须同时带回来源 revision 和学生/老师映射 revision；任一来源或映射在读取中变化时接口返回无明细的重置状态，前端从第一页重读。`publishedAt` 只作显示，不能充当快照身份。
- 学生和老师均先按稳定教务宝 ID 匹配，再按双方唯一的完整姓名匹配。`试听学员/试听学生/视听学员 A、B、C 账号` 是共享账号，绝不拿账号 ID 建立学生身份；仅在课程标题唯一包含一个已知学生姓名时才关联。

薪资自动生成的前提是：老师可唯一匹配、该老师的每个课节已被双源关联、角色课时与试听分类都完整。否则导出仍保留来源核对行（学生明细、已知来源课时、原因），但不会形成付款指令，也不能锁定。即使已有旧薪资记录，只要当前月份双源资料正在读取、同步失败、缺失或尚未完整，该月份的“完整版”导出与锁定都会停用，不会悄悄退回旧明细。学生和老师详情只显示这份只读来源证据，绝不改变课包余额、合同、Booking 或原生业务状态。

月度文件是真正的 Open XML `.xlsx`，不是改扩展名的旧 `.xls`。工作簿固定包含 `Sheet1`、`学生明细`、`薪资审核`、`消课证据`、`排课课时`、`数据来源` 六页：

- `Sheet1` 保留已验收的 A–H 版式。老师和同一真实学生在一个月内合并显示；A/B/G/H 按老师分组纵向合并。D 列是学生消课合计，G 列是排课角色老师课时，两者允许因小组课而不同。
- 共享试听 A/B/C 账号在原始证据页保留账号名和账号 ID；主表与学生明细按安全解析出的真实姓名分组，绝不按共享账号 ID 把不同学生合并。
- `薪资审核` 对“待核对”老师不输出金额、银行、账户、付款说明、锁定人或锁定时间；主表 H 列显示“待核对”，未知老师总课时保持空白，不伪造为零。
- `消课证据` 与 `排课课时` 分别逐行保留白名单后的 `query_lesson_list(over=1)` 学员证据和 `query_schedule_list(over=1)` 老师角色证据；`数据来源` 记录来源 revision、映射 revision、发布时间、行数、匹配统计和口径说明，但不含 API 密钥、token 或原始响应。
- 所有文字均按普通单元格字符串写入；即使姓名以 `=`、`+`、`-` 或 `@` 开头，也不会作为 Excel 公式执行。文件大小、路径、重复 ZIP 部件、非法 XML 字符、非有限数值和超长单元格均失败关闭。

## 自动同步（生产）

当前 Vercel 项目是 Hobby，不能运行每 30 分钟的 Vercel Cron。因此生产部署用 Supabase `pg_cron` 每 30 分钟经 `pg_net` 调用受独立 bearer token 保护的 `GET /api/cron/jiaowubao-schedule`。token 只以加密形式保存于 Supabase Vault 和 Vercel 的敏感环境变量 `JIAOWUBAO_SCHEDULE_SYNC_TOKEN`，不进入代码、迁移、Cron 命令、浏览器或日志。每次读取墨尔本当天起 31 天的课表，将所有页面分别写入不可变 staging；只有所有页均通过校验后才短事务发布新的完成态来源指针。发布后，同一事务合同会生成规范化权威实体、匹配率、异常和字段覆盖汇总，并刷新同步页的来源健康状态。无变化的 30 分钟检查也会更新最近成功检查时间。若 API、网络、任一页或投影失败，上一份完整快照保持可读；重复或重叠的 Cron 调用由数据库租约和来源指针 CAS 拦截。

这一同步只处理 `query_schedule_list` 当前可以给出的课表数据。完整来源数据和规范化实体会长期入库，但不会静默创建或覆盖原生学生、老师、课程、Booking、课包或任务；任何原生业务写入仍需独立、可审计的业务合同。

已消课另有一个独立、最小权限的续跑任务：Supabase `pg_cron` 每小时在 `:07、:12、:17、:22、:37、:42、:47、:52` 经 `pg_net` 调用 `/api/cron/jiaowubao-completed-lessons`。它优先续跑任何已由管理员启动、但尚未完成的历史自然月；没有待续任务时才处理**上一个完整墨尔本自然月**。任务每次最多发起 50 个已消课来源页请求且最多工作 220 秒；数据库对 `query_lesson_list` 设置跨实例 3.2 秒全局起始间隔，游标和已确认页会在下次调用续接。最后一个学员采集完成后会主动交棒，让排课复核与原子发布在下一次请求获得完整的 300 秒窗口。`:00` 与 `:30` 前后各保留至少七分钟，避免月度任务的 `query_schedule_list` 复核与当前课表同步重叠。月度快照发布后，普通定时调用只做快速数据库 no-change 检查，不再读取供应商；超级管理员点击同步按钮传入的显式 `force` 只用于正常的已发布月份刷新。若供应商确定性拒绝某个冻结学员查询，任务进入不含学员 ID 的可审计 `blocked` 状态，停止自动死循环；浏览器、定时 bearer 和 `force` 都不能恢复该状态或新建同月 successor run。

本次历史阻断只允许走一次性的 postgres owner 管理退役，不提供网页、公开 RPC、service-role 或 cron 恢复入口。发布本仓库迁移后，运维人员必须通过项目规定的 Insider Leads Keychain 凭据包装器运行命令，并使用 owner-only 状态目录先生成聚合预检：

```bash
CODEX_COMPANY_PROFILE=insiderlead \
  /Users/nixon/Documents/Codex/bin/codex-project-credential exec supabase -- \
  node --import tsx scripts/jiaowubao-completed-lesson-retirement-management.ts \
  --state /absolute/path/to/owner-only-directory/2026-08-retirement.json \
  --month 2026-08 --actor Nixon
```

预检只输出月份、opaque confirmation key 与总人数/已完成人数/总行数，不输出 run、audit、学员或来源 ID。人工核对聚合后，复用完全相同的 `--state` 参数并增加 `--commit`；状态文件内的 caller-stable command UUID 使丢失响应后的重试仍只返回同一份不可变回执。数据库会按固定锁序重新证明“当前最新 run 仍是同一个 `blocked/caller_failure` 代次”、开始与阻断审计、聚合计数以及完整当前指针；任一变化或活跃 worker 都拒绝提交。

提交成功只把该代次原子退役为 `aborted/schedule_changed`，并保留原有 target/page/item、游标和计数作为不可变历史证据；它**不会**把旧 run 恢复为 `collecting`，也不会信任或发布那 1009 个已完成成员。随后现有普通、非 force 的 production cron 会选择这个可重建月份，重新抓取排课、重新冻结最新名册并从第一个成员开始完整采集。发布前仍会再次核对排课 revision/参与者集合/数量以及最新学员目录 revision/数量，任何漂移都会中止，当前已发布指针保持不变。

定时任务使用独立 bearer：Vercel Production 的敏感变量 `JIAOWUBAO_COMPLETED_LESSON_SYNC_TOKEN` 与 Supabase Vault 的 `jiaowubao_completed_lesson_sync_token` 必须是同一个新生成值，且不能复用课表或月度薪资的 token。定时任务只在 Vault 中恰好有一个非空 token 时发出请求；缺失或重复配置会安全地不发请求，待配置修正后下次运行自动恢复。

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
