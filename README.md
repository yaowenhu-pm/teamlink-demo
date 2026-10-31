# TeamLink 共创工作区

[打开体验](https://yaowenhu.cn/teamlink-demo/) · 无需登录，打开即可修改。

围绕一个正在运行的产品原型，直接改内容、数据和行为规则，看见结果；保存不同方案，给具体版本留下批注，再把问题交给自己的 Codex。收到提案后先查看差异与计算影响，再决定采纳。

## 先试一次

1. 打开“作品与规则”，切换“超时以后，保留选好的筛选条件”。默认例子的文件从 10 条变为最初选中的 3 条，结果在作品旁边更新。
2. 在右侧给方案命名并保存。继续修改后，可选一个保存的版本作对照或恢复；恢复也可撤销。
3. 在“批注”中选择内容、规则、数据或判断期望，记录问题；批注保存当时的作品快照。
4. 在“Agent 交接”里写明确问题，复制任务给自己的 Codex，或下载任务 JSON。网页不自动启动 Agent。
5. 把 Codex 返回的 JSON 提案粘贴或导入，检查字段差异与结果，再点击采纳。若当前作品已经改变，旧提案不能覆盖它，应基于新版本重新委托。

“分享作品”生成一份可继续编辑的副本链接。“导出项目”包含作品、命名方案、批注和本地活动，可通过已有飞书会话或 GitHub 附件异步传递；收件人导入后继续工作。

## 当前能力与边界

| 已实现 | 使用边界 |
| --- | --- |
| 内容、数据、规则直接修改；请求、轨迹、CSV同源计算 | 这是有明确字段的导出产品模型，不能生成任意应用，也不连接真实导出服务 |
| 命名快照、版本对照、撤销/重做 | 保存在浏览器，最多12个命名版本 |
| 关联批注与当时快照 | 署名自行填写，不代表已认证的团队成员；最多30条批注 |
| 外部 Agent 任务包、提案预览、完整基准版本冲突拦截 | 没有内置大模型、后台执行或自动判定验收；提案作者与说明未经身份验证 |
| 作品副本链接、完整项目包导入导出 | 异步副本协作，没有实时共享房间、自动合并或飞书／GitHub自动写入 |

体验起点使用虚构数据。页面不上传编辑内容，没有埋点或第三方运行依赖。分享链接和项目包可携带编辑内容，请自行选择适合接收人的版本。真实团队的 Codex＋飞书＋GitHub服务与公开工作区分别维护。

![默认体验入口二维码](dist/assets/teamlink-qr.png)

## 本地运行

无需安装依赖，现代浏览器和 Node.js 即可：

```sh
python3 -m http.server 4328 --directory dist
node --test test/canvas-model.test.mjs test/collaboration-model.test.mjs
```

打开 http://localhost:4328 。

- [使用与交接](docs/EXPERIENCE.md)
- [GatherThread 对照和优化决策](docs/GATHERTHREAD_REVIEW.md)
- [验证记录](docs/VERIFICATION.md)
- [设计原则](docs/PRINCIPLE_AND_SCOPE.md)

本次借鉴 GatherThread 的项目语境、显式委托和版本审阅方式，未复制其代码或素材。直接操作原则参考 Bret Victor 的 [Learnable Programming](https://worrydream.com/LearnableProgramming/) 与 [Explorable Explanations](https://worrydream.com/ExplorableExplanations/)。
