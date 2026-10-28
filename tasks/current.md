# 当前任务：修复 Zarek / Alex 交接匹配和试听后续任务

## 本次目标与范围
- 用户要求修复 Zarek 叶芯诚（27号14:21补充真名与微信名）和 Alex 王政（周日交接）的真实数据，并补齐交接匹配后自动完成任务、生成二要一发和备课任务的功能并上线。
- 已明确授权本次所需应用发布及两例相关数据恢复；只依据真实归档、身份和课表修复，不猜学生关联或时间，不改HR判断、付款、供应商课表或无关历史。
- Worktree: /Users/nixon/.codex/worktrees/hr-handover-task-chain-20261028/feedback-20260812；branch codex/hr-handover-task-chain-20261028；base origin/main 5951a08b786aeeb4473884652d7b97e914a07ba9。
- 共享main有AGENTS/DESIGN及工资相关受保护修改；本任务只在上述独立worktree修改。
- 使用现有工作流、身份匹配、任务生成、原子写入和fixture；主代理实施。最终生产候选至多一次独立审查，若触及数据库则审查精确迁移和恢复范围。

## 当前状态
- 已读项目规则、设计系统、现有任务链路；凭据验证：公司批准helper check supabase=available。
- 原始归档证实两例均为 identified，未有正式学生、LP或任务。Alex交接10/25、补真名10/25；Zarek交接10/27 14:21、补真名14:23。课表Alex10/29 17:30北京时间、Zarek10/30；分别应10/28和10/29备课。
- 根因：任务生成挂在正式LP确认后，企业微信交接仅生成草稿，不会把身份匹配和后续任务送进To Do。
- 已新增交接任务投影/服务/权限/专属保存RPC、私表迁移和现有ToDo接入。复用现有二要一发、N-3、N-1规则，不生成原始交接标为否的写作/试卷。
- 真实PG16迁移、保存读回、旧版本拒绝、越权/匿名拒绝、LP确认承接及最新回执PASS；补充TS实际生成payload经服务保存/刷新/恢复待办PASS。PGHOST=127.0.0.1 PGPORT=55438，LC_ALL=C。
- 全量unit 2800/2800、12项聚焦、scripts typecheck、architecture、Fallow三个门槛、lint和完整build PASS。lint仅既有1条warning；bundle anonymous24606B/authenticated942695B。
- 真实只读输入79条sources、22条events已生成核对：Zarek身份done/10月29日备课；Alex指定内容、N-3和10月28日备课。此前保存RPC漏了自动排课进度规则已修复并真实PG回归。
- 当前无生产写入或新发布，未提交。真实归档只读证据保存profile scratch/hr-handover-task-{discovery,authority}.json，原件不进Git。

## 下一步
- 完成一次独立候选审查，通过GitHub/Vercel发布，精确迁移后读回。主分支仍为5951a08，应用候选尚未提交；本次review初次仅因shell TMPDIR不同未启动模型，改用profile scratch绝对路径。
- 真实公司页面验收使用本任务Space11/p1，已只读确认生产公司Admin登录有效；Space9保持用户控制。

## 历史：上一任务范围
- 用户要求同一 LP 交接修改重发后按最新消息抓取，避免多份未确认草稿。
- 在本独立 worktree 实现并验证。叶级 AGENTS.md 40-56 有应用发布常设授权；生产数据库迁移不在该授权内，须单独批准后再配套发布。
- 不删除微信归档，不改已确认 LP、学生归属、HR 判断、排课或付款。

## 已决定
- 复用现有机器人入站、身份关联、LP 草稿读取和原子确认流程。
- 最新消息以 sent_at 为主，并使用稳定的消息键处理相同时间。
- 同一群、同一确定身份、同一 LP 类型和科目构成重发组；不同群、科目、业务类型和冲突身份不合并。
- 已确认记录保留；新版本使旧的未确认来源不可再次确认，数据库层同样校验，避免仅前端去重和翻页遗漏。
- 先完成可审查迁移与真实本地 PostgreSQL 回归，再向用户说明确切上线范围及需要的生产批准。

## 基线
- Worktree: /Users/nixon/.codex/worktrees/wecom-lp-latest-20261028/feedback-20260812
- Branch: codex/wecom-lp-latest-20261028
- 原始 Base: origin/main cd3c4bf2ff617f587ab0690e5d5ae5d75975424b；已 fast-forward 到 a43e09dcf6925095d20134b2ff08bffe0b125882，保留全部候选改动。
- 主目录存在其他任务的 AGENTS.md、DESIGN.md 和工资相关改动，均不修改。
- 公司 GitHub 只读身份验证：talent-ship-it。

## 上线前实现与验证记录
- 已实现最新草稿判定、分页前过滤、旧来源拒绝确认、按群锁定并发到达，以及 409 刷新提示。
- 现有归档与已确认 LP 不删除；仅未确认版本按明确身份、业务类型和科目分组。
- PostgreSQL 16.15 隔离 fixture：精确迁移 + SQL 回归 + Python 两连接并发 PASS；原有 business fixture PASS。
- 已通过批准 helper 确认生产项目；只读事务 aggregate：103 条归档、89 条交接文本、0 条 LP 确认；3 个多消息身份组不等于3个重复 LP。未写生产。
- 实际生产14个相关函数定义在合成库重放后，精确候选、业务回归、并发、实际 anon 错误 secret 和私表拒绝测试全部 PASS。
- 与最新主分支组合后相关 TS tests 45/45 PASS，tsc --noEmit、ESLint、check:architecture、git diff --check PASS。
- 无新增依赖、无 UI 布局改动、无 commit/push/PR/发布。
- 独立审查 deleg_5311de0d 已返回一个 P2：多群批次以相反顺序逐行拿群锁会死锁。保留原 failed verdict 和 report.md，未声称修正后获得二次独立通过。
- 已完成一次修复：复用 internal.lock_wecom_batch_messages，保留 message-ID/已有行锁顺序，再按数字 hash 顺序拿所有规范化输入群和已有回放群的锁。
- 新增 wecom-lp-latest-repost-batch fixture：真实 bot RPC 复现旧死锁；bot/bot、archive/archive、bot/archive 逆序批次修正后均四条完整提交 PASS。timestamp 使用真实当前时间，避免入库窗口拒绝掩盖死锁。
- 修正后的完整最新草稿 fixture + 原确认竞争场景 PASS。新取得4个生产批量函数只读基线，连同原14个函数在全新合成库重放精确迁移，业务/并发/anon拒绝 PASS；batch helper同库 OID/ACL/属性除函数体外保持。
- 生产未修改。重放使用合成数据、合成本地owner，并非生产完整权限环境；失败的fixture回执已保留。
- npm run build PASS（包括classroom-tools tests/typecheck及client bundle budget）；npm run lint 0 errors、1条既有不相关warning。
- 修正后 manifest：当前profile cache/scratch/lp-latest-candidate-fixed-manifest.json；migration SHA256=e9d7ec834539b1b62612895e01f9c38a4d1ec1a4f8c776da0d863b172725d048。
- 本地 PGDATA 当前profile cache/scratch/lp-latest-pg16/data 已正常停止；pg_ctl status退出3，postmaster.pid不存在。无活跃审查员/本任务后台进程。

## 上线授权与当前进展
- 用户明确批准：“我批准了，直接弄好上线吧”。范围为上述精确生产迁移、配套应用发布及验收；不再重复请求批准。
- Fresh main 为 9169fbd，PR145 增加交接搜索与小课表筛选，触及同一服务和测试；先保留原候选提交再 rebase，验证组合行为。
- 原七文件 manifest 逐一比对 PASS，批准迁移 SHA256 不变；公司 GitHub talent-ship-it、Vercel talent-2867/目标项目已 fresh 验证。
- Ego Space 6 为本任务新建；生产域名公司 Admin 真实登录会话可用，无需认证输入。
- Rebase 到 9169fbd 无冲突；组合测试52/52、lint和build PASS。PR147，首个head b027077。
- 远端SQL和browser-smoke PASS；verify发现新增条件触发Fallow health门槛，已将相同判断提为小函数；本地Fallow全门槛及52项测试通过，未放宽门槛。
- Fresh生产18个函数与已重放基线全部一致；迁移尚未存在，归档103、确认0。通过公司登录会话取全47条草稿，保存对照；明确重复组两版为2026-10-19 10:29和10:42，页面均显示。

## 生产发布与验收
- 最新组合 head 9ad826a444a607448f8e94f62cb45d55e4be25b5 的11项远端检查全部 SUCCESS，Vercel preview READY 后开始发布。
- 生产迁移20261028083500已应用并独立读回：精确批准SHA256不变；18个原函数属性和权限保持，6个函数体更新，4个私有helper、索引、触发器均存在。
- PR147已squash合并，merge SHA=24b4a0ae26f5a544646dbb3fb07a1b2c4908b5f8。Vercel生产dpl_CtmyXGRUPWqoBkA4nVc7SAnptCCY READY，app.insiderleadsedu.com已分配；GitHub Production deployment 7383278585 状态success。
- 真实公司Admin会话完整读回46/46条草稿，迁移前47条；精确只移除10:29旧版，10:42新版保留。两版原归档保留，归档总数103、确认0。
- 首次及早期自动刷新曾返回503；后续完整两页和多次搜索读取200。正在查只读日志并验证旧来源提交返回409，无生产测试LP写入。
- 证据位于当前profile scratch/lp-latest-production-migration-readback.json、lp-latest-release-merged.json、lp-latest-browser-after-migration-all.json。
- 503已复现，生产整批latest helper在3秒外被取消；单条source/key成功，角色anon维持原3秒。无锁等待；没有提升超时或修改资源。
- 同范围修正migration20261028110954：在完整repost_key比较前按已有trial_handover_id作必要条件过滤，保留全部分组语义。SHA256=986fe7f3901b3787b30e8a054fa0915ca0922b16850036650d8c4b52dccc9e75。
- 新84消息同群不同身份fixture旧版3488次key调用触发原断言失败，候选<=85通过；完整latest功能与确认竞争fixture通过，同库除prosrc外pg_proc全等，lint 0 errors。
- 独立只读审查deleg_cb36129e PASS，绑定精确986fe7候选；report.md保存在scratch/lp-prefilter-independent-20261028，不改变原候选的失败报告。
- migration20261028110954已执行并读回，除prosrc外函数属性全等、依赖未变、归档103/确认0。真实83条批量判定在原3s内完成，HTTP含管理请求2572ms，精确1旧版被替代。
- PR148已在11项current-head全SUCCESS及preview READY后合并，merge=f6659c3a8aaeaffb03ea695fde2b8db25d7169e1；生产部署dpl_FGHbYH19NzK4n1zzAj9FgNnwiKqL构建中。
- 公司会话完整两页47/47且唯一，较上次46增加一条新交接，未移除任何保留记录；旧10:29隐藏、新10:42保留，搜索200/total1。不要把当前47误称去重失效。
- 旧来源POST持续503/约17.6秒；生产PostgREST14.5活动在短事务中反复执行同一read_wecom_lp_draft，日志每秒wecom_lp_source_superseded；已定位40001触发网关自动重试，与批量扫描超时是两条路径。只读诊断scratch/lp-postgrest-retry-diagnosis.json。
- 计划同范围必要修正migration20261028114403，仅将本功能两个函数的superseded和confirmation_busy错误改PT409，保留其他真正并发冲突40001；应用兼容新旧码，仍给用户draft_superseded刷新提示。旧SQL和TS新增断言均已红灯复现。
- 非重试SQL最终SHA256=a266c08dbc5f10d4d4a05564d4ef43f2ef77ac23b76a50e9b09532691fc08dae。确认函数原有busy共2处，首次候选计数1触发drift守卫，修为2后完整latest及两连接竞争PASS；未修改历史迁移。
- 51项相关TS、Fallow、lint、完整build PASS，lint仅既有warning；同库精确候选事务重放后两函数pg_proc除prosrc全等并ROLLBACK。生产22函数只读preflight匹配，归档106、确认0；新增归档是自然入站，不能写死历史103。
- 独立审查deleg_2983ddca已派发，仅审六文件最终manifest；本顶层会话第三次且最后一次委派。等待结果时保留候选不变。

## 下一步
- 非重试业务409回归及必要审查、发布门禁通过后先发布兼容应用，再精确迁移，完成真实公司页面和受保护旧来源POST409验收。
- 未进行真实微信群撤回重发，不把历史两版对照或本地测试称作该项验收。
