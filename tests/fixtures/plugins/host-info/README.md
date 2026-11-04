# Host Info（公开 SDK/UI 示例）

## 用途

本目录是开发验证夹具，保留用于协议、权限、生命周期或 UI 回归；不随产品预装，也不放在业务上传插件目录。

只依赖公开 SDK；WASM 通过受控 API 读取当前主机脱敏字段、执行只读 `uname -a`、读取/保存本插件的备注设置。五个 manifest 贡献无需修改主程序即可出现。

在仓库根目录执行 `node tools/build-plugin.mjs tests/fixtures/plugins/host-info .local/host-info.sdplugin`，桌面设置 → 插件管理预览安装并承认未验证开发来源。授予 hosts.read、ssh.execute（只读）与 ui.contribute；设置页另需 settings.read/write。启用后打开 Host Info，连接并核验 SSH 指纹，再执行诊断。

源码不是签名发行包；不申请文件写入权限，不获取凭据。卸载默认保留本插件设置。详细协议及限制参见 docs/plugins/PLUGIN_DEVELOPMENT.md。
