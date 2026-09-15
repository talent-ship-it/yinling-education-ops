# 企业微信会话存档接入

## 采用的方案

入站资料以企业微信“会话内容存档 / 数据与智能专区”API 为主。`wecom-cli` 只适合后续做可选的机器人出站通知；它不能可靠读取完整群聊历史、引用上下文和附件正文，因此不作为六个外部群的全量数据源。

当前 VPS 上另有一个受限的 Bot 长连接，用于验证机器人被明确 `@` 后的消息链路。它不是会话内容存档替代品；同步后会把回调写进同一个 Supabase 归档表。文本回调复用确定性分类规则（例如“信息交接”“信息交接表”或“信息交接单”会标为 `handover`）。已在活跃名单中的学生，仍只会在学生姓名/家长微信名形成唯一精确匹配时才自动关联并写入内部消息队列。试听交接是例外：它先按“群 ID + 微信名”建立私有试听交接记录，显示为“等待学生姓名”；之后同群里补充微信名和学生中英文姓名时，系统会先做空格、标点与简短角色后缀的容错比对，并且只在同群中存在唯一明显候选时确认到同一记录。这个确认不创建学生、LP、排课、付款或任务。图片等非文本回调保持 `pending/other`。每条回调只有在 Supabase 提交成功后，机器人才会将“正在收录”更新为“已收录到系统审核队列”；临时回复凭据不会落盘。

生产链路：

1. 企业微信授权范围内的 worker 拉取并用官方 SDK 解密会话记录。
2. worker 下载该消息的图片/PDF，计算 SHA-256，并提交到 `POST /api/integrations/wecom/archive`。
3. 服务器重新做大小、格式、摘要、消息分类和字段清洗。
4. PostgreSQL 按家长微信名/学生姓名做唯一精确匹配；试听交接在没有学生姓名时，先按同一群中的微信名建立身份桥接记录。
5. 唯一匹配的内容进入系统“消息队列（仅内部）”；图片/PDF 进入该学生的私有文件中心。
6. 无匹配或多匹配的记录留在管理员审核箱，系统不猜学生。缺少学生姓名但已有微信名的试听交接会显示为“等待学生姓名”，不是匹配失败。
7. Bot 长连接的回调由 `/api/integrations/wecom/bot-inbox` 写入同一归档表；文本先复用确定性分类和显式身份提示提取，再按唯一精确匹配规则自动关联。无匹配或多匹配继续留在审核箱；非文本保持 `pending/other`。自动关联只投影内部消息/附件视图，不会创建学生，也不会修改 LP、排课或付款状态。

标准应用回调另设为 `GET/POST /api/integrations/wecom/callback`。它只负责签名、时间窗、AES、PKCS#7 和 Corp ID 验证，不会冒充会话存档接口。

## 默认关闭与密钥

代码部署后不会自动读取任何聊天。启用会话存档桥接必须同时通过部署平台的加密环境变量设置：

- `WECOM_ARCHIVE_BRIDGE_TOKEN`：只给归档 worker 和受限 Bot 同步 worker 使用的独立高熵 Bearer token；至少 32 个可见 ASCII 字符并具备足够字符多样性，不接受示例/占位值；不要复用 `OPS_API_SECRET`。
- `WECOM_ARCHIVE_STARTED_AT`：完整 ISO 时间，例如 `2026-09-01T00:00:00.000Z`。早于此时间的消息在服务器和数据库两层都会被拒绝，用于落实“只处理入群后的新资料”。

如需启用普通应用回调，再独立设置：

- `WECOM_CALLBACK_TOKEN`
- `WECOM_CALLBACK_ENCODING_AES_KEY`
- `WECOM_CORP_ID`

企业微信数据专区使用的私钥、SDK 凭据和 CorpSecret 只放 worker 所在主机的 secrets manager，不进入本仓库，也不通过浏览器传递。

## Worker 提交合同

请求使用 `Authorization: Bearer ...` 和 `Content-Type: application/json`。单批 1–50 条，总请求不超过 8 MB；每个图片/PDF 不超过 3 MB。

下面全部为合成示例：

```json
{
  "records": [
    {
      "msgid": "synthetic-message-001",
      "roomid": "synthetic-room-001",
      "from": "synthetic-user-001",
      "msgtime": 1788221700000,
      "msgtype": "text",
      "text": {
        "content": "信息交接表\n学生姓名：Mia示例\n家长微信名：SyntheticParent\n科目：English"
      },
      "contextText": [
        "家长微信名：SyntheticParent"
      ],
      "media": []
    }
  ]
}
```

图片/PDF 需由 worker 先下载后放入同一条记录的 `media`：

```json
{
  "mediaKey": "synthetic-media-001",
  "fileName": "renewal-follow-up.jpg",
  "contentType": "image/jpeg",
  "contentBase64": "...",
  "sha256": "64-character-lowercase-hex"
}
```

worker 必须先用受信文件解析器确认内容确实是图片/PDF；系统随后还会在 Node 与 PostgreSQL 两层核对摘要、大小和文件签名字节。网页端图片带 `nosniff` 私有响应，PDF 只以附件下载。

解析器也接受 `messageId/chatId/senderId/sentAt/messageType` 这一组规范字段。聊天文字一律视为不可信数据；其中出现的命令、链接或提示不会被执行。

识别规则为保守确定性规则：

- 明确出现“信息交接/信息交接表”，或同时具备足够多的试听交接字段，才分类为交接表。
- 明确出现“续费前跟进/续课跟进”才分类为续费跟进。
- 明确出现“试听待排课/试听…排课”才分类为试听排课。
- 只从“学生姓名/学生名/学生/姓名(如提到)/家长微信名/微信名”等显式标签，以及单条“姓名，续费前跟进”格式提取关联提示。教务和课程规划老师同样只从各自的明确标签读取。
- 同一消息出现多个候选姓名时不选任何一个，转人工审核。

Bot 自动配对的写入合同：

- 先保存原始文本、群 ID、发送者 ID、消息时间、分类和提示字段；来源固定标记为 `WeCom Bot Receiver`。
- 仅对 `handover`、`renewal_follow_up`、`trial_scheduling` 文本执行匹配；姓名和家长微信名按大小写/空白归一化后要求活跃学生名单中恰好一个 ID 同时满足全部已提供字段。
- 唯一匹配会写入 `student_id`、标记 `match_status=linked`，并把文本投影到内部消息队列；审计记录标记 `wecom.bot.auto_match` 和策略 `exact_unique_active_student_identity`。
- 对试听交接，明确的微信名会在相同群 ID 中建立/复用一个身份记录：没有学生姓名时为 `awaiting_student_name`，随后补学生姓名时会先尝试同群的唯一精确匹配，再容错接受空格、标点或简短角色后缀差异；唯一候选为 `identified`。矛盾的后续姓名为 `identity_conflict`，多个容错候选为 `identity_ambiguous`，两者均留给管理员处理。
- 0 个活跃名单候选保持 `pending`，多个候选标记 `ambiguous`；系统不会模糊匹配、猜测、创建学生或覆盖人工关联。

试听交接模板必须包含以下三项，即使暂时没有学生姓名：

```text
【微信名】：家长当前企业微信显示名
【教务】：负责教务老师
【课程规划老师】：负责课程规划老师
```

学生姓名随后确认时，在**同一个机器人已加入的群**发送一条包含以下两项的文字即可（不必重发完整交接表）：

```text
【微信名】：原微信名的核心称呼即可（不必逐字完全一致）
【学生姓名】：英文名中文名
```

## 管理与验收

超级管理员登录后调用 `GET /api/integrations/wecom/archive` 可看到：

- 数据库合同是否已部署；
- bridge/callback 是否具备配置（只返回缺失的变量名，不返回值）；
- 总数、已关联、待关联、歧义数；
- 试听交接中等待学生姓名、已确认身份、身份冲突、微信名候选不唯一的数量；
- 最近 100 条审核箱记录。

待关联项可用以下请求明确关联，操作会原子写入并记录审计：

```json
{
  "messageId": "synthetic-message-001",
  "studentId": "SYNTHETIC-STUDENT-001"
}
```

发送到 `PATCH /api/integrations/wecom/archive`。只有超级管理员的有效网页会话可执行；已归档学生不可作为目标。

上线验收顺序：

1. 先部署数据库 migration 和应用代码，保持 bridge 环境变量为空，确认线上仍为关闭状态。
2. 在企业微信后台开通会话存档权限、配置数据专区公钥并限定群/成员范围。
3. 设置独立 token 和准确的 `WECOM_ARCHIVE_STARTED_AT`，再启动 worker。
4. 用一条合成/测试交接文字和一张测试截图验证：入站、去重、唯一关联、文件权限。
5. 再验证一条无姓名和一条同名记录都进入审核箱，没有误关联。
6. 最后才扩大企业微信授权范围；worker 必须在企业微信允许的拉取窗口内持续保存游标并重试。

参考：[企业微信 AI/CLI](https://work.weixin.qq.com/nl/index/aicli?from=developer)、[wecom-cli](https://github.com/WecomTeam/wecom-cli)、[企业微信会话内容存档](https://developer.work.weixin.qq.com/document/path/101365)。
