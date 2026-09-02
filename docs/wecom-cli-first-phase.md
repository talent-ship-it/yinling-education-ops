# 企业微信 CLI 第一期

## 已确认的产品边界

本期选择官方 `wecom-cli`，目的是先让站内“消息队列”能够在**人工确认后**向固定的内部企业微信对象发送文字通知。它不是企业微信会话内容存档的替代品。

会议记录中提出的两个优先入站功能仍然保留为后续工作：

1. 在新试听群里识别“信息交接表”并写入系统；
2. 保存群里的图片到正确的学生资料位置。

官方 CLI 的消息能力是机器人向授权人或最近活跃会话主动发送；不能可靠地自动读取完整群聊、附件或历史。因此本期不会把 CLI 误标为“已完成信息交接表识别/图片归档”。这些功能之后仍需企业微信会话内容存档/数据与智能专区权限及独立入站 worker。

## 会议范围保留

- 只从接入人员入群之后的新试听群开始，不追溯旧群历史。
- 首期业务验证优先覆盖“试听学员 B”账号；学生姓名需要从教务宝课程名称中解析。
- 销售交接时可能还没有可靠学生姓名。家长微信名可能变化或含表情，因此不能作为自动写死的主键；无法唯一对应时必须转人工确认。
- 未来入站资料和图片的最终归档规则仍需业务方确认“标 1/非标 1”对应的账号路由，系统不得猜测。

## 出站投递合同

```text
网站已保存的消息队列项
  → 人工确认 + 15 分钟二次授权
  → 网站服务端按 messageId 和版本号重读消息
  → 私有 CLI bridge
  → 本次 wecom-cli sessions list 中唯一精确匹配 name/type
  → wecom-cli message aibot send
```

浏览器请求只允许：

```json
{
  "messageId": "MSG-...",
  "expectedMessagesVersion": 42
}
```

正文、收件对象、CLI 动作和真实聊天 ID 均不能从浏览器传入。服务端只允许状态为“待人工确认”、且具有已登记 `recipientRef` 的消息发送。bridge 每次发送前都调用官方 CLI 的 `sessions list`，以私有配置中的精确 `chatName`/`chatType` 在**本次**返回结果唯一匹配；只有该结果中的临时 ID 可以进入 `send`。未匹配或多重匹配时拒绝发送，绝不保存或复用旧 ID。消息状态为：

```text
仅内部 → （不发送）
待人工确认 → 发送中 → 已发送
                      ↘ 发送失败
```

若桥接网络结果未知，消息保持“发送中”，不得用新的投递 ID 自动重试。

## 配置责任

网站运行环境需要：

- `WECOM_DISPATCH_PASSWORD`
- `WECOM_DISPATCH_SESSION_SECRET`
- `WECOM_CLI_BRIDGE_URL`
- `WECOM_CLI_BRIDGE_TOKEN`
- `WECOM_CLI_PUBLIC_RECIPIENTS_JSON`（仅 `{ ref: { label } }`，没有 chat ID）

私有 bridge 主机需要：

- 官方 CLI 完成一次 `wecom-cli auth init` 授权；
- `WECOM_CLI_BRIDGE_TOKEN`；
- `WECOM_CLI_RECIPIENTS_JSON`（仅 `{ ref: { chatName, chatType } }`，不能保存 `chatId`）；
- 受保护的投递去重文件路径。

具体启动和密钥隔离说明见 [`services/wecom-cli-bridge/README.md`](../services/wecom-cli-bridge/README.md)。任何 bot 凭据、chat ID、桥接 token 或企业微信文件都不能提交到 Git。

## 验收

1. 使用企业微信二维码/Bot 授权完成 CLI 登录；不申请会话内容存档 API。
2. 先让内部测试对象与机器人形成一个当前会话，再在 bridge 中仅登记它的精确会话名称和类型。
3. 在网站新建一条内部提醒，选择该对象。
4. 输入发送二次授权密码，并人工点击发送。
5. 验证企业微信收到一次 Markdown 文本，网站状态变为“已发送”。
6. 重复请求同一 `deliveryId` 时 bridge 必须返回已有结果，而不重复发送。
7. 验证不存在、歧义或未登记的会话，以及家长对象、群聊天内容、图片/附件均不能通过此一期自动投递或读取。
