# 教务宝月度课时表自动生成

## 已实现的口径

- 月度完整表数据工具：`query_lesson_list`；它是唯一可用于逐学生薪资核对的数据源。
- 另已接入 `query_member_simple_list` 的受筛选学员核验，以及 `query_schedule_list` 的排课汇总核验；两者均只读、仅保留在当前浏览器，不会写入共享学生、排课、老师或薪资资料。
- 每次查询强制传入 `start`、`end`、`sign=-1`、`over=1`、`page` 和 `limit`；任何配置都不能覆盖这些字段，也不能加入会缩小范围的 `mem_id`、`course_id` 或 `team_id`。
- 分页只会在教务宝返回**空页**时结束。不会因为短页或未文档化的 `total` 而静默漏掉后续课节。
- 课节唯一键是 `branch_id:cal_id:mem_id`。同一 `cal_id` 对应多位学生是合法的，会全部保留。
- 数据按学生使用 `mem_id` / `mem_title`，不会误把班级 `team_title` 当学生。
- 输出四个工作表：保留既有 12 列格式的 `Sheet1`、既有 9 列格式的 `学生明细`、`课节原始明细` 和 `数据说明`。
- 没有教师 ID 的已结课记录会显示为「未分配教师」，不会只藏在原始数据页。
- `price` 是课程价格，不是老师费率；没有权威老师月度总课时和费率时，所有薪资栏保留「待补」或「不自动计算」。
- 多老师课没有文档化的角色课时分配时，不会猜测或重复计入。一个多人课同时包含试听与常规账号时，该老师组会标为待分类。
- 只读教务宝，不回写或删除教务宝资料。

## 试听账号规则

试听不是靠课程 `type` 猜测。请将教务宝中承载试听排课的三个 B 账号的 `mem_id` 写入：

```text
JIAOWUBAO_TRIAL_MEMBER_IDS=123,456,789
```

三个 ID 必须由学校确认并且完整配置。留空时系统安全地将所有课节列为「待分类」；不是恰好三个 ID、格式错误或重复 ID 都会直接失败，不会把遗漏的试听账号误算为常规。

会议记录提到课程名称，截图则显示真实试听学生名在「班级」字段；接口分别叫 `course_title` 和 `team_title`。对已配置为试听的 B 账号，系统会检查两者开头是否精确匹配「英文名 + 中文名」；班级字段另支持截图中的 `Rita Wu (NZL)` 这类「英文名 + 地区后缀」。只匹配一处，或两处匹配同一姓名时，才将其作为**显示学生姓名**；两处不一致或都未匹配时不会猜测，仍显示原始 `mem_title` B 账号并标为待核对。为避免把课程名误认成学生，纯英文格式不会从 `course_title` 提取。原始账号始终保留在「课节原始明细」中。若学校后续提供权威的 B 账号—学生映射或查询接口，应以该权威来源替换此待核对显示规则。

## 连接配置

网站运行时变量应填入 Vercel 项目的 **Production Environment Variables**，不要放到浏览器代码、Git 仓库、GitHub Actions 日志或 Excel 文件。Vercel 的变量更新会在下一次由 GitHub `main` 触发的部署生效。

### 已确认的开放 API 网关

已按「开放 API 网关」文档接入其 JSON 协议，并以无效测试密钥确认国内 HTTPS 网关可达且会返回 `401`。Vercel Production 只需提供管理端分配的 `JIAOWUBAO_GATEWAY_SK`；已有项目的旧变量 `JIAOWUBAO_OPEN_API_SK` 也会被服务器端兼容读取，避免为了改名导出或复制现有密钥。应用会固定发送：

```json
{
  "sk": "<只存在服务器环境变量中>",
  "tool": "query_lesson_list",
  "params": {
    "start": "YYYY-MM-01",
    "end": "YYYY-MM-DD",
    "sign": -1,
    "over": 1,
    "page": 1,
    "limit": 100
  }
}
```

- 地址默认是 `https://card.jwbpro.com/open/jwb/gateway`；原文档只列出 HTTP，不能用 HTTP 传输 `sk`。
- 成功条件固定为 `ret="1"`，逐学生明细固定从 `data.list` 读取。`ret` 失败、缺少 `data.list`、非对象记录、未结课或跨月记录都会停止导出，不会生成看似正常的空表。
- 网关按机构和工具限制 20 次/分钟；请求至少间隔 3.1 秒，GitHub 的月度任务也会串行执行。网页核对收到 `429` 会立即报错，不会在网页请求中长时间等待或产出部分数据；GitHub Actions 的非交互生成器会最多进行两次 61 秒以上的有界恢复重试。
- `query_schedule_list` 的 `data.lists/stu_list` 不能替代它：文档明确多人课没有完整学生明细。若 `sk` 没有 `query_lesson_list` 授权而只返回该形状，系统会明确拒绝。

仍需由管理端确认两项权限/事实：该 `sk` 已获 `query_lesson_list` 授权，以及日期筛选的 `end` 是否包含月末当天。`query_member_simple_list` 仅在使用学员核验时需要，`query_schedule_list` 仅在使用排课总览时需要。没有真实成功样例前，系统不会假装已拉到学校数据。

### 直接工具备用模式

只有供应商另行提供非网关的直接工具地址时才使用下列配置。生产环境 URL 必须为 HTTPS，且 URL 本身不能预先附带任何查询参数；额外参数的任意层级都不能出现 `start`、`end`、`sign`、`page`、`limit`、`over`、`mem_id`、`course_id` 或 `team_id`。

直接工具 JSON 请求示例：

```text
JIAOWUBAO_LESSON_LIST_URL=https://<供应商给出的地址>
JIAOWUBAO_LESSON_LIST_METHOD=POST
JIAOWUBAO_LESSON_LIST_AUTH_HEADER=Authorization
JIAOWUBAO_LESSON_LIST_AUTH_VALUE=<供应商给出的授权值>
```

在生产部署前，先保存一份供应商返回的成功、空页和错误响应样例。直接工具模式必须将真实成功标志写入 `JIAOWUBAO_LESSON_LIST_SUCCESS_PATH` 和 `JIAOWUBAO_LESSON_LIST_SUCCESS_VALUE`（例如响应 `{ "code": 0, "list": [] }` 应配置 `code` / `0`）。生产环境没有这项断言会拒绝运行，避免 HTTP 200 的错误包被误导出为“本月零课时”。

当前仍未提供以下信息，因此它们不会被虚构：

- 学校 `sk`、该 `sk` 的 `query_lesson_list` 授权，以及月末 `end` 日期的包含语义；
- 老师月度总课时；
- 主教、助教、第三教师各自的课时分配；
- B 试听账号到真实试听学生的权威映射（目前仅使用经会议确认的班级/课程名称前缀作待核对显示）。

## 工作台入口

- 「课时与薪资」默认选择上一个已结束的墨尔本月份；只允许补跑已经结束的历史月份。当前或未来月份会被拒绝，避免把未结月的局部资料叫作「完整版」。
- 选择月份后点击「同步已结课」：读取当前浏览器的只读核对结果，不覆盖既有共享/手工薪资记录。服务器同时返回一份签名、15 分钟有效的同源快照。该手工核对会完整分页，因此只适合能承受完整请求时长的运行环境；若运行时超时会安全失败，不会生成部分表。
- 「下载教务宝完整版」：只会使用这份刚核对的快照生成 `.xlsx`，不会再次读取教务宝，因此下载的文件与屏幕核对结果一致。切换月份或快照过期后必须重新同步。
- `POST /api/jiaowubao/monthly-payroll/sync`：需要工作台访问会话。
- `POST /api/jiaowubao/monthly-payroll/export`：需要工作台访问会话，并接收刚才同步返回的签名快照。
- `GET /api/jiaowubao/monthly-payroll/export?period=YYYY-MM`：只供受保护的自动任务 Bearer token 生成一次新的完整工作簿；浏览器下载只能使用上一项签名快照。
- `POST /api/cron/jiaowubao-monthly-payroll`：仅作受保护的连通性/摘要检查，不写入共享薪资，也不应用于自动下载。
- 「学员目录查询」使用 `POST /api/jiaowubao/members/sync`。必须填写学员关键词（至少两个字符）、教师 ID 或班级 ID；最多读取两页，结果过多会拒绝部分返回，且接口文档尚未给出成功响应字段样例，因此首份真实授权样例确认前不能把它作为试听或薪资映射依据。
- 「排课与时区检查」页面的「教务宝课节总览」使用 `POST /api/jiaowubao/schedule/sync`。它只接受 31 天以内的日期范围和可选 `over` 状态，最多读取两页；保留原始排课时间、教师课时与汇总考勤/消课统计。它绝不使用多人课不完整的 `stu_list`，也绝不写入本系统可编辑的排课记录。

## GitHub 月度自动任务

`.github/workflows/jiaowubao-monthly-payroll.yml` 在每月第一天后的安全时段运行，也可手动补跑。它在单一 GitHub Actions job 内直接调用同一套网关和工作簿生成代码，再立即上传该次结果。它是每月**正式完整版**的生成入口：完整月份即使需要 100+ 个限流分页请求，也不会受网站函数超时影响。

在 Vercel Production 环境配置下列应用变量：

- `JIAOWUBAO_GATEWAY_SK`：管理端分配并获 `query_lesson_list` 授权的密钥；如要启用学员核验/排课总览，还需分别获 `query_member_simple_list` / `query_schedule_list` 授权；
- `JIAOWUBAO_TRIAL_MEMBER_IDS`：经学校确认的三个试听 B 账号 ID；
- `JIAOWUBAO_MONTHLY_PAYROLL_CRON_SECRET`：至少 32 字符的随机值；仅保护可选的 Bearer 导出/诊断端点；
- `JIAOWUBAO_MONTHLY_PAYROLL_SNAPSHOT_SECRET`：至少 32 字符随机值；用于浏览器核对/下载同一快照。

在 GitHub 仓库中先创建名为 `jiaowubao-payroll` 的 **Environment**，限制可运行人和可读 Secrets 的成员，再在该 Environment 的 Actions secrets 中配置：

- `JIAOWUBAO_GATEWAY_SK`：与部署环境一致的网关密钥；
- `JIAOWUBAO_TRIAL_MEMBER_IDS`：与部署环境一致的三个试听 B 账号 ID；尚未确认时可留空，生成器会把全部课节标为待分类而不是猜测。

如果部署环境覆盖了默认网关地址或 `JIAOWUBAO_LESSON_LIST_MAX_PAGES`，也在该 Environment 的 Actions variables 中配置同名变量。自动任务不会调用部署后的网页端点，也不需要快照或 cron 密钥；它独占单个 GitHub job、启用有界 429 恢复重试，密钥不会写入日志或工作簿。

手动运行时可填写 `period`（`YYYY-MM`）；留空则导出按墨尔本时区计算的上一个完整月份。工作簿 artifact 默认保留 30 天。它含学生与出勤资料，仓库和 Actions 的访问权限必须仅限获授权人员；若需要更长期存档，应使用学校批准的受控存储。
