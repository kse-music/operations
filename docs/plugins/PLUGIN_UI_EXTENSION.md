# 插件 UI v4

UI v4必须携带独立Vue前端，Host API为5.0.0。`entry.ui`指向严格JSON，不接收插件HTML；`frontend.script/style`为包内平面ASCII文件名（≤80字节，以.js/.css结尾），长度及SHA256纳入files清单。

```json
{
  "uiVersion": 4,
  "frontend": { "script": "frontend.js", "style": "frontend.css" },
  "title": "自己的插件",
  "pages": [
    {
      "id": "host",
      "title": "巡检",
      "surface": { "kind": "frontend" },
      "initialAction": null,
      "fields": [],
      "actions": [{ "id": "inspect", "label": "巡检", "discardDirty": false, "enabledWhen": null }],
      "log": null
    }
  ]
}
```

manifest贡献ID对应页面ID；kind支持workspace、navigation、host_menu、command、settings、server。server/host_menu从明确主机打开；workspace可全局打开。可选`routes`声明本插件导航标识，最多32个、无重复合法标识符；SDK页面section/navigate事件只接受该贡献声明值，新增分类无需改宿主枚举。旧tool、operations/monitor标准视图被拒绝。

`main.ts`使用`mountPlugin(App)`。SDK注入page、hostId、initialSection、keepRunning等可信页面参数，推送公开context、主题、字号与visibility。组件通过`invoke(action, structuredInput)`调用本包WASM，动作必须在页面声明；业务输入不是JSON字符串或宿主票据。表单fields仍是可选schema元数据，不由宿主渲染业务页面。

iframe采用`sandbox="allow-scripts allow-forms"`且无allow-same-origin；Guest不能读取父DOM/Store或直接调用原生IPC。静态资源协议重新检查包/修订/授权/摘要，固定HTML壳及受限CSP禁止外网、远程脚本和动态资源。包内JS/CSS只在子页面运行。父桥验证实际窗口/null来源/协议后建立专属MessageChannel。

握手由 `mountPlugin` 管理：先注册消息监听，再向 parent 发送 `{kind:"serverdeck-sdk-ready",version:1}`；父桥验证实际 iframe 窗口及 null 来源后传递单个 MessagePort，SDK 仅接受 parent 发来的 `serverdeck-sdk-connect`，通过端口回复 `{kind:"connected"}`。父桥随后发送可信 context，SDK 才挂载业务组件。修改加载实现应同时验证真实宿主 PluginFrame 与打包 SDK，不能只用两端各自模拟的消息代替联通验证。仓库回归入口为 `node tools/plugin-handshake-e2e.mjs`，使用本地浏览器和包内 UI，不连接远端。

父桥只开放声明action及通用platform.request、connections.ensure、terminal.open、actions.cancel、workspace.draft、复制/通知/导出、平台模型设置导航及设置关闭。身份、owner、修订由父窗口注入，Guest自述确认/租约/管理命令均不可信。CLI安装/账号授权/模型编辑在平台设置完成。

隐藏页面停止新请求/审批、关闭流和PTY；已开始的保留动作可安全收尾，返回结果仍检查安装代及owner。页关闭拒绝所有pending并释放资源；其他页可继续。草稿用setDraftDirty报告，关闭所属工作区前提示；实际文档保存必须重新检查句柄、摘要与写入结果。

更多限额和示例见[SDK](PLUGIN_SDK.md)。Web UI没有独立OS进程或fuel配额，不能将iframe隔离视为无限资源保障；macOS/Linux原生行为仍须单独验收。
