import type { OperationalAuditRecord } from "@/lib/ops-store";

export type OperationalAuditEntry = Readonly<{
  id: string;
  time: string;
  actor: string;
  action: string;
  detail: string;
  tone: "neutral" | "blue" | "green" | "amber" | "red" | "purple";
}>;

const ENTITY_LABELS: Readonly<Record<string, string>> = {
  bookings: "排课",
  files: "资料",
  lpItems: "LP",
  messages: "消息",
  operations: "异常处理",
  payroll: "薪资",
  renewals: "续课",
  rules: "规则",
  students: "学生",
  tasks: "任务",
  teachers: "老师",
};

function actionLabel(action: string) {
  const generic = /^ops_state\.([A-Za-z][A-Za-z0-9]*)\.updated$/.exec(action);
  if (generic) return `更新${ENTITY_LABELS[generic[1]] ?? generic[1]}`;
  if (/\.completed$|\.complete$|\.settled$/.test(action)) return "完成业务操作";
  if (/\.created$|\.create$|\.submitted$|\.submit$/.test(action)) return "创建业务记录";
  if (/\.updated$|\.update$|\.reviewed$|\.review$/.test(action)) return "更新业务记录";
  if (/\.deleted$|\.delete$|\.cancelled$|\.cancel$/.test(action)) return "取消业务记录";
  return "服务器业务操作";
}

function actionTone(action: string): OperationalAuditEntry["tone"] {
  if (/delete|cancel|reject|abort|fail/i.test(action)) return "amber";
  if (/complete|settle|create|submit|approve/i.test(action)) return "green";
  if (/review|update|change|bind/i.test(action)) return "blue";
  return "neutral";
}

export function projectOperationalAuditEntry(record: OperationalAuditRecord): OperationalAuditEntry {
  return {
    id: `AUD-${record.id}`,
    time: record.created_at,
    actor: record.actor === "Nixon" ? "Admin" : record.actor,
    action: actionLabel(record.action),
    detail: `${record.target_type} · ${record.target_id} · ${record.action}`,
    tone: actionTone(record.action),
  };
}
