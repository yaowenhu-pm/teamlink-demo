# TeamLink · 一起动手想

[共享风景入口](https://teamlink-handoff.yaowen-hu.chatgpt.site/) · [GitHub Pages 入口](https://yaowenhu.cn/teamlink-demo/)

直接拖动太阳、点击树木调整枝形，或者对风景说一句话。扫码后，手机与大屏连接同一个房间；修改由服务端保存，其他设备约每 1–2 秒轮询同步。无需安装或登录。

## 先试一次

1. 打开风景，拖动太阳，或观察并调整落叶轨迹。
2. 扫描风景旁默认展示的二维码，手机会进入当前房间；点击二维码可放大。
3. 在手机上说“下点小雨”或“树再多一些，风轻一点”，核对消息结果和大屏变化。
4. 使用撤销恢复最近一次场景修改。遇到版本冲突，先查看最新状态，再重新确认操作。

右侧提供真实参数、前后对比与渲染源码。编辑 JSON 参数会即时预览，点击“应用并同步”才提交到共享房间；取消可恢复。拖动太阳或调整树形也会更新同一份参数。渲染源码读取本站实际模块，只读展示；参数输入不执行 JavaScript。手机可展开代码，并在编辑区上方查看同参数的小预览。

对话通过 ClawHunt 接口调用豆包，默认模型为 `doubao-seed-2.1-lite`。模型提出参数修改，服务器校验字段、范围和当前版本后才应用。当前支持时间、树木、花朵、风雨、树枝形态、帆船及场景排列；不会任意生成或执行代码。未配置模型时明确显示有限调景指令模式。

## 数据与共享边界

- **发送对话时，当前这条消息和当前场景参数会经服务器发送到 ClawHunt，由其提供豆包解释服务。** 房间场景、消息和撤销快照保存在 Cloudflare D1，持有编辑链接的人可以读取和修改。
- 房间链接包含随机访问凭证，有效期 6 小时；过期后拒绝读写，过期记录随后有界清理。链接代表访问能力，消息不代表经过认证的成员身份。
- 每房间最多 64 条操作、20 次模型请求；全站每天最多 200 次模型请求。失败调用也可能占用额度。同一请求编号重放不会重复调用模型，冲突不会静默覆盖其他端的修改。
- 演示从独立的虚构风景开始，不接入私人 `team-relay` 数据、个人 Codex、真实飞书或 GitHub 写入。请使用适合房间参与者和第三方服务接收的内容。
- `CLAW_API_KEY` 和 `ROOM_IP_SALT` 仅由维护者配置在服务端。创建限流保存按小时加盐的 IP 摘要，不保存原始 IP；密钥不得放入网页、二维码、源码或导出文件。

原官网和导出工作区保留在 `/legacy/`、`/legacy/app/`。旧作品链接与原本浏览器存储继续兼容；历史导出工作区使用副本分享，与当前共享房间的同步机制不同。

## 本地开发

使用 Node.js 24 和 npm。维护者先配置未跟踪的本地服务端环境键：`CLAW_API_KEY`、`ROOM_IP_SALT`；模型可选项为 `CLAW_MODEL`，接口地址限制为 ClawHunt。

```sh
npm ci
npm test
npm run build
npx wrangler d1 migrations apply DB --local --config wrangler.json
npm run preview
```

打开 [本地预览](http://localhost:4328)。本地 D1 与托管 D1 分离。公共源码不携带私有 Sites 项目身份；本地构建无需 `project_id`，发布自己的站点时按 `.openai/hosting.example.json` 配置自己的项目身份。

- `web/`：风景页面、交互、绘制与场景模型；`web/legacy/` 保留历史体验。
- `worker/`：同源资源与房间 API、ClawHunt 适配器。
- `db/schema.ts`、`drizzle/`：D1 表结构与版本化迁移；改结构后运行 `npm run db:generate`。
- `dist/`：构建生成的 Worker、内嵌前端与 `.openai/drizzle` 迁移产物，不是手写源码目录。

CI 检查语法、全部模型/房间/适配器测试及构建，不需要真实密钥、不调用真实模型或执行部署。实际线上模型连接、实体扫码和手机双端 UI 仍需发布后分别验收；自动检查不代表这些链路已通过。

直接操作和可见过程参考 Bret Victor 的 [Inventing on Principle](https://worrydream.com/InventingOnPrinciple/)、[Learnable Programming](https://worrydream.com/LearnableProgramming/) 与 [Explorable Explanations](https://worrydream.com/ExplorableExplanations/)。
