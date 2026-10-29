# 教学资源底座：本地实现与待启用事项

当前状态：代码和本地验证完成；未发布、未上传教材、未新增老师授权。

## 规则依据

已通过腾讯文档 MCP 读取 Insider Leads 文档：

- https://docs.qq.com/doc/DTVZyeVpZS0Z0d2VL
- https://docs.qq.com/doc/DTUpNZ0dFSFZIYm1t
- https://docs.qq.com/doc/DTVZqZHFZakpWQUtm

需求包括课件重复调用、老师控制展示、师生同步倒计时（暂停／继续／重置）、板书导出图片或 PDF。用户提供的培训截图明确要求每节课结束前将板书保存为 PNG，并以 5 分钟倒计时作为示例。

## 已实现的本地改动

- 复用现有教材库组件，在左侧“工作台”下面新增“资源”。
- 老师可从资源页查看已授权教材，在课堂的“课堂资料”入口选用。
- 管理员切换老师视图时，资料列表按该老师的真实授权读取。
- 预览只读，隐藏管理、下载和课堂投放操作。实际课堂操作使用老师账号。
- 服务端要求管理员身份和教材读取权限，并检查目标老师账号处于 active 状态。普通老师不能请求其他老师的预览。
- 切换老师会清空上一个视图的组件状态，避免显示前一个老师的教材。

## 样本清单

8 份文件均为未加密扫描 PDF，适用于英语写作／拼写练习。文件保留用户提供的原名；不根据书籍作者推断授课老师。

| 文件 | 页数 | 字节数 | 拟分类 |
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

## 拟演示权限，尚未写入

| 现有账号 | 拟可见范围 | 依据 | 下载原件 |
| --- | --- | --- | --- |
| Admin | 全部 8 本；上传、整理、授权 | 现有管理员 | 可 |
| Megan Clark | Year 1–6 | 现有课程包含 Year 1–6 English | 默认不允许 |
| Leigh Key | Years 7–8、Years 9–10 | 现有课程包含 Year 8–10 English、Y8 Writing+Literary | 默认不允许 |
| Sophie Elliot | Year 1（如需第三种演示范围） | 现有课程包含 Prep/Year 1 English、English Writing | 默认不允许 |
| 其他未授权老师 | 不显示本次教材 | 最小范围演示 | 不允许 |

上述老师账号在只读核查时处于 active 状态。正式授权前应再次读取目标身份；不修改密码、账号角色、课程安排或任何 HR 判断字段。

## 存储与容量

已验证项目：orvsgisjjrzgtxuwwsms；组织：fgnmdykxtthalhwspelu。

- Supabase 组织套餐：Pro。
- 当前项目的 storage.objects 聚合：无对象。
- 现有 classroom-materials bucket 为私有；单文件限制 268435456 字节（256 MiB）。8 份样本均符合此限制。
- 复用 6 MiB 分片续传、签名直传和现有完成校验。文件在对象存储中，数据库保存目录／授权／元信息。
- 官方 Pro 存储额度为组织级 100 GB；超额存储和流量按套餐计费。此次未变更套餐、预算或账单，也未核查组织中其他项目及本账期流量。
- 容量参考：https://supabase.com/docs/guides/platform/manage-your-usage/storage-size
- 流量与组织计费参考：https://supabase.com/docs/guides/platform/billing-on-supabase

## 已确认的生产阻塞

线上教材库 API 返回 configured=false，页面显示“教材库尚未配置存储服务”。Vercel 生产环境缺少 CLASSROOM_MATERIALS_STORAGE_KEY。

项目根 AGENTS.md 第 109–110 行规定：

> Vercel linking and environment writes require explicit approval.

因此需要授权将现有私有存储接入该应用的服务端配置。密钥只进入批准的服务端配置，不进入聊天、浏览器、代码仓库或 Hermes 档案。用户尚未回答配置授权问题，未做此改动。

## 已执行验证

- npm run test:unit：2801 / 2801 通过。
- node --import tsx --test tests/classroom-materials*.test.ts tests/classroom-materials*.test.mjs：41 / 41 通过。
- npm run build：通过，包括 25 项课堂插件测试和客户端包大小限制。
- npm run lint、npm run typecheck:scripts、npm run check:architecture、npm run check:fallow：通过。
- npm audit --omit=dev --audit-level=high：0 个漏洞。
- npm run test:browser -- tests/browser/anonymous-shell.spec.ts：2 / 2 通过。
- 本地合成 UI 验收：管理员切换两位老师后分别显示不同教材；前一列表清空；隐藏管理／下载；无写请求和 JS 页面错误；375px 无横向溢出。

本地截图使用合成数据，不能当作真实样本上传或线上验收证据。线上板书 PNG、师生倒计时及 PDF 转换展示仍待真实课堂验收；现有代码已实现这些工具，但本次未实测确认。

## 发布与恢复

工作区：/Users/nixon/.codex/worktrees/classroom-resources-20261028/feedback-20260812

分支：codex/classroom-resources-20261028；基线：5951a08b786aeeb4473884652d7b97e914a07ba9。未提交、未推送、未发布。原工作区保持不动。

独立权限审查已通过，无安全或逻辑问题；已重新计算并确认当前代码与审查版本一致。审查提出一项可选建议：补充路由级测试，验证预览使用目标教师账号读取，写操作仍绑定登录账号。当前无必须修复项。

上线走审查后的 GitHub PR／合并发布流程。收到生产配置授权后，启用现有私有存储，逐本上传并读回 8 本的名称、大小及 ready 状态，再落演示授权和真实公司会话的课堂验收。尚未收到配置授权，未作生产改动。
