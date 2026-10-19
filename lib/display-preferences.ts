import type { DemoSessionRole } from "./demo-session-token";
import { resolveAssignableOperationsOwner } from "./demo-users";

export type InterfaceLanguage = "zh-CN" | "en-AU";
export type TextSize = "default" | "large" | "extra-large";
export type TimeFormat = "24h" | "12h";
export type DateFormat = "dmy" | "ymd";
export type ListDensity = "comfortable" | "compact";
export type MotionPreference = "standard" | "reduced";

export type DisplayPreferences = {
  language: InterfaceLanguage;
  textSize: TextSize;
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  timezone: string;
  density: ListDensity;
  motion: MotionPreference;
};

export const displayTimezoneOptions = [
  { id: "Australia/Melbourne", zh: "墨尔本", en: "Melbourne" },
  { id: "Australia/Adelaide", zh: "阿德莱德", en: "Adelaide" },
  { id: "Australia/Sydney", zh: "悉尼", en: "Sydney" },
  { id: "Australia/Canberra", zh: "堪培拉", en: "Canberra" },
  { id: "Australia/Hobart", zh: "霍巴特", en: "Hobart" },
  { id: "Australia/Brisbane", zh: "布里斯班", en: "Brisbane" },
  { id: "Australia/Perth", zh: "珀斯", en: "Perth" },
  { id: "Pacific/Auckland", zh: "新西兰", en: "New Zealand" },
  { id: "Asia/Shanghai", zh: "北京时间（中国）", en: "Beijing time (China)" },
  { id: "America/Argentina/Buenos_Aires", zh: "阿根廷", en: "Argentina" },
  { id: "Europe/Sarajevo", zh: "波斯尼亚", en: "Bosnia" },
] as const;

const validTimezones = new Set<string>(displayTimezoneOptions.map((option) => option.id));

const displayPreferenceKeys = {
  language: new Set<InterfaceLanguage>(["zh-CN", "en-AU"]),
  textSize: new Set<TextSize>(["default", "large", "extra-large"]),
  timeFormat: new Set<TimeFormat>(["24h", "12h"]),
  dateFormat: new Set<DateFormat>(["dmy", "ymd"]),
  density: new Set<ListDensity>(["comfortable", "compact"]),
  motion: new Set<MotionPreference>(["standard", "reduced"]),
};

export function defaultDisplayPreferences(preferEnglish = false): DisplayPreferences {
  return {
    language: preferEnglish ? "en-AU" : "zh-CN",
    textSize: "default",
    timeFormat: "24h",
    dateFormat: "dmy",
    timezone: "Australia/Melbourne",
    density: "comfortable",
    motion: "standard",
  };
}

export function defaultAccountDisplayPreferences(user: string, role: DemoSessionRole): DisplayPreferences {
  const preferences = defaultDisplayPreferences(role === "teacher");
  if (role === "staff" && resolveAssignableOperationsOwner(user)) preferences.timezone = "Asia/Shanghai";
  return preferences;
}

export function readAccountDisplayPreferences(user: string, role: DemoSessionRole, read: (key: string) => string | null) {
  const fallback = defaultAccountDisplayPreferences(user, role);
  try {
    return parseDisplayPreferences(read(displayPreferencesStorageKey(user)), fallback);
  } catch {
    return fallback;
  }
}

export function parseDisplayPreferences(value: unknown, fallback: DisplayPreferences): DisplayPreferences {
  let candidate: unknown = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return fallback;

  const source = candidate as Partial<DisplayPreferences>;
  return {
    language: displayPreferenceKeys.language.has(source.language as InterfaceLanguage) ? source.language as InterfaceLanguage : fallback.language,
    textSize: displayPreferenceKeys.textSize.has(source.textSize as TextSize) ? source.textSize as TextSize : fallback.textSize,
    timeFormat: displayPreferenceKeys.timeFormat.has(source.timeFormat as TimeFormat) ? source.timeFormat as TimeFormat : fallback.timeFormat,
    dateFormat: displayPreferenceKeys.dateFormat.has(source.dateFormat as DateFormat) ? source.dateFormat as DateFormat : fallback.dateFormat,
    timezone: validTimezones.has(source.timezone ?? "") ? source.timezone! : fallback.timezone,
    density: displayPreferenceKeys.density.has(source.density as ListDensity) ? source.density as ListDensity : fallback.density,
    motion: displayPreferenceKeys.motion.has(source.motion as MotionPreference) ? source.motion as MotionPreference : fallback.motion,
  };
}

export function displayPreferencesStorageKey(user: string) {
  return `yinling:display-preferences:v1:${user.trim().toLocaleLowerCase() || "guest"}`;
}

export function localeFor(language: InterfaceLanguage) {
  return language === "en-AU" ? "en-AU" : "zh-CN";
}

export function timezoneLabelFor(timezone: string, language: InterfaceLanguage) {
  const option = displayTimezoneOptions.find((item) => item.id === timezone);
  if (!option) return timezone;
  return language === "en-AU" ? option.en : option.zh;
}

const englishTerms: Record<string, string> = {
  "工作台": "Workspace",
  "学生档案": "Students",
  "老师资源": "Teachers",
  "排课": "Schedule",
  "网上教室": "Online classroom",
  "课程与课包": "Courses & packages",
  "试听与 LP": "Trials & LP",
  "调课与代课": "Changes & cover",
  "考试与续课": "Exams & renewals",
  "课时与薪资": "Hours & payroll",
  "消息队列": "Messages",
  "文件中心": "Files",
  "同步与导入": "Sync & import",
  "运营报表": "Reports",
  "规则设置": "Rules",
  "账号与权限": "Accounts & permissions",
  "操作审计": "Audit log",
  "学生与教务": "Students & operations",
  "运营与系统": "Operations & system",
  "待确认": "Pending confirmation",
  "待排课": "Awaiting schedule",
  "试听中": "Trial",
  "在读": "Active",
  "不活跃 + 无课时": "Inactive · no hours",
  "活跃 + 无课时": "Active · no hours",
  "活跃 + 有课时": "Active · has hours",
  "不活跃 + 有课时": "Inactive · has hours",
  "在读 + 加课待排": "Active · additional lessons pending",
  "待续课": "Renewal due",
  "停课": "Paused",
  "非在读": "Inactive",
  "不活跃": "Inactive",
  "已报名": "Enrolled",
  "试听": "Trial",
  "已确认": "Confirmed",
  "已完成": "Completed",
  "常规课": "Regular lesson",
  "待匹配": "Awaiting match",
  "待导入": "Awaiting import",
  "待分配": "Unassigned",
  "未记录": "Not recorded",
  "未设置": "Not set",
  "待处理": "To do",
};

export function displayTerm(value: string, language: InterfaceLanguage) {
  return language === "en-AU" ? englishTerms[value] ?? value : value;
}

export const interfaceCopy = {
  "zh-CN": {
    profilePreferences: "显示偏好",
    profilePreferencesDetail: "只影响当前账号在此浏览器中的显示，不会改变其他人的界面或业务权限。",
    language: "界面语言",
    textSize: "文字大小",
    timezone: "默认显示时区",
    timeFormat: "时间格式",
    dateFormat: "日期格式",
    density: "列表密度",
    motion: "界面动画",
    reset: "恢复默认",
    close: "关闭",
    chinese: "中文（简体）",
    english: "English",
    normal: "标准",
    large: "较大",
    extraLarge: "最大",
    comfortable: "舒适",
    compact: "紧凑",
    standardMotion: "标准",
    reducedMotion: "减少动画",
    currentView: "当前工作视图",
    switchView: "切换工作身份",
    switchDetail: "不同身份看到不同的工作范围",
    logOut: "退出登录",
    syncing: "保存中",
    synced: "已同步",
    conflict: "有冲突",
    offline: "离线",
    search: "搜索学生、老师或课程",
  },
  "en-AU": {
    profilePreferences: "Display preferences",
    profilePreferencesDetail: "Saved for this account in this browser only. It does not change anyone else's view or business permissions.",
    language: "Interface language",
    textSize: "Text size",
    timezone: "Default display timezone",
    timeFormat: "Time format",
    dateFormat: "Date format",
    density: "List density",
    motion: "Interface motion",
    reset: "Restore defaults",
    close: "Close",
    chinese: "Chinese (Simplified)",
    english: "English",
    normal: "Standard",
    large: "Large",
    extraLarge: "Extra large",
    comfortable: "Comfortable",
    compact: "Compact",
    standardMotion: "Standard",
    reducedMotion: "Reduce motion",
    currentView: "Current workspace view",
    switchView: "Switch work view",
    switchDetail: "Each view shows the work scope for that role.",
    logOut: "Log out",
    syncing: "Saving",
    synced: "Synced",
    conflict: "Conflict",
    offline: "Offline",
    search: "Search students, teachers or courses",
  },
} as const;
