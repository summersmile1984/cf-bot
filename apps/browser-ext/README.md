# cf-bot 交办助手（浏览器扩展）

把当前网页 / 选中内容一键交给 cf-bot 秘书。Manifest V3，权限最小（`activeTab` + `contextMenus` + `storage`）。

## 工作方式

点工具栏按钮或右键「把这页发给秘书 / 把选中内容发给秘书」→ 扩展会打开你的秘书站点并**预填任务草稿**（含页面标题、URL、选中文本）→ 你确认或补一句要求后回车发送。

为什么是「打开站点预填」而不是扩展内直发：不引入任何新鉴权通道（无 token、无 CORS、无信任面扩张），复用你浏览器里已登录的会话。代价是多按一次回车。

## 安装

1. Chrome 打开 `chrome://extensions`，右上角开启「开发者模式」。
2. 「加载已解压的扩展程序」→ 选择本目录（`apps/browser-ext`）。
3. （可选）扩展「选项」里改秘书站点地址——自部署用户改成自己的域名。

## 打包分发

```
cd apps/browser-ext && zip -r cf-bot-ext.zip manifest.json background.js options.html options.js icons
```
