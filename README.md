# TeamLink 共创画布

[打开可直接编辑的作品](https://yaowenhu.cn/teamlink-demo/)

打开就是一个可运行的导出产品。点击界面上的文案直接改；修改数据、筛选和行为规则，同步看见请求、超时、重试与实际文件的变化。无需登录或安装。

这个版本把创作对象放到中心。没有提需、接单和验收的操作门槛；同一模型推导所有视图，修改结果不由流程次数或预设剧情决定。

## 可以亲手尝试

- 修改标题、说明、按钮文字与状态提示，直接看产品里的变化。
- 保留一份对照，再切换“超时后保留筛选”：默认例子的输出从10条变为原先选择的3条。
- 只改“重试使用第一次条件”：文件可以正确，界面却仍清空输入。这两个问题可以分别讨论。
- 把超时预算从800改为1080毫秒，观察首次请求在预算内完成，整个重试分支随之消失。
- 改表格内容、月份、分类或金额，实际下载CSV核对。所有耗时都来自明示且可修改的计算假设。
- 往返时间轨迹，撤销/重做，冻结对照；复制当前作品链接，让其他人打开后继续改副本。

公开入口二维码打开默认作品；“分享作品”链接包含当前文案、规则和数据。分享前请确认内容适合交给收件人。

![默认画布入口二维码](dist/assets/teamlink-qr.png)

## 它目前的边界

这是浏览器内的可执行产品模型，数据是虚构起点。没有真实网络导出服务、实时大模型或任意文字生成应用。修改会保存到本浏览器；链接/JSON携带可继续编辑的副本，不提供同一房间的实时多人同步。页面不上传编辑内容。

原先的顺序交接演示保留在Git历史；现行入口以共创画布为准。真实Codex＋飞书＋GitHub服务与这个公开产品模型分别维护。

## 本地运行

无需npm依赖，现代浏览器和Node.js即可：

```sh
python3 -m http.server 4328 --directory dist
node --test test/canvas-model.test.mjs
```

打开 http://localhost:4328 。设计与原则见 [PRINCIPLE_AND_SCOPE.md](docs/PRINCIPLE_AND_SCOPE.md)，操作和分享见 [EXPERIENCE.md](docs/EXPERIENCE.md)。

思路依据：Bret Victor 的 [Learnable Programming](https://worrydream.com/LearnableProgramming/)、[Explorable Explanations](https://worrydream.com/ExplorableExplanations/) 和 [Scrubbing Calculator](https://worrydream.com/ScrubbingCalculator/)。这里借鉴即时联系、可见过程与可质疑假设，不复用其程序代码。
