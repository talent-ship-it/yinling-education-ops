# 吟领教务：课程优先的工作区

对象是每天安排跨时区课程、跟进学生和老师的教务团队。这是 React 网页，采用 Apple HIG 的可读性、层级、反馈和适应性原则，不模拟原生窗口和菜单栏。

## 审查与方向

- High：同步课表置于主课表上方，长列表推走当前任务。主课表先出现，同步资料随后呈现且分页。
- Critical：全部课程同时渲染，反复创建 Intl 格式器，点击阻塞主线程。先修性能再做视觉。
- Medium：导航、表格、弹窗的视觉语言分散。采用统一的浅色工作区、墨色文字、吟领青绿动作色；系统字体承载中文与英文。
- 保留：角色范围、课程稳定身份、学生颜色关联、键盘焦点、按需详情与移动端入口。

依据（已读取的 skill 参考文件）：layout.md › Visual hierarchy（“Make controls easier to use”）；typography.md › Ensuring legibility（“Use font sizes that most people can read easily”）；loading.md › Showing progress；sidebars.md › Best practices；buttons.md › Style；lists-and-tables.md › Content；accessibility.md › Vision；color.md › Best practices；motion.md › Best practices。具体网页布局是设计判断。

## Tokens 与布局

|角色|浅色|深色|
|---|---|---|
|底色|#f5f5f7|#111315|
|内容表面|#ffffff|#1c2023|
|主文字|#1d2529|#f3f5f7|
|次文字|#59656e|#b4bfc8|
|动作|#12675f|#85d4c8|
|危险|#b42332|#ffacb5|

字阶：页标题 28px/600、分区 17px/600、正文 14px、辅助 12px；手机表单 16px。系统 UI 字体，日期和数据用等宽数字；不加载装饰字体。

宽屏：导航 | 当前页面标题与操作 / 课程或列表 | 按需详情。
窄屏：页面标题 / 筛选 / 内容 / 底部导航，详情为可关闭面板。

```
桌面  [ 导航 ][ 标题                         新建 ]
             [ 日期 / 搜索 / 筛选                 ]
             [ 课表或记录列表          ][ 详情    ]
手机  [ 标题                 操作 ]
      [ 可换行筛选               ]
      [ 课程列表 / 可滚动月历     ]
      [ 工作台 学生 排课 更多     ]
```

辨识点是“学生持续拥有同一种课程色”的跨时区课表；环境保持安静。统一外壳不是另一套通用展示卡片模板：工作记录占据中心，减少无用 eyebrow 和装饰背景。频繁操作不做入场动画；只保留短暂的按压与焦点反馈。支持系统深色、高对比、减少动态效果、减少透明度和窄屏。

## 对比度验证

- #1d2529 / #ffffff: 15.57:1
- #59656e / #ffffff: 5.98:1
- #12675f / #ffffff: 6.71:1
- #f3f5f7 / #1c2023: 15.01:1
- #b4bfc8 / #1c2023: 8.77:1
- #85d4c8 / #1c2023: 9.57:1
