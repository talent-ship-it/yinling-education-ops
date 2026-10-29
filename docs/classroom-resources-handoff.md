# 教学资源底座：生产启用与验收记录

当前状态：PR152 已合并并发布，生产存储已启用。用户重新登录的真实公司 Admin 会话已恢复，8 本教材全部 ready，实际对象数8、总字节548501045，与原始文件逐本一致。Megan Clark 可用小学6本，Leigh Key 可用中学2本；均不允许下载原件。早前真实课堂的师生倒计时、PDF显示和板书PNG已验证。晚间追加检查确认右上角切换仅为只读预览，当前课堂客户端又停在加载，同时发现深色样式及主应用资料读取问题；本轮完整流程未通过，详情见追加检查。教师本人从平台资源库投放仍未验证。

## 规则依据

已通过腾讯文档 MCP 读取 Insider Leads 文档：

- https://docs.qq.com/doc/DTVZyeVpZS0Z0d2VL
- https://docs.qq.com/doc/DTUpNZ0dFSFZIYm1t
- https://docs.qq.com/doc/DTVZqZHFZakpWQUtm

需求包括课件重复调用、老师控制展示、师生同步倒计时（暂停／继续／重置）、板书导出图片或 PDF。用户提供的培训截图明确要求每节课结束前将板书保存为 PNG，并以 5 分钟倒计时作为示例。

## 已上线的改动

- 复用现有教材库组件，在左侧“工作台”下面新增“资源”。
- 老师可从资源页查看已授权教材，在课堂的“课堂资料”入口选用。
- 管理员切换老师视图时，资料列表按该老师的真实授权读取。
- 预览只读，隐藏管理、下载和课堂投放操作。实际课堂操作使用老师账号。
- 服务端要求管理员身份和教材读取权限，并检查目标老师账号处于 active 状态。普通老师不能请求其他老师的预览。
- 切换老师会清空上一个视图的组件状态，避免显示前一个老师的教材。

## 样本清单

8 份文件均为未加密扫描 PDF，适用于英语写作／拼写练习。文件保留用户提供的原名；不根据书籍作者推断授课老师。

| 文件 | 页数 | 字节数 | 分类 |
| --- | ---: | ---: | --- |
| Writing Workbook Year1.pdf | 118 | 37402841 | 英语写作／小学 |
| Writing Workbook Year2.pdf | 118 | 63743944 | 英语写作／小学 |
| Writing Workbook Year3.pdf | 111 | 44205975 | 英语写作／小学 |
| Writing Workbook Year4.pdf | 111 | 57738374 | 英语写作／小学 |
| Writing Workbook Year5.pdf | 165 | 82945304 | 英语写作／小学 |
| Writing Workbook Year6.pdf | 127 | 70915404 | 英语写作／小学 |
| Writing Workbook Years 7-8.pdf | 165 | 86049339 | 英语写作／中学 |
| Writing Workbook Years 9-10.pdf | 146 | 105499864 | 英语写作／中学 |

总字节数：548501045；合计约 523.09 MiB。

## 演示权限

| 现有账号 | 已配置的范围 | 依据 | 下载原件 |
| --- | --- | --- | --- |
| Admin | 全部 8 本；上传、整理、授权 | 现有管理员 | 可 |
| Megan Clark | Year 1–6 | 现有课程包含 Year 1–6 English | 不允许 |
| Leigh Key | Years 7–8、Years 9–10 | 现有课程包含 Year 8–10 English、Y8 Writing+Literary | 不允许 |
| Sophie Elliot | 未授权，用于检查无权限视图 | 无额外演示授权 | 不允许 |
| 其他未授权老师 | 不显示本次教材 | 最小范围演示 | 不允许 |

本次已通过生产账号目录再次确认 Megan Clark、Leigh Key、Sophie Elliot 均为 active teacher。小学文件夹直接授权仅 TEA-R0139，中学仅 TEA-R0117；GET /api/classroom/materials/grants 读回确认，两者 downloadTeacherIds 均为空。不修改密码、账号角色、课程安排或任何 HR 判断字段。

账号目录的实际 account_name 就是现有登录身份，未创建新账号或修改密码：

| 登录身份 | 账号 ID | 老师 ID | 状态 |
| --- | --- | --- | --- |
| Megan Clark | 2047fabb-0900-4ce9-a0b1-f85f5eb032e2 | TEA-R0139 | active teacher |
| Leigh Key | f97506fe-d19d-414f-82e3-0c02ce9dad02 | TEA-R0117 | active teacher |
| Sophie Elliot | 3b730de7-d57d-463e-8a59-06a8a8a5f871 | TEA-R0182；本次未授教材权限 | active teacher |

## 存储与容量

已验证项目：orvsgisjjrzgtxuwwsms；组织：fgnmdykxtthalhwspelu。

- Supabase 组织套餐：Pro。
- 最终 read-only 查询 storage.objects：classroom-materials 共8个对象、548501045字节，当前项目无其他 bucket 对象。全部文件元信息 byte_size 与实际对象 metadata.size 及源文件大小一致，无重复记录。
- 现有 classroom-materials bucket 为私有；单文件限制 268435456 字节（256 MiB）。8 份样本均符合此限制。
- 复用 6 MiB 分片续传、签名直传和现有完成校验。文件在对象存储中，数据库保存目录／授权／元信息。
- 官方 Pro 存储额度为组织级 100 GB；超额存储和流量按套餐计费。此次未变更套餐、预算或账单，也未核查组织中其他项目及本账期流量。
- 容量参考：https://supabase.com/docs/guides/platform/manage-your-usage/storage-size
- 流量与组织计费参考：https://supabase.com/docs/guides/platform/billing-on-supabase

## 生产配置

用户已明确回复“授权”。CLASSROOM_MATERIALS_STORAGE_KEY 已作为生产敏感环境变量写入并读回；真实 Admin 会话 GET /api/classroom/materials 返回 HTTP200、configured=true、canManage=true。

项目根 AGENTS.md 第 109–110 行规定：

> Vercel linking and environment writes require explicit approval.

批准已满足。密钥仅进入批准的服务端配置，不进入聊天、浏览器、代码仓库或 Hermes 档案。真实上传发现项目级 fileSizeLimit 仍为 52428800（50MiB），低于教材 bucket 的 256MiB；已将该单一配置对齐至 268435456，管理 API 读回确认，其他配置及 Pro 套餐保持不变。

## 已执行验证

- 合并上游后 npm run test:unit：2809 / 2809 通过。
- node --import tsx --test tests/classroom-materials*.test.ts tests/classroom-materials*.test.mjs：41 / 41 通过。
- npm run build：通过，包括 25 项课堂插件测试和客户端包大小限制。
- npm run lint、npm run typecheck:scripts、npm run check:architecture、npm run check:fallow：通过。
- npm audit --omit=dev --audit-level=high：0 个漏洞。
- npm run test:browser -- tests/browser/anonymous-shell.spec.ts：2 / 2 通过。
- 本地合成 UI 验收：管理员切换两位老师后分别显示不同教材；前一列表清空；隐藏管理／下载；无写请求和 JS 页面错误；375px 无横向溢出。

本地截图使用合成数据，不能当作真实样本上传或线上验收证据。

本次已通过生产公司登录完成以下真实验收：

- 最终12个生产 GET 验证：Megan Clark 仅显示小学6本，跨读中学 HTTP404；Leigh Key 仅显示中学2本，跨读小学 HTTP404；Sophie Elliot 根列表为空，直接请求三个资源目录均 HTTP404。预览均 canManage=false、canPresent=false，8份文件均 ready 且 canDownload=false。两文件夹 grant GET再次读回确认。
- 经批准的 Supabase Management API 执行 read-only 事务：3个实际 teacher account ×8份教材的24条 access校验符合预期；Megan6份可课堂使用，Leigh2份，Sophie0份；24条 download权限均false。仅查询现有授权函数，不修改账号或权限。
- 不登记课时、不录播的临时课堂实际加入老师端和学生端。倒计时开始、暂停、继续、重置均已操作；同步后两端暂停于 04:59，间隔1.8秒再次采样仍一致；重置两端均05:00。学生端只有只读显示。
- 真实画笔黑线保存为 board-mark-export-live.png，PNG2883×1622、100477字节，视觉核对保留笔迹。另有真实教材页面 PNG 导出。
- 通过课堂自带 Upload/Manage presentations 上传原始 Year1 PDF，转换为118页，老师端和学生端均显示同一封面，并已切换到下一页。此项验证 PDF 兼容性，不等同教师从平台教材库直接投放验收。
- 第2页同步后再次导出 year1-content-export-live.png，视觉确认是原书目录页。第一次点击翻页后立即导出的文件仍为封面，因此不把该次导出当作第2页证据；实际导出以页面已更新为准。
- Admin 从生产下载接口取签名，存储 Range 读回 HTTP206、Content-Range bytes0–31/37402841、application/pdf、文件头%PDF-1.3。签名未写盘或记录。
- 临时课堂到期后老师端和学生端均返回正式应用；确认后关闭两张测试页，原公司 p1 保留。

未验证：教师真实登录后的平台教材库投放。当前有效公司会话及已保存登录仅 Admin；管理员只读预览按设计不能冒充教师投放。已验证现有授权函数、实际预览隔离及课堂内原PDF兼容性，未重置教师密码或绕过身份。组织其他项目用量和本账期流量也未查询。

本次实际执行的最终验收脚本均 exit0，位于当前 insiderleads profile scratch/classroom-resources-20261028：

- verify-final-server-state.py：8份ready、源/记录/对象大小相同、private bucket、24条权限、8对象总量；证据live-server-acceptance.json。
- verify-final-previews.mjs：12个生产GET、三位老师6/2/0、两份直接grants；证据live-preview-final.json。
- 上传完成回执live-upload-receipt.json：8份、548501045字节。脚本只持有短时签名于内存；凭据不写入文件。

## 右上角身份切换：2026-10-29 晚间追加检查

用户要求使用超级管理员右上角“切换工作身份”检查完整流程。本轮执行线上检查，未修改应用、认证、授权或正式课次。

- 实际切换 Megan Clark、Leigh Key、Sophie Elliot，资源页逐一显示6本、2本、0本；前一个人的列表清空，Megan的Year1搜索和Leigh的9-10搜索均命中单一正确文件。网上教室页面也有相同只读资料库。
- 此切换只改变前端 currentOperator，签名会话仍为Admin。两位老师视图下没有“课堂使用”按钮；调用真实present入口返回HTTP403、materials_forbidden、“请使用本节课教师账号打开教材”。因此该入口无法完成教师身份下的投放验收。没有伪造教师登录或修改权限。
- 当前深色模式下，资源面板背景为白色，标题和预览提示继承rgb(243,245,247)，实际对比度约1.093:1；截图可见文字难以辨认。样式对应app/classroom-materials.module.css的panel固定白底与动态ink颜色。
- 身份切换后出现“离线”，提示signal is aborted without reason；随后捕获的6个app-state GET均200，navigator.onLine=true，提示仍保留。之后主应用重新载入出现“无法读取真实资料 / Supabase 真实资料读取失败”。单独查询教材与teachers接口均200，独立/classroom/materials页面可用。本轮未确定读取失败与过时离线提示是否同一原因。
- 为检查当前课堂连接，Admin创建一间不登记课时、不录播的临时课堂：HTTP200、recorded=false。老师端和参与者端均停在加载界面；一次重载仍未进入可用课堂。主脚本HEAD200不能替代课堂成功。本轮课堂复验未通过，早前成功的PDF、计时和PNG证据仍保留但不作为本轮成功证据。
- 已关闭本轮p7/p8两张临时课堂页；原公司窗口与p6保留。没有确认服务端课堂结束；此无参与者测试房间设45分钟未加入自动过期。p2交付独立教材库，保持Admin会话。

执行脚本profile-switch-flow-round01.mjs退出0；三位老师实际UI证据保存在profile-switch-flow-live.json。阻塞、样式和读取证据见profile-switch-audit-findings.json、profile-flow-final-read-health.json及profile-flow-*-20261029.png。上述文件仅在本任务scratch中。本轮只报告问题，修复需用户确认。

## 真实账号切换修复候选：2026-10-30

用户要求切换后具备目标账号的完整实际权限，并修复本轮发现的问题后上线。本次将右上角、手机菜单和账号管理的切换入口接入服务器会话。目标账号使用独立短时会话；每次受保护请求重新读取目标账号权限和数据范围，保留原管理员会话供返回。停用、撤销、权限版本变化及强制改密限制继续生效。切换后修改密码、MFA和撤销目标会话只清除目标身份；明确退出登录才撤销原登录。切换动作记录原管理员和目标账号审计。

同时修复完整私有数据过大时的响应、初始读取无超时和无重试入口、读取恢复后仍保留离线提示、教材深色模式白底。复用现有完整数据、授权过滤和样式令牌。BBB曾实际恢复进入白板并加载保存板书和倒计时工具，测试房间已结束；未查明先前瞬时加载失败的唯一原因，因此没有未经证实的BBB代码改动，发布后仍须真实复验。

独立审查发现两项阻断：强制改密页无法返回管理员、账号切换锁序可能与在线会话读取形成死锁。一次修正已完成；新增浏览器返回回归、真实PostgreSQL并发回放及有界RPC重试测试均通过。保留原审查失败记录，不声称二次独立审查通过。

最终本地验证：2819项单元测试、133项浏览器测试全部通过；真实SQL权限和并发回归、完整build、25项课堂插件测试、包大小门槛、scripts typecheck、architecture及Fallow通过。lint无错误，仅一项既有warning；生产依赖audit为0漏洞。

生产只读检查确认新RPC和迁移版本均不存在。待批准迁移：20261030010000_account_impersonation_sessions.sql，SHA256为4c06844d38ef6c4bdef61b4e6c19d42fc22d1556e283309da9fae9e2d52db7b6。范围仅新增短时会话RPC、执行授权及迁移记录；不修改现有账号角色、密码或业务数据。此前批准框超时未答复，当前尚未执行迁移或发布本轮修复。合并后须用真实公司登录验证切换、权限拒绝、返回管理员及课堂教材操作。

## 发布与恢复

工作区：/Users/nixon/.codex/worktrees/classroom-resources-20261028/feedback-20260812

分支：codex/classroom-resources-20261028；PR head f19a1fcfe8c2ad7953cdbae5451f7d6e519df0a8，基于 origin/main 91015f2。PR152 已合并，生产 merge SHA 为 3e59fd00eafb93698f57ee188d0e461a28bd2af0。11 项远端检查通过，生产 deployment7401624808 为 success；正式域名 HTTP200。原工作区保持不动。

独立权限审查已通过，无安全或逻辑问题；已重新计算并确认当前代码与审查版本一致。审查提出一项可选建议：补充路由级测试，验证预览使用目标教师账号读取，写操作仍绑定登录账号。当前无必须修复项。

已按审查后的 GitHub PR／合并流程上线。沿用用户重新登录的公司 Ego Space12，在 p2 上传真实教材，在临时课堂完成不登记课时、不录播的工具验收。浏览器上传遇到网络断线后暂停队列，通过相同签名和续传目标恢复；以完成接口及逐本 ready 读回作为上传完成标准。续传中服务端可能已接收部分分片，按 HEAD 确认的偏移量从原文件继续，不跳过任何字节。
