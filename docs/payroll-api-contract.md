# 教务宝课时与薪资 API 接入契约

## 目标

薪资核对以 **老师月度总课时** 为唯一薪资核算口径；学生课程明细用于解释和核对，不能反向覆盖或归零老师总课时。

## 数据来源与优先级

| 数据 | API 来源 | 用途 | 规则 |
| --- | --- | --- | --- |
| 老师总课时 | 教务宝老师月度汇总 | 薪资核算、差额基准 | 必须保留原始值 |
| 课程/签到明细 | 教务宝课程记录 | 对应老师、学生和实际上课时数 | 每条保留课程 ID、日期和签到状态 |
| 学生档案 | 教务宝学生列表 | 将课程中的学生名称映射为站内学生 | 名称无法映射时保留原名称并标记待确认 |
| 试听标记 | 课程类型或学生状态 | 单独显示试听课时 | 试听必须纳入总课时核对，不能省略 |
| 薪资费率 | 站内已确认规则 | 生成建议薪资 | 仅在人工确认后用于锁定 |

## 推荐输入格式

适配器应按月输出一个 JSON 对象。所有课时均为数值小时，允许 `0.5` 等小数。

```json
{
  "period": "2026-08",
  "source": "jiaowubao",
  "importedAt": "2026-09-02T10:00:00+10:00",
  "teachers": [
    {
      "sourceTeacherId": "jwb-teacher-123",
      "teacherName": "老师姓名",
      "totalHours": 91.5,
      "trialHours": 3,
      "lessonDetails": [
        {
          "sourceLessonId": "jwb-lesson-456",
          "studentSourceId": "jwb-student-789",
          "studentName": "学生姓名",
          "hours": 1,
          "lessonType": "regular",
          "attendance": "attended",
          "occurredAt": "2026-08-05T19:00:00+10:00"
        }
      ]
    }
  ]
}
```

## 站内输出与核对规则

每位老师输出以下可审计字段：

| 字段 | 计算/来源 | 含义 |
| --- | --- | --- |
| `teacherTotalHours` | `totalHours` | 教务宝老师月度总课时，权威基准 |
| `trialHours` | 汇总或课程明细 | 已纳入总课时的试听部分 |
| `matchedStudentHours` | 可读取且可识别的课程明细合计 | 当前已列出学生的课时 |
| `unreconciledHours` | `teacherTotalHours - matchedStudentHours` | 仍待补齐或核对的差额 |
| `studentDetails` | `lessonDetails` 聚合 | 按学生、课程类型列出的明细 |
| `reconciliationStatus` | 差额和映射结果 | `needs_details`、`ready_for_review` 或 `locked` |

锁定条件：`unreconciledHours === 0`，且所有学生名称/试听标记已确认。API 缺少明细、学生名称无法匹配、老师有总课时但没有学生行时，状态必须为 `needs_details`；不可自动归零、不可自动锁定。

## 接入边界

- 适配器只读取教务宝 API；不向教务宝回写或删除资料。
- 原始 API 响应、来源 ID、导入时间和映射失败原因应可追溯。
- API 凭据只保存在部署环境变量中，不写入浏览器、源码或导入文件。
- 进入生产前需用一个完整月份做三项验收：老师总课时合计、试听课时合计、按老师的未核对差额。
