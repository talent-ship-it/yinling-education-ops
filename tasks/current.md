# Vercel CPU recovery

Goal: reduce repeated server work, release through GitHub, and restore browser access to app.insiderleadsedu.com.

Scope: metadata-only version probes; one-minute visible workspace polling; pause the two task feeds when hidden. Reuse getOpsVersions, signed authorization, shared-state poller and request deadlines. No database migration, business-data changes, new dependencies or permission expansion.

Workspace: /Users/nixon/.codex/worktrees/vercel-cpu-recovery-20261124/feedback-20260812; branch codex/vercel-cpu-recovery-20261124; base d2285b445099b50bfdce897d338147df7908f4dc. Shared main and earlier worktree modifications are protected.

Decided: current user explicitly authorizes optimization and release. Standing application-release authorization applies. User purchased Pro and requested release again; fresh isolated Vercel read confirmed Pro/active and no soft block. No agent billing change is authorized or needed. Source inspection confirms entity-version filtering uses signed role/permissions/scope, not payload-derived record relationships; full data/projection reads must retain their single-snapshot behavior.

Status: complete; production is live. PR161 merged as 70c080e3c9058aab9e2bf7fcc6bc5bc13a473c11. Vercel deployment dpl_GNvNdHBYzVHmc36wcJbExhZuquZJ is READY at that exact SHA, and app.insiderleadsedu.com alias was separately read back pointing to it. Real company Admin acceptance passed for workspace (160 To Do / 22 All Done), student archive (674 displayed total), and today's schedule (92 displayed classes). No sync alert after hydration. Visible version probes return 200 and now run about once per minute. Actual background-tab and foreground-resume acceptance passed. Authenticated p1 remains on the working workspace; blank p2 and diagnostic listener/properties are removed.

Implementation notes: focused regressions reproduced full-payload version reads, hidden-page feed requests and the original 15-second interval, then passed 37/37. Fallow failure from a namespace import was fixed using the exact used symbol; duplicated event wiring was extracted into the existing poller. Unfiltered base/candidate clone groups decreased 361 to 360 with zero new token-count/file-instance sets. Only two obsolete normalized duplicate exemptions (r264:2 and r249:2) were removed; no new exemptions, threshold/config changes or baseline regeneration. All failed receipts remain in profile scratch. Original Hobby CPU pause was resolved by the user's Pro upgrade, not an agent billing change.

Earlier CI milestone: PR161 head deb10b2464d18f926767ea0a3994c70c2f66c056; base was d2285b445099b50bfdce897d338147df7908f4dc. Existing production-code review passed; all 10 reviewed path hashes, sizes and modes verified unchanged before this follow-up. Prior local full gates and remote verify/browser-smoke/wecom-receiver passed. SQL runtime never reached its fixtures because apt could not locate postgresql-client-16, including on Ubuntu 22.04. Official Ubuntu package metadata confirmed the distro postgresql-client package exists; the repair preserved the postgres:16 service and runtime server-version assertion. Prior failure receipts remain available.

Production baseline acceptance: company user completed login in Ego Space5/p1; resumed the same handed-off space. HTTP domain is restored. First authenticated sync exceeded the existing 10-second browser deadline; one refresh succeeded with no alert. Default Today filter had no matching tasks; All displays 160 real To Do rows and the tabs show 22 All Done. Student archive opens with real data. These observations validate the unchanged baseline, not the unmerged optimization. No explicit business edit was made.

Release milestone: CI repair 1f5b286825ed87958aa87a8835d631e03eb3862b passed all 11 exact-head GitHub/Vercel checks. SQL runtime genuinely ran and passed all 66 fixtures with distro psql 14 against the PostgreSQL 16 service. Fresh company identity, clean worktree, unchanged nine reviewed application/test paths and exact remote head verified immediately before merge. PR161 merged through GitHub at 2026-11-25T08:24:30Z; merge SHA and current remote main are 70c080e3c9058aab9e2bf7fcc6bc5bc13a473c11. Production deployment watcher proc_2aa186f8d257 waits only for this exact SHA; earlier CI watcher proc_2b9606293e9f is complete or completing. No subagents are live.

Acceptance milestone: exact-head CI logs confirm 2874 unit tests, 138 browser tests, and 66 SQL fixtures passed. Real post-deploy version samples returned 200 with durations 1016/1769/1745ms; first two start intervals were 61022/69497ms (navigation can pause/resume polling). Baseline median start interval was 18697ms with median duration 3679.5ms over ten samples. These are browser observations, not a claim of measured aggregate Vercel CPU or billing reduction. No production database migration was required. Both external watchers exited successfully; no subagents are live.

Final acceptance: real visibilitychange trace captured p1 hidden from performance time 301572ms to 430872ms (129300ms), with no new version / WeCom task / Jiaowubao task request started while hidden. Returning to p1 immediately refreshed both task feeds; they returned 200 in 4718/7089ms. The next version probe returned 200 in 1819ms on its one-minute schedule. Task count stayed 160 with no sync alerts. Removed the trace listener and properties, closed agent-owned blank p2, and kept the real company Admin p1 active. Visual screenshot inspection confirmed the workspace, sidebar, task rows and status tabs render without an offline/error overlay.

Receipts: /Users/nixon/.hermes/profiles/insiderleads/cache/scratch/vercel-cpu-release-20261124/production-acceptance.json, production-baseline.json, and production-workspace.png. Both external watchers exited successfully. No subagents are live. Only this local task record is updated after the merged release; application code remains the published reviewed candidate.

Next: none for this release. Aggregate daily Vercel CPU use and final bill reduction are not yet measured; the verified claims are lower request frequency, metadata-only probes, actual hidden-tab suspension and working production pages.

## Current follow-up: Jiaowubao continuous read repair

Goal: fix the confirmed monthly-source freshness/backlog and verify the production result, as requested after the read audit. Reuse the current resumable collector, global supplier rate gate, atomic publisher and approved company helpers. Do not change payroll values, HR decisions or supplier records.

Workspace: reuse /Users/nixon/.codex/worktrees/vercel-cpu-recovery-20261124/feedback-20260812; branch codex/jwb-continuous-read-20261125 from origin/main 70c080e3c9058aab9e2bf7fcc6bc5bc13a473c11. Initial changes were this same task record and tasks/jiaowubao-payroll-read-audit-20261125.md; both are preserved. No new worktree or subagent was created for implementation.

Decided: prioritize current-month due work over unfinished historical collection while preserving its durable cursor; keep ready publication ahead of collection and retain historical rotation. Raise the physical request ceiling from 50 to 60 within the unchanged 220-second worker deadline and 3.2-second database rate gate. No new tables, grants, dependencies or provider changes. The scoped database function migration needs explicit production approval under root AGENTS.md lines 138-144; the standing application-release authorization does not cover it. Prepare and verify the exact candidate before requesting that approval.

Status: baseline readback at 2026-11-25T10:29Z confirmed October 1013/1219, fifty physical calls per normal response and November still through November 5. The live pending-month function exactly uses active-first ordering. Recent collection history also has recoverable schedule/catalog drift, so preserve the existing retry and publication checks. Approved Supabase project/org, linked project ref and read-only transaction were verified. Ego Space6/p1 failed twice with ERR_PROXY_CONNECTION_FAILED and was handed off; do not claim browser acceptance or modify the user's proxy/profile.

Milestone: implemented the one-constant worker increase and the 19-line fail-closed queue-order migration, with focused regression coverage. The old worker returned 50 rather than 60 in both budget tests; the old SQL failed with 'previous month starved behind historical work'. The exact new migration passed the existing full authoritative chain on a task-owned PostgreSQL 16.15 instance, which was then stopped. Focused worker/contract/cron tests: 33/33 PASS. Full unit suite: 2874/2874 PASS, no skips. npm run build PASS, including bundle budgets. npm run lint PASS with one pre-existing unused-variable warning; its first foreground run timed out at 55 seconds and the tracked retry succeeded. npm run typecheck:scripts and npm run check:architecture PASS. Fallow finished successfully as proc_940fd90c99bd: dead-code, health, duplication and regression baselines all PASS (exit 0). Source is frozen in scratch/release-candidate.json: b27dcf167f3aa11be10955497cf3aa7c274235039749eaa7de28eaa238068187. The sole independent production reviewer sa-0-15015252 completed PASS with no findings in 5m19s. The parent read independent-review/report.md and recomputed all six source hashes and the frozen candidate digest; they match. Review is local logic/permission/compatibility only and does not claim remote ACL or deployment acceptance. No commit, push, PR, migration or production change has been made for this follow-up yet.

Next: stage only the explicit task files and run company PR CI, then request the exact production migration approval with the reviewed artifact. All four background local checks and the sole independent review are confirmed PASS. After approval, apply only that migration through the approved helper, read it back, release through reviewed GitHub merge, observe natural scheduled progress and verify the real payroll screen in Ego. The browser proxy blocker remains separate from code/test completion.

## Completed follow-up: Jiaowubao monthly payroll source audit

Goal: verify the monthly payroll information read from Jiaowubao, as clarified by the user. Scope is the existing source readers and production read-only observations; no additional production writes, migration, wage/rate edits or supplier changes were performed.

Status: read audit complete with unresolved freshness findings. Checked all four stored months (2026-08 through 2026-11): 6576 learner rows and 6576 schedule rows, with matching declared/stored counts and no non-completed or cross-month rows. November coverage is still only through November 5 rather than the November 24 cutoff available on this audit date. October's collection advanced from 644/1219 to 693/1219 targets between the 09:33 and 09:41 UTC observations; the queue prioritizes an active older collection. Five distinct calendars have out_of_range hour evidence: two in September and three in October, present in both learner and teacher-role evidence. Preserve those issue markers.

Verified: company-helper-wrapped READ ONLY SQL with project/org identity and transaction_read_only=on; 54/54 existing focused tests across five distinct files. No direct supplier API calls were made by this audit. Failed diagnostic attempts are retained: incorrect JSON column names (42703), then full correlated calendar matching exceeded the 10-second limit (57014). Narrower grouped structural and hour-issue checks succeeded; full calendar-by-calendar equality is not claimed.

Not verified: genuine payroll browser acceptance, because the former company Space5 is no longer available in the task-space listing; no unrelated Space was accessed. Current upstream supplier records were not independently re-read for full reconciliation. Source updates and any correction of the five affected items remain unfinished.

Decided: reuse the existing snapshot readers, collection queue, hour-evidence rules and approved account helper. No application code or production synchronization configuration changed. Next: address source freshness/backlog and the five marked calendars within a separately confirmed production-write scope, then repeat the affected source checks and genuine payroll-page acceptance. No new subagents were dispatched.

Report: tasks/jiaowubao-payroll-read-audit-20261125.md. Aggregate-only private receipts: /Users/nixon/.hermes/profiles/insiderleads/cache/scratch/jiaowubao-payroll-read-audit-20261125 (directory 0700, files 0600).

## Previous release notes

### Classroom resource library sample release

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
