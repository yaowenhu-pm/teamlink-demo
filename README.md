# TeamLink 公开体验

打开网页，亲手走一遍需求确认、研发接单、交付、具体退回和逐项验收。访客无需安装 Codex、登录或配置账号。

这是使用虚构人物和独立样例的可交互演示：按确定规则运行，不调用实时大模型，不执行真实研发代码，不读写真实飞书或 GitHub。小林与小周分别是产品、研发的演示角色，一人可以切换体验双方。

## 打开与分享

网页、二维码和GitHub首页指向同一个公开体验入口。

| 入口 | 地址 |
| --- | --- |
| 网页 / 二维码 | [teamlink-handoff.yaowen-hu.chatgpt.site](https://teamlink-handoff.yaowen-hu.chatgpt.site) |
| 公开源码 | [yaowenhu-pm/teamlink-demo](https://github.com/yaowenhu-pm/teamlink-demo) |

网页、二维码和 GitHub README 指向同一个体验地址。分享入口不会附带你的输入或演示进度。

![TeamLink公开体验二维码](dist/assets/teamlink-qr.png)

## 建议这样体验

1. 选择“导出失败重试”，点击“整理交接单”，核对并修改完成标准后确认交接。
2. 切换到虚构研发小周，接下当前版本，查看检查样例并明确提交交付。检查通过不会自动验收。
3. 在“体验功能”中操作小样例：记住筛选条件，触发首次导出超时，观察条件被清空的问题。
4. 具体退回相应验收项，再以研发视角补交，重新体验并逐项记录演示验收结果。

也可选择“登录后回原页”，体验取消登录返回错误位置的首轮样例。“写自己的需求”允许编辑交接内容与标准，但不会按输入生成应用或代码。

输入与进度只保存在当前标签页的 `sessionStorage`，不上传；刷新可恢复任务进度，跨标签页、浏览器或设备不会自动同步。“重新体验”会重置当前演示。示例 CSV 由浏览器生成，包含虚构样例数据，不包含你的需求输入。

## 本地预览与验证

维护者在项目目录运行，无需安装 npm 依赖：

```sh
python3 -m http.server 4328 --directory dist
```

打开 [本地预览](http://localhost:4328)。浏览器需支持 JavaScript 与原生 ES Modules；请通过 HTTP 预览，避免直接双击 HTML。

状态规则测试使用现代 Node.js：

```sh
node --test
```

测试验证版本、角色、交付、退回、验收及存档恢复；实际页面操作与手机布局仍需浏览器检查。完整体验说明见 [docs/EXPERIENCE.md](docs/EXPERIENCE.md)。
