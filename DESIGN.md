# 吟领教务：现有设计系统

> 2026-08-27 从当前产品与代码提取。本文档描述现行系统；视觉调整应优先更新语义令牌和共享组件。

## Overview

这是一个高密度、浅色、以青绿色为品牌色的内部运营产品。设计目标是让长期使用者快速扫描数据、辨认状态并完成任务，而不是创造展示型视觉效果。

## Colors

- Brand: `#75c9c2`
- Brand deep / primary action: `#17645e`
- Brand ink / dark navigation: `#123f3b`
- Canvas: `#f3f7f5`
- Surface: `#ffffff`
- Subtle surface: `#f7faf9`
- Primary text: `#17241f`
- Secondary text: `#66776f`
- Divider: `#d9e5e0`
- Semantic accents: green、blue、amber、red、purple；必须同时配文字或图标。

## Typography

- 字体栈：系统无衬线中文字体；数据和时间可使用系统等宽字体。
- H1：24–26px，紧凑字距，单页一个。
- Section heading：14–16px。
- Body / control：13–14px。
- Metadata / table heading / status：12px 下限，1.4–1.5 行高。
- 数字列、日期、时间和金额使用 `tabular-nums`。
- 标题使用 `text-wrap: balance`，说明文字使用 `text-wrap: pretty`。

## Layout

- 桌面：固定侧栏 + 最大 1540px 内容区；高密度工作台使用主列表与固定详情栏。
- 761–1023px：80px 图标栏，内容不依赖 1120px 最小宽度。
- 手机：单列内容 + 底部主导航 + 全部功能抽屉；列表改为分隔式行，不在外层面板内重复卡片边框。
- 间距采用 4px 基础节奏，常用层级为 8 / 12 / 16 / 24 / 32px。

## Elevation & Depth

- 页面、面板、数据卡和行内控件不使用投影。
- 菜单使用轻量 raised shadow。
- Dialog、全局搜索和 Toast 使用浮层 shadow，并配 48% 左右 scrim。
- Sticky top bar 通过 1px 分隔线表达层级，不靠大阴影。

## Shapes

- Small control：8px。
- Panel：12px。
- Dialog / drawer：16px。
- Pill / avatar：999px / 50%。
- 嵌套关系遵循同心圆角：内层圆角小于外层；若 padding 不足，则使用分隔线而不是再包一张卡。

## Components

- Primary button：深青绿色实底，无渐变，无常驻阴影。
- Secondary button：白色实底 + 清晰边框。
- Icon button：桌面 40×40px，手机 44×44px，必须有可访问名称。
- Tabs / segmented controls：实色 active 状态，不使用浮起阴影。
- Collection rows：桌面和手机都以分隔线组织；选中状态使用浅品牌色 + 左侧强调线。
- Status pill：最小 12px 文字，颜色配合明确文字。
- Empty state：安静的浅色表面、事实说明和可选下一步，不使用装饰图案。
- Focus：所有交互控件使用清晰 `:focus-visible` ring。

## Motion

- UI transition：160ms；surface transition：200ms。
- 仅动画 `transform` 和 `opacity`，明确列出 transition 属性。
- 精细指针可使用 `scale(.98)` 按压反馈；触摸使用透明度反馈，不移动布局。
- `prefers-reduced-motion` 和个人 reduced motion 设置关闭非必要位移。

## Do’s and Don’ts

### Do

- 用清晰标题、分组、分隔线和留白建立层级。
- 保持高信息密度，同时保证 12px 元数据和 40/44px 点击区。
- 为 loading、empty、error、disabled、hover、focus 和 pressed 状态提供一致反馈。
- 用真实业务状态和明确下一步帮助用户恢复。

### Don’t

- 不使用默认渐变、玻璃光斑、卡片套卡片和装饰阴影。
- 不把每段文字都放进独立圆角方框。
- 不用 8–10px 正文或元数据压缩页面。
- 不使用 emoji 作为结构图标；沿用 Lucide 线性图标体系。
