import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultDisplayPreferences,
  displayTerm,
  displayPreferencesStorageKey,
  displayTimezoneOptions,
  parseDisplayPreferences,
  timezoneLabelFor,
} from "../lib/display-preferences";
import { translateInterfaceText } from "../lib/interface-localization";

test("uses an English-friendly default for teacher accounts without changing the administrator default", () => {
  assert.equal(defaultDisplayPreferences(true).language, "en-AU");
  assert.equal(defaultDisplayPreferences(false).language, "zh-CN");
  assert.equal(defaultDisplayPreferences(true).timezone, "Australia/Melbourne");
});

test("keeps only supported display preference values", () => {
  const fallback = defaultDisplayPreferences(false);
  const parsed = parseDisplayPreferences(JSON.stringify({
    language: "en-AU",
    textSize: "extra-large",
    timeFormat: "12h",
    dateFormat: "ymd",
    timezone: "Australia/Adelaide",
    density: "compact",
    motion: "reduced",
  }), fallback);

  assert.deepEqual(parsed, {
    language: "en-AU",
    textSize: "extra-large",
    timeFormat: "12h",
    dateFormat: "ymd",
    timezone: "Australia/Adelaide",
    density: "compact",
    motion: "reduced",
  });

  assert.deepEqual(parseDisplayPreferences({ timezone: "Not/A-Real-Timezone", language: "unsupported" }, fallback), fallback);
});

test("partitions browser display preferences by login account", () => {
  assert.notEqual(displayPreferencesStorageKey("Helen Ceperkovic"), displayPreferencesStorageKey("Anna Zhang"));
  assert.equal(displayPreferencesStorageKey("  Helen Ceperkovic  "), displayPreferencesStorageKey("helen ceperkovic"));
  assert.equal(timezoneLabelFor("Australia/Melbourne", "en-AU"), "Melbourne");
  assert.equal(timezoneLabelFor("Australia/Melbourne", "zh-CN"), "墨尔本");
  assert.ok(displayTimezoneOptions.some((option) => option.id === "Pacific/Auckland"));
  assert.ok(displayTimezoneOptions.some((option) => option.id === "America/Argentina/Buenos_Aires"));
  assert.ok(displayTimezoneOptions.some((option) => option.id === "Europe/Sarajevo"));
  assert.equal(new Set(displayTimezoneOptions.map((option) => option.id)).size, displayTimezoneOptions.length);
  assert.equal(timezoneLabelFor("Asia/Shanghai", "zh-CN"), "北京时间（中国）");
  assert.equal(timezoneLabelFor("Australia/Sydney", "zh-CN"), "悉尼");
  assert.equal(timezoneLabelFor("Australia/Sydney", "en-AU"), "Sydney");
  assert.equal(timezoneLabelFor("Australia/Canberra", "zh-CN"), "堪培拉");
  assert.equal(timezoneLabelFor("Australia/Canberra", "en-AU"), "Canberra");
  assert.equal(displayTerm("在读 + 加课待排", "en-AU"), "Active · additional lessons pending");
});

test("translates shared controls and schedule details without changing names", () => {
  assert.equal(translateInterfaceText("排课与时区检查", "en-AU"), "Schedule and timezone checks");
  assert.equal(translateInterfaceText("导出本月 Excel", "en-AU"), "Export monthly Excel");
  assert.equal(
    translateInterfaceText("当前显示 2026-07 薪资。系统保留每位老师的学生明细、课时费、教务宝匹配差异和人工锁定记录。", "en-AU"),
    "Currently showing 2026-07 payroll. Student details, lesson rates, Jiaowubao matching differences and manual locks are retained for each teacher.",
  );
  assert.equal(translateInterfaceText("关闭课程详情", "en-AU"), "Close lesson details");
  assert.equal(translateInterfaceText(" 查看排课\n", "en-AU"), " View schedule\n");
  assert.equal(
    translateInterfaceText("\n  当前只记录发送意图，未连接企业微信\n API。\n", "en-AU"),
    "\n  The system currently records sending intent only; the WeCom API is not connected.\n",
  );
  assert.equal(translateInterfaceText("第 2 / 7 页", "en-AU"), "Page 2 of 7");
  assert.equal(translateInterfaceText("与 Olivia Chen 的匹配度", "en-AU"), "Match with Olivia Chen");
  assert.equal(translateInterfaceText("当前账号无权访问这节课。", "en-AU"), "This account cannot access this lesson.");
  assert.equal(translateInterfaceText("Olivia 陈欣兰", "en-AU"), "Olivia 陈欣兰");
  assert.equal(translateInterfaceText("排课与时区检查", "zh-CN"), "排课与时区检查");
});

test("translates runtime-composed records and standardised source labels", () => {
  assert.equal(translateInterfaceText("2026年7月30日星期四", "en-AU"), "Thursday, 30 July 2026");
  assert.equal(
    translateInterfaceText("Ella 的个人工作视图 · 所有提醒都指向学生、触发原因、负责人和下一步动作。当前使用：Supabase 真实资料快照。", "en-AU"),
    "Ella's personal workspace · Every reminder includes the student, trigger, owner and next action. Current source: Supabase live-data snapshot.",
  );
  assert.equal(translateInterfaceText("今天到期 2 项", "en-AU"), "2 due today");
  assert.equal(translateInterfaceText("今天 21:11", "en-AU"), "Today 21:11");
  assert.equal(translateInterfaceText("Ella 负责", "en-AU"), "Assigned to Ella");
  assert.equal(translateInterfaceText("Ella 的任务", "en-AU"), "Ella's tasks");
  assert.equal(translateInterfaceText("试听 LP：需要跟进家长指定内容", "en-AU"), "Trial LP: Follow up parent-requested content");
  assert.equal(translateInterfaceText("Jared陈汶杰 仅剩 3 课时", "en-AU"), "Jared陈汶杰 has only 3 hours remaining");
  assert.equal(translateInterfaceText("198 位老师的 AVA 待结构化", "en-AU"), "198 teachers have unstructured availability");
  assert.equal(translateInterfaceText("1997 门在用课程", "en-AU"), "1997 active courses");
  assert.equal(translateInterfaceText("0 项资料", "en-AU"), "0 files");
  assert.equal(translateInterfaceText("0/4 节", "en-AU"), "0/4 lessons");
  assert.equal(translateInterfaceText("5月", "en-AU"), "May");
  assert.equal(translateInterfaceText("已结构化 · 手动结构化 · 今天 16:59", "en-AU"), "Structured · Manually structured · Today 16:59");
  assert.equal(translateInterfaceText("手动结构化 · 今天 16:59", "en-AU"), "Manually structured · Today 16:59");
  assert.equal(translateInterfaceText("上次成功 No successful follow-up recorded", "en-AU"), "Last successful follow-up: No successful follow-up recorded");
  assert.equal(
    translateInterfaceText("Source:手动结构化 · 今天 16:59 · Original timezone 墨尔本", "en-AU"),
    "Source: Manually structured · Today 16:59 · Original timezone: Melbourne",
  );
  assert.equal(translateInterfaceText("数学 · 科学 · 中小学/大学", "en-AU"), "Mathematics · Science · School / university");
  assert.equal(translateInterfaceText("STU-R0167 · 五年级 · Subject to be confirmed", "en-AU"), "STU-R0167 · Year 5 · Subject to be confirmed");
  assert.equal(translateInterfaceText("Plan: Eileen校长号", "en-AU"), "Plan: Eileen principal account");
  assert.equal(translateInterfaceText("墨尔本", "en-AU"), "Melbourne");
  assert.equal(translateInterfaceText("沟通对象待关联", "en-AU"), "Communication contact pending");
  assert.equal(translateInterfaceText("在线教室服务请求失败（502）。", "en-AU"), "The online classroom service request failed (502).");
  assert.equal(translateInterfaceText("当前账号只能修改已分配的资料记录。", "en-AU"), "This account can modify assigned records only.");
  assert.equal(
    translateInterfaceText("剩余课时低于 5 的在读/待续课学生进入强提醒；停课、非在读与不活跃学生自动排除。考试在提前 30 天和考试当天提醒负责教务。", "en-AU"),
    "Active and renewal-due students with fewer than 5 hours enter priority reminders; paused and inactive students are excluded. Operations is reminded 30 days before and on the exam day.",
  );
});
