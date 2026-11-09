# 插件版本约定

| 协议                              | 当前版本 |
| --------------------------------- | -------- |
| Host语义API / Rust SDK / Vue SDK  | 5.0.0    |
| manifest schema / sdplugin format | 1        |
| WASM ABI / wire                   | 1        |
| UI                                | 4        |

新包声明 `apiVersion: "^5.0.0"`。SDK5移除Docker/AI助手等领域能力、旧tools/server视图、私有Store和专属桥，统一显式hostId与平台原语、结构化action input、async续接和owner资源。属于破坏性主版本变化。

平台尚未release，不提供SDK4兼容层或自动迁移开发包。旧包会被API/权限/UI校验拒绝，须用配套SDK重新构建并提高插件自身版本；不重置用户数据或伪造旧包升级成功。源码manifest、SDK、下载开发包、测试与宿主同步更新。

新增业务在插件内部演进自己的action/input/DTO和版本，不改变平台API。只有跨业务可复用的基础能力确有缺口时才讨论平台扩展；不能为单个新服务添加SDK枚举或宿主分支。包来源不影响API语义或执行特权。
