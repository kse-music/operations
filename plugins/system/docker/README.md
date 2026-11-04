# Docker 管理

独立标准插件包，只依赖公开 `serverdeck-plugin-sdk`。

构建：`node tools/build-plugin.mjs plugins/system/docker OUTPUT.sdplugin`。

该包可像用户上传的插件一样安装、授权、启停、升级及卸载；系统来源只由应用的首次分发记录设置。
