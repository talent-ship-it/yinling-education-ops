# 当前任务：LP 微信交接重发后采用最新草稿

## 目标与范围
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

## 状态
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

## 下一步
- 正常 GitHub PR 和所有远端门禁通过后执行隔离迁移，读取迁移历史和函数定义确认；合并触发生产发布。
- 用生产公司 Ego 会话验证受影响交接列表和草稿；尚未进行真实微信群撤回重发，不得以本地测试代替此项。
