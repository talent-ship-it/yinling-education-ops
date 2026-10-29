# Classroom resource library sample release

Goal: expose Resources in the existing platform, load the user's eight scanned Writing Workbooks, authorize suitable teachers, and verify classroom reuse plus board PNG/timer tools.

## Upstream task record retained during rebase

The following upstream task record belongs to PR151 and does not authorize additional work in this resource release.

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
- 已提交初版83c4305并创建PR151；当前review修正尚未提交，无本次生产写入或新发布。真实归档只读证据保存profile scratch/hr-handover-task-{discovery,authority}.json，原件不进Git。
- 一次独立审查发现3项：改期后已完成任务历史丢失、未知身份未参与课表竞争、LP确认承接旧身份状态。一次集中修正及对应TS/真实PG红绿回归通过；保留原审查失败报告，不声称二次独立PASS。
- 全量真实输入复验揭示Alex同老师/科目受到两条未知姓名交接竞争。仅当已验证交接全名与唯一课表标题全名一致时，为提醒保留现有全部安全检查并排除仅缺姓名的候选；已知/冲突身份仍参与竞争，正式身份和LP不被自动确认。57项聚焦及两位真实输入任务/日期核对PASS；Fallow全门槛PASS。

## 下一步
- 完成集中修正的发布检查和提交，等待PR151精确head的CI/Vercel，精确迁移后读回、合并发布并验收。生产迁移与应用均未发布；旧preflight仅为旧候选证据，需按修正后迁移生成新preflight。
- 真实公司页面验收使用本任务Space11/p1，已只读确认生产公司Admin登录有效；Space9保持用户控制。

## 历史：上一任务范围
- 用户要求同一 LP 交接修改重发后按最新消息抓取，避免多份未确认草稿。
- 在本独立 worktree 实现并验证。叶级 AGENTS.md 40-56 有应用发布常设授权；生产数据库迁移不在该授权内，须单独批准后再配套发布。
- 不删除微信归档，不改已确认 LP、学生归属、HR 判断、排课或付款。
## Resource release scope and state

Scope: existing Insider Leads app and private Supabase storage (project orvsgisjjrzgtxuwwsms, org fgnmdykxtthalhwspelu). User explicitly authorized these eight uploads and scoped resource access grants. Standing app release authorization in AGENTS.md applies. No unrelated account credentials, HR fields, subscriptions or billing changes.

Workspace: /Users/nixon/.codex/worktrees/classroom-resources-20261028/feedback-20260812; branch codex/classroom-resources-20261028; base 5951a08. Original main has protected changes and is behind; leave it untouched.

Decided:
- Reuse ClassroomMaterialsPanel, classroom-materials APIs/RPC, private bucket and resumable upload helper; no new storage service.
- Add Resources after Workspace in left navigation. Admin teacher-view preview is read-only and uses the target active teacher account through the existing database authorization; writes retain the signed actor.
- Samples: eight PDFs in user-provided Downloads/Writing Workbooks, scanned, total about 523 MiB. Exact inventory/rendered sample evidence in active profile scratch/classroom-resources-20261028/sample-inventory.json. Covers and contents: English writing and spelling Year1–10.
- Tencent Docs MCP identity confirmed Tara / Insider Leads. Read live requirements DTVZyeVpZS0Z0d2VL, DTUpNZ0dFSFZIYm1t, DTVZqZHFZakpWQUtm. Search MCP has schema bug (total string); direct get_content works.
- Provisional demo categories: Primary (Y1–6), Secondary (Y7–10), restricted class-use grants to suitable existing English teachers; no original downloads unless explicitly chosen.

Status:
- Latest main implements library, 6MiB resumable upload, folder/material display/download grants and BBB classroom picker.
- Live company Admin login in Ego Space 10. /api/classroom/materials returns 200, empty library, canManage true, configured FALSE. No samples uploaded.
- Production CLASSROOM_MATERIALS_STORAGE_KEY was added as a sensitive production-only variable and exact metadata read back (UL2EV2fFVYzI7K0v). Existing classroom-materials bucket remains PRIVATE with 256MiB per-file limit. User explicitly authorized config, publishing, the 8 uploads, scoped demo grants and real acceptance. No billing or unrelated credential changes.
- Supabase helper available, Management API project/org ACTIVE_HEALTHY verified. Vercel user talent-2867, project prj_9du7fIkHpmIWXr5xZ1ASVguf1sFv and scope talent-2867s-projects verified via npx vercel.
- Teacher account roster confirms Megan Clark, Sophie Elliot, Leigh Key active; subject evidence in private scratch. No teacher names inferred from book authors.
- Added Resources navigation and server-side read-only preview, including signed admin + material read permission checks and active-teacher resolution. All writes retain signed actor. Regression coverage verifies role/permission rejection, inactive accounts and no mutation of original grant data.
- Verification passed: 2801/2801 unit tests; 41 material-specific tests; production build and its 25 classroom plugin tests/client bundle budget; lint; typecheck:scripts; API write boundary; fallow dead-code/health/dupes; npm audit 0 vulnerabilities; 2 signed-out shell browser tests. Three initial failures were obsolete navigation menu expectations and were updated without dropping assertions.
- Local synthetic UI smoke PASS: admin -> primary teacher -> secondary teacher, correct viewAsTeacher requests, no stale material rows, no management/download actions in preview, no writes, no JS page errors, 375px no overflow. Screenshots output/playwright/resources-local-{desktop,mobile}.png. This is not live sample acceptance.
- Independent permission review sa-0-c60997fa via deleg_b08f1f40 returned PASS: no security concerns or logic errors. Parent recomputed candidate manifest 8cd41f0eb5a806d639d62988673ed301575c32a23a419b4e711846ad3ce5e130 across the 8 scoped app/test files and confirmed an exact match. Optional suggestion: add a route-level regression proving preview uses the target teacher while writes remain bound to the signed actor. No additional code changes needed for the review result.
- Ego space 10 became unavailable on final read; do not invent a replacement logged-in session. Need recover existing company session through listTaskSpaces before production acceptance.
- Read-only capacity check verified organization plan=pro and project storage.objects has no objects. Official Pro quota is 100GB shared across organization projects. Current bill-period average, other-project usage, bandwidth and costs remain unverified. No billing changes.
- Earlier config clarification timed out; latest user reply "授权" now supplies the requested authorization. Details and proposed demo mapping in docs/classroom-resources-handoff.md. No commit/push/release yet.
- Local UI server stopped and Playwright session closed after smoke; no local server intentionally left running.
- No dependencies added. Installed existing deps with npm ci --ignore-scripts.

Next:
1. Permission review complete and exact candidate verified; no fix round required.
2. Production configuration enabled and read back; next deployment will activate it. No secret file was created. Management api-keys with reveal=true returned 403; the documented regular api-keys endpoint succeeded using the same approved helper and verified project/org.
3. Prepare release PR with exact checks. Release via reviewed GitHub merge once review/required checks pass.
4. After explicit environment approval, enable scoped storage configuration, upload 8 samples through real app, verify exact count/size and teacher visibility/classroom/PNG/timer in Ego.

Subagents: none live. sa-0-c60997fa completed the read-only permission review; one delegation used.
