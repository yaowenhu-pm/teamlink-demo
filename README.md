# TeamLink

一片可以一起修改的风景。拖动对象、画出落叶路线，或说一句话，让想法变成眼前的变化。

**[在线体验](https://teamlink.yaowenhu.cn/) · [手势实验](https://teamlink.yaowenhu.cn/gesture/)**

## 三步体验

无需安装或登录。

1. 打开网页，拖动太阳，或点击“画落叶路线”画一笔，松手保存。
2. 扫描画布旁的二维码，用手机进入同一个房间。
3. 输入“增加两艘船，下点小雨”，同伴的页面会同步变化。

还支持对象复制与删除、参数与源码对照、撤销、恢复默认、全屏和背景音乐。画布内按 `?` 查看快捷键。

## 手势实验

推荐电脑 Chrome 或 Edge。选择太阳或帆船，开启摄像头并允许权限：先张开手，再捏合拇指和食指移动，松开确认。按 `1 / 2` 切换控制对象。

首次可能下载约 10 MB 识别文件，之后通常复用本机缓存；每次仍需初始化识别。相机画面只在本机处理，不上传。手势页独立运行，修改只在本机生效。

## 本地运行

需要 Node.js 24 和 npm，在项目目录执行：

```sh
npm ci
npm run build

PUBLIC_ORIGIN=http://127.0.0.1:4328 \
DATABASE_PATH=/tmp/teamlink-local.sqlite \
ROOM_IP_SALT=local-demo-only-change-for-deploy \
PORT=4328 npm run preview
```

打开 <http://127.0.0.1:4328>。以上配置仅供本地开发；运行测试使用 `npm test`。

豆包对话需在启动前设置服务端环境变量 `CLAW_API_KEY`；未设置时可手动编辑和使用基础调景指令。部署与环境配置见[部署说明](deploy/README.md)。

## 使用说明

- 共创房间约每 1–2 秒同步，链接有效 6 小时；持有链接的人可以读取和修改房间。
- 共创风景及消息保存在服务端。发送对话时，当前消息和场景参数会经 ClawHunt 发送给豆包；请使用演示内容。
- 对话用于调整已有的风景元素。本项目使用独立演示数据，未接入真实团队资料。

更多细节：[验证记录](docs/VERIFICATION.md) · [识别依赖与许可](web/vendor/hand-vision/manifest.json)

灵感来自 Bret Victor 的 [Inventing on Principle](https://worrydream.com/InventingOnPrinciple/)：让创作者与正在创造的东西建立即时联系。
