# 依赖许可证清单

本清单汇总 Cargo 全平台解析和 npm 生产依赖的许可证元数据。构建/测试及非当前平台的解析项可能包含在内，不表示所有条目进入安装包。完整许可文本见[第三方声明](THIRD_PARTY_NOTICES.txt)。发布时须对候选锁文件、实际包内容和许可原文逐项复核；元数据整理不等于法律审查完成。

## 许可来源与复核边界

- 原文主要取自解析包；部分包没有顶层许可文件，须核对其发布源码及许可适用范围，不从声明字段推断已取得完整授权。
- clipboard-win 5.4.3 的许可取自固定源码提交 `ed27008ae5d1f10cfbb266de039f0fb35fd05a56`；前端剪贴板插件的完整 MIT/Apache 文本来自同版本官方 Rust 插件包。
- jni/jni-macros 发布包未附许可文件，许可来源为对应源码提交的 MIT 文本；Android verifier 采用同一源码提交的父包许可，发布时仍需复核。
- russh、russh-cryptovec、russh-util 和 pageant 的 Apache-2.0 许可取自固定上游提交 `b541663a88381aab9f6af1af7bbadb02e155058a` 的仓库根 `LICENSE.txt`；依赖版本以工作区锁文件为准。
- WASM 编译与 WAT 相关解析包包含开发/测试工具；跨平台依赖不代表相应平台已经验收。

未找到顶层许可证文件的待复核项：objc2-osa-kit 0.3.2, alloc-stdlib 0.3.0, block2 0.6.2, cesu8 1.1.0, delegate 0.13.5, dispatch2 0.3.1, dlopen2 0.8.2, dlopen2_derive 0.4.3, gloo-timers 0.4.0, jni-sys-macros 0.4.1, libappindicator-sys 0.9.0, ndk 0.9.0, ndk-context 0.1.1, ndk-sys 0.6.0+11769913, objc2 0.6.5, objc2-app-kit 0.3.2, objc2-cloud-kit 0.3.2, objc2-core-data 0.3.2, objc2-core-foundation 0.3.2, objc2-core-graphics 0.3.2, objc2-core-image 0.3.2, objc2-core-location 0.3.2, objc2-core-text 0.3.2, objc2-encode 4.1.0, objc2-exception-helper 0.1.1, objc2-foundation 0.3.2, objc2-io-surface 0.3.2, objc2-quartz-core 0.3.2, objc2-ui-kit 0.3.2, objc2-user-notifications 0.3.2, objc2-web-kit 0.3.2, plist 1.10.3, r-efi 5.3.0, r-efi 6.0.0, rsqlite-vfs 0.1.1, selectors 0.38.0, tauri-plugin 2.7.2, valuable 0.1.1, webview2-com 0.39.1, webview2-com-macros 0.8.1, webview2-com-sys 0.39.1, winapi-i686-pc-windows-gnu 0.4.0, winapi-x86_64-pc-windows-gnu 0.4.0。

## Cargo 依赖

| 名称与版本                              | 声明许可证                                                                                                                          | 来源  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----- |
| adler2 2.0.1                            | 0BSD OR MIT OR Apache-2.0                                                                                                           | Cargo |
| aead 0.6.1                              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| aes 0.9.3                               | MIT OR Apache-2.0                                                                                                                   | Cargo |
| aes-gcm 0.11.1                          | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| aho-corasick 1.1.5                      | Unlicense OR MIT                                                                                                                    | Cargo |
| alloc-no-stdlib 3.0.0                   | BSD-3-Clause                                                                                                                        | Cargo |
| alloc-stdlib 0.3.0                      | BSD-3-Clause                                                                                                                        | Cargo |
| android_system_properties 0.1.6         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| anyhow 1.0.104                          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| apple-native-keyring-store 1.0.2        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| arboard 3.7.0                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| argon2 0.6.0                            | MIT OR Apache-2.0                                                                                                                   | Cargo |
| async-broadcast 0.7.2                   | MIT OR Apache-2.0                                                                                                                   | Cargo |
| async-channel 2.5.0                     | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| async-executor 1.14.0                   | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| async-io 2.6.0                          | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| async-lock 3.4.2                        | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| async-process 2.5.0                     | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| async-recursion 1.2.0                   | MIT OR Apache-2.0                                                                                                                   | Cargo |
| async-signal 0.2.14                     | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| async-task 4.7.1                        | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| async-trait 0.1.92                      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| atk 0.18.2                              | MIT                                                                                                                                 | Cargo |
| atk-sys 0.18.2                          | MIT                                                                                                                                 | Cargo |
| atomic-waker 1.1.2                      | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| autocfg 1.5.1                           | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| aws-lc-rs 1.19.0                        | ISC AND (Apache-2.0 OR ISC)                                                                                                         | Cargo |
| aws-lc-sys 0.47.0                       | ISC AND (Apache-2.0 OR ISC) AND Apache-2.0 AND MIT AND BSD-3-Clause AND (Apache-2.0 OR ISC OR MIT) AND (Apache-2.0 OR ISC OR MIT-0) | Cargo |
| base16ct 1.0.0                          | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| base64 0.21.7                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| base64 0.22.1                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| base64 0.23.1                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| base64ct 1.8.3                          | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| bcrypt-pbkdf 0.11.0                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| bit-set 0.8.0                           | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| bit-vec 0.8.0                           | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| bitflags 1.3.2                          | MIT/Apache-2.0                                                                                                                      | Cargo |
| bitflags 2.13.2                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| blake2 0.11.0                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| block-buffer 0.10.4                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| block-buffer 0.12.1                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| block-padding 0.4.2                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| block2 0.6.2                            | MIT                                                                                                                                 | Cargo |
| blocking 1.7.0                          | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| blowfish 0.10.0                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| brotli 9.1.1                            | BSD-3-Clause AND MIT                                                                                                                | Cargo |
| brotli-decompressor 6.2.0               | BSD-3-Clause/MIT                                                                                                                    | Cargo |
| bs58 0.5.1                              | MIT/Apache-2.0                                                                                                                      | Cargo |
| bumpalo 3.20.3                          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| bytemuck 1.25.2                         | Zlib OR Apache-2.0 OR MIT                                                                                                           | Cargo |
| byteorder 1.5.0                         | Unlicense OR MIT                                                                                                                    | Cargo |
| byteorder-lite 0.1.0                    | Unlicense OR MIT                                                                                                                    | Cargo |
| bytes 1.12.1                            | MIT                                                                                                                                 | Cargo |
| cairo-rs 0.18.5                         | MIT                                                                                                                                 | Cargo |
| cairo-sys-rs 0.18.2                     | MIT                                                                                                                                 | Cargo |
| camino 1.2.6                            | MIT OR Apache-2.0                                                                                                                   | Cargo |
| cargo-platform 0.1.9                    | MIT OR Apache-2.0                                                                                                                   | Cargo |
| cargo_metadata 0.19.2                   | MIT                                                                                                                                 | Cargo |
| cargo_toml 1.0.1                        | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| cbc 0.2.1                               | MIT OR Apache-2.0                                                                                                                   | Cargo |
| cc 1.10.0                               | MIT OR Apache-2.0                                                                                                                   | Cargo |
| cesu8 1.1.0                             | Apache-2.0/MIT                                                                                                                      | Cargo |
| cfb 0.14.0                              | MIT                                                                                                                                 | Cargo |
| cfg-expr 0.15.8                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| cfg-if 1.0.5                            | MIT OR Apache-2.0                                                                                                                   | Cargo |
| cfg_aliases 0.1.1                       | MIT                                                                                                                                 | Cargo |
| cfg_aliases 0.2.2                       | MIT                                                                                                                                 | Cargo |
| chacha20 0.10.2                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| chrono 0.4.45                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| cipher 0.5.2                            | MIT OR Apache-2.0                                                                                                                   | Cargo |
| clipboard-win 5.4.3                     | BSL-1.0                                                                                                                             | Cargo |
| cmake 0.1.58                            | MIT OR Apache-2.0                                                                                                                   | Cargo |
| cmov 0.5.4                              | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| combine 4.6.9                           | MIT                                                                                                                                 | Cargo |
| concurrent-queue 2.5.0                  | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| const-oid 0.10.2                        | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| cookie 0.18.2                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| core-foundation 0.10.1                  | MIT OR Apache-2.0                                                                                                                   | Cargo |
| core-foundation 0.9.4                   | MIT OR Apache-2.0                                                                                                                   | Cargo |
| core-foundation-sys 0.8.7               | MIT OR Apache-2.0                                                                                                                   | Cargo |
| core-graphics 0.25.0                    | MIT OR Apache-2.0                                                                                                                   | Cargo |
| core-graphics-types 0.2.0               | MIT OR Apache-2.0                                                                                                                   | Cargo |
| cpubits 0.1.1                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| cpufeatures 0.2.17                      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| cpufeatures 0.3.1                       | MIT OR Apache-2.0                                                                                                                   | Cargo |
| crc32fast 1.5.3                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| crossbeam-channel 0.5.17                | MIT OR Apache-2.0                                                                                                                   | Cargo |
| crossbeam-utils 0.8.23                  | MIT OR Apache-2.0                                                                                                                   | Cargo |
| crunchy 0.2.4                           | MIT                                                                                                                                 | Cargo |
| crypto-bigint 0.7.11                    | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| crypto-common 0.1.6                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| crypto-common 0.2.2                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| crypto-primes 0.7.2                     | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| cssparser 0.37.0                        | MPL-2.0                                                                                                                             | Cargo |
| cssparser-macros 0.7.1                  | MPL-2.0                                                                                                                             | Cargo |
| ctor 1.0.13                             | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| ctr 0.10.1                              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| ctutils 0.4.8                           | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| curve25519-dalek 5.0.0                  | BSD-3-Clause                                                                                                                        | Cargo |
| curve25519-dalek-derive 0.1.1           | MIT/Apache-2.0                                                                                                                      | Cargo |
| darling 0.24.1                          | MIT                                                                                                                                 | Cargo |
| darling_core 0.24.1                     | MIT                                                                                                                                 | Cargo |
| darling_macro 0.24.1                    | MIT                                                                                                                                 | Cargo |
| dashmap 6.2.1                           | MIT                                                                                                                                 | Cargo |
| data-encoding 2.11.1                    | MIT                                                                                                                                 | Cargo |
| dbus 0.9.12                             | Apache-2.0/MIT                                                                                                                      | Cargo |
| defmt 1.2.0                             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| defmt-macros 1.2.0                      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| defmt-parser 1.1.0                      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| delegate 0.13.5                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| der 0.8.3                               | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| deranged 0.5.9                          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| derive_more 2.1.1                       | MIT                                                                                                                                 | Cargo |
| derive_more-impl 2.1.1                  | MIT                                                                                                                                 | Cargo |
| des 0.9.0                               | MIT OR Apache-2.0                                                                                                                   | Cargo |
| digest 0.10.7                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| digest 0.11.3                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| dirs 7.0.0                              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| dirs-sys 0.5.0                          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| dispatch2 0.3.1                         | Zlib OR Apache-2.0 OR MIT                                                                                                           | Cargo |
| displaydoc 0.2.7                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| dlopen2 0.8.2                           | MIT                                                                                                                                 | Cargo |
| dlopen2_derive 0.4.3                    | MIT                                                                                                                                 | Cargo |
| dom_query 0.28.0                        | MIT                                                                                                                                 | Cargo |
| downcast-rs 1.2.1                       | MIT OR Apache-2.0                                                                                                                   | Cargo |
| dpi 0.1.2                               | Apache-2.0 AND MIT                                                                                                                  | Cargo |
| dtoa 1.0.11                             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| dtoa-short 0.3.5                        | MPL-2.0                                                                                                                             | Cargo |
| dunce 1.0.5                             | CC0-1.0 OR MIT-0 OR Apache-2.0                                                                                                      | Cargo |
| dyn-clone 1.0.20                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| ecdsa 0.17.0                            | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| ed25519 3.0.0                           | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| ed25519-dalek 3.0.0                     | BSD-3-Clause                                                                                                                        | Cargo |
| elliptic-curve 0.14.3                   | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| embed-resource 3.0.12                   | MIT                                                                                                                                 | Cargo |
| embed_plist 1.2.2                       | MIT OR Apache-2.0                                                                                                                   | Cargo |
| endi 1.1.1                              | MIT                                                                                                                                 | Cargo |
| enum_dispatch 0.3.13                    | MIT OR Apache-2.0                                                                                                                   | Cargo |
| enumflags2 0.7.12                       | MIT OR Apache-2.0                                                                                                                   | Cargo |
| enumflags2_derive 0.7.12                | MIT OR Apache-2.0                                                                                                                   | Cargo |
| equivalent 1.0.3                        | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| erased-serde 0.4.11                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| errno 0.3.14                            | MIT OR Apache-2.0                                                                                                                   | Cargo |
| error-code 3.4.0                        | BSL-1.0                                                                                                                             | Cargo |
| event-listener 5.4.2                    | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| event-listener-strategy 0.5.4           | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| fallible-iterator 0.3.0                 | MIT/Apache-2.0                                                                                                                      | Cargo |
| fallible-streaming-iterator 0.1.9       | MIT/Apache-2.0                                                                                                                      | Cargo |
| fastrand 2.5.0                          | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| fax 0.2.7                               | MIT                                                                                                                                 | Cargo |
| fdeflate 0.3.7                          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| ff 0.14.0                               | MIT/Apache-2.0                                                                                                                      | Cargo |
| fiat-crypto 0.3.0                       | MIT OR Apache-2.0 OR BSD-1-Clause                                                                                                   | Cargo |
| field-offset 0.3.6                      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| filedescriptor 0.8.3                    | MIT                                                                                                                                 | Cargo |
| filetime 0.2.29                         | MIT/Apache-2.0                                                                                                                      | Cargo |
| find-msvc-tools 0.1.15                  | MIT OR Apache-2.0                                                                                                                   | Cargo |
| fixedbitset 0.5.7                       | MIT OR Apache-2.0                                                                                                                   | Cargo |
| flate2 1.1.10                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| fnv 1.0.7                               | Apache-2.0 / MIT                                                                                                                    | Cargo |
| foldhash 0.1.5                          | Zlib                                                                                                                                | Cargo |
| foldhash 0.2.0                          | Zlib                                                                                                                                | Cargo |
| foreign-types 0.5.0                     | MIT/Apache-2.0                                                                                                                      | Cargo |
| foreign-types-macros 0.2.4              | MIT/Apache-2.0                                                                                                                      | Cargo |
| foreign-types-shared 0.3.1              | MIT/Apache-2.0                                                                                                                      | Cargo |
| form_urlencoded 1.2.2                   | MIT OR Apache-2.0                                                                                                                   | Cargo |
| fs2 0.4.3                               | MIT OR Apache-2.0                                                                                                                   | Cargo |
| fs_extra 1.3.0                          | MIT                                                                                                                                 | Cargo |
| futures 0.3.34                          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| futures-channel 0.3.34                  | MIT OR Apache-2.0                                                                                                                   | Cargo |
| futures-core 0.3.34                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| futures-executor 0.3.34                 | MIT OR Apache-2.0                                                                                                                   | Cargo |
| futures-io 0.3.34                       | MIT OR Apache-2.0                                                                                                                   | Cargo |
| futures-lite 2.6.1                      | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| futures-macro 0.3.34                    | MIT OR Apache-2.0                                                                                                                   | Cargo |
| futures-sink 0.3.34                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| futures-task 0.3.34                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| futures-util 0.3.34                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| gdk 0.18.2                              | MIT                                                                                                                                 | Cargo |
| gdk-pixbuf 0.18.5                       | MIT                                                                                                                                 | Cargo |
| gdk-pixbuf-sys 0.18.0                   | MIT                                                                                                                                 | Cargo |
| gdk-sys 0.18.2                          | MIT                                                                                                                                 | Cargo |
| gdkwayland-sys 0.18.2                   | MIT                                                                                                                                 | Cargo |
| gdkx11 0.18.2                           | MIT                                                                                                                                 | Cargo |
| gdkx11-sys 0.18.2                       | MIT                                                                                                                                 | Cargo |
| generic-array 0.14.9                    | MIT                                                                                                                                 | Cargo |
| generic-array 1.4.5                     | MIT                                                                                                                                 | Cargo |
| gethostname 1.1.0                       | Apache-2.0                                                                                                                          | Cargo |
| getrandom 0.2.17                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| getrandom 0.3.4                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| getrandom 0.4.3                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| ghash 0.6.0                             | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| gio 0.18.4                              | MIT                                                                                                                                 | Cargo |
| gio-sys 0.18.1                          | MIT                                                                                                                                 | Cargo |
| glib 0.18.5                             | MIT                                                                                                                                 | Cargo |
| glib-macros 0.18.5                      | MIT                                                                                                                                 | Cargo |
| glib-sys 0.18.1                         | MIT                                                                                                                                 | Cargo |
| glob 0.3.4                              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| gloo-timers 0.4.0                       | MIT OR Apache-2.0                                                                                                                   | Cargo |
| gobject-sys 0.18.0                      | MIT                                                                                                                                 | Cargo |
| group 0.14.0                            | MIT/Apache-2.0                                                                                                                      | Cargo |
| gtk 0.18.2                              | MIT                                                                                                                                 | Cargo |
| gtk-sys 0.18.2                          | MIT                                                                                                                                 | Cargo |
| gtk3-macros 0.18.2                      | MIT                                                                                                                                 | Cargo |
| half 2.7.1                              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| hashbrown 0.12.3                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| hashbrown 0.14.5                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| hashbrown 0.15.5                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| hashbrown 0.16.1                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| hashbrown 0.17.1                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| hashlink 0.11.1                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| heck 0.4.1                              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| heck 0.5.0                              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| hermit-abi 0.5.3                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| hex 0.4.3                               | MIT OR Apache-2.0                                                                                                                   | Cargo |
| hex-literal 1.1.0                       | MIT OR Apache-2.0                                                                                                                   | Cargo |
| hkdf 0.13.0                             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| hmac 0.13.0                             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| html5ever 0.39.0                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| http 1.5.0                              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| http-body 1.1.0                         | MIT                                                                                                                                 | Cargo |
| http-body-util 0.1.5                    | MIT                                                                                                                                 | Cargo |
| httparse 1.10.1                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| hybrid-array 0.4.15                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| hyper 1.12.0                            | MIT                                                                                                                                 | Cargo |
| hyper-rustls 0.27.10                    | Apache-2.0 OR ISC OR MIT                                                                                                            | Cargo |
| hyper-util 0.1.21                       | MIT                                                                                                                                 | Cargo |
| iana-time-zone 0.1.65                   | MIT OR Apache-2.0                                                                                                                   | Cargo |
| iana-time-zone-haiku 0.1.2              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| ico 0.6.0                               | MIT                                                                                                                                 | Cargo |
| icu_collections 2.4.0                   | Unicode-3.0                                                                                                                         | Cargo |
| icu_locale_core 2.4.0                   | Unicode-3.0                                                                                                                         | Cargo |
| icu_normalizer 2.4.0                    | Unicode-3.0                                                                                                                         | Cargo |
| icu_normalizer_data 2.4.0               | Unicode-3.0                                                                                                                         | Cargo |
| icu_properties 2.4.0                    | Unicode-3.0                                                                                                                         | Cargo |
| icu_properties_data 2.4.0               | Unicode-3.0                                                                                                                         | Cargo |
| icu_provider 2.4.0                      | Unicode-3.0                                                                                                                         | Cargo |
| ident_case 1.0.1                        | MIT/Apache-2.0                                                                                                                      | Cargo |
| idna 1.1.0                              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| idna_adapter 1.2.2                      | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| image 0.25.10                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| indexmap 1.9.3                          | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| indexmap 2.14.2                         | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| infer 0.22.0                            | MIT                                                                                                                                 | Cargo |
| inout 0.2.5                             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| ipnet 2.12.2                            | MIT OR Apache-2.0                                                                                                                   | Cargo |
| is-docker 0.2.0                         | MIT                                                                                                                                 | Cargo |
| is-wsl 0.4.0                            | MIT                                                                                                                                 | Cargo |
| itoa 1.0.18                             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| javascriptcore-rs 1.1.2                 | MIT                                                                                                                                 | Cargo |
| javascriptcore-rs-sys 1.1.1             | MIT                                                                                                                                 | Cargo |
| jiff 0.2.38                             | Unlicense OR MIT                                                                                                                    | Cargo |
| jiff-core 0.1.1                         | Unlicense OR MIT                                                                                                                    | Cargo |
| jiff-static 0.2.38                      | Unlicense OR MIT                                                                                                                    | Cargo |
| jiff-tzdb 0.1.9                         | Unlicense OR MIT                                                                                                                    | Cargo |
| jiff-tzdb-platform 0.1.3                | Unlicense OR MIT                                                                                                                    | Cargo |
| jni 0.21.1                              | MIT/Apache-2.0                                                                                                                      | Cargo |
| jni 0.22.4                              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| jni-macros 0.22.4                       | MIT OR Apache-2.0                                                                                                                   | Cargo |
| jni-sys 0.3.1                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| jni-sys 0.4.1                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| jni-sys-macros 0.4.1                    | MIT OR Apache-2.0                                                                                                                   | Cargo |
| jobserver 0.1.35                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| js-sys 0.3.107                          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| json-patch 4.2.0                        | MIT/Apache-2.0                                                                                                                      | Cargo |
| jsonptr 0.7.1                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| keccak 0.2.2                            | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| kem 0.3.0                               | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| keyboard-types 0.8.3                    | MIT OR Apache-2.0                                                                                                                   | Cargo |
| keyring 4.2.0                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| keyring-core 1.0.1                      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| lazy_static 1.5.1                       | MIT OR Apache-2.0                                                                                                                   | Cargo |
| leb128fmt 0.1.0                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| libappindicator 0.9.0                   | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| libappindicator-sys 0.9.0               | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| libc 0.2.191                            | MIT OR Apache-2.0                                                                                                                   | Cargo |
| libdbus-sys 0.2.7                       | Apache-2.0/MIT                                                                                                                      | Cargo |
| libloading 0.7.4                        | ISC                                                                                                                                 | Cargo |
| libm 0.2.16                             | MIT                                                                                                                                 | Cargo |
| libredox 0.1.25                         | MIT                                                                                                                                 | Cargo |
| libsqlite3-sys 0.36.0                   | MIT                                                                                                                                 | Cargo |
| linux-raw-sys 0.12.1                    | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT                                                                                 | Cargo |
| litemap 0.8.3                           | Unicode-3.0                                                                                                                         | Cargo |
| lock_api 0.4.14                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| log 0.4.35                              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| lru-slab 0.1.3                          | MIT OR Apache-2.0 OR Zlib                                                                                                           | Cargo |
| markup5ever 0.39.0                      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| matchers 0.2.0                          | MIT                                                                                                                                 | Cargo |
| md5 0.8.1                               | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| memchr 2.8.3                            | Unlicense OR MIT                                                                                                                    | Cargo |
| memoffset 0.9.1                         | MIT                                                                                                                                 | Cargo |
| mime 0.3.17                             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| minisign-verify 0.3.0                   | MIT                                                                                                                                 | Cargo |
| miniz_oxide 0.8.9                       | MIT OR Zlib OR Apache-2.0                                                                                                           | Cargo |
| miniz_oxide 0.9.1                       | MIT OR Zlib OR Apache-2.0                                                                                                           | Cargo |
| mio 1.2.4                               | MIT                                                                                                                                 | Cargo |
| ml-kem 0.3.4                            | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| module-lattice 0.2.4                    | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| moxcms 0.8.1                            | BSD-3-Clause OR Apache-2.0                                                                                                          | Cargo |
| muda 0.20.0                             | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| ndk 0.9.0                               | MIT OR Apache-2.0                                                                                                                   | Cargo |
| ndk-context 0.1.1                       | MIT OR Apache-2.0                                                                                                                   | Cargo |
| ndk-sys 0.6.0+11769913                  | MIT OR Apache-2.0                                                                                                                   | Cargo |
| new_debug_unreachable 1.0.6             | MIT                                                                                                                                 | Cargo |
| nix 0.28.0                              | MIT                                                                                                                                 | Cargo |
| nix 0.31.3                              | MIT                                                                                                                                 | Cargo |
| nom 8.0.0                               | MIT                                                                                                                                 | Cargo |
| nu-ansi-term 0.50.3                     | MIT                                                                                                                                 | Cargo |
| num 0.4.3                               | MIT OR Apache-2.0                                                                                                                   | Cargo |
| num-bigint 0.4.8                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| num-bigint 0.5.1                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| num-complex 0.4.6                       | MIT OR Apache-2.0                                                                                                                   | Cargo |
| num-conv 0.2.2                          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| num-integer 0.1.47                      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| num-iter 0.1.46                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| num-rational 0.4.2                      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| num-traits 0.2.19                       | MIT OR Apache-2.0                                                                                                                   | Cargo |
| num_enum 0.7.6                          | BSD-3-Clause OR MIT OR Apache-2.0                                                                                                   | Cargo |
| num_enum_derive 0.7.6                   | BSD-3-Clause OR MIT OR Apache-2.0                                                                                                   | Cargo |
| objc2 0.6.5                             | MIT                                                                                                                                 | Cargo |
| objc2-app-kit 0.3.2                     | Zlib OR Apache-2.0 OR MIT                                                                                                           | Cargo |
| objc2-cloud-kit 0.3.2                   | Zlib OR Apache-2.0 OR MIT                                                                                                           | Cargo |
| objc2-core-data 0.3.2                   | Zlib OR Apache-2.0 OR MIT                                                                                                           | Cargo |
| objc2-core-foundation 0.3.2             | Zlib OR Apache-2.0 OR MIT                                                                                                           | Cargo |
| objc2-core-graphics 0.3.2               | Zlib OR Apache-2.0 OR MIT                                                                                                           | Cargo |
| objc2-core-image 0.3.2                  | Zlib OR Apache-2.0 OR MIT                                                                                                           | Cargo |
| objc2-core-location 0.3.2               | Zlib OR Apache-2.0 OR MIT                                                                                                           | Cargo |
| objc2-core-text 0.3.2                   | Zlib OR Apache-2.0 OR MIT                                                                                                           | Cargo |
| objc2-encode 4.1.0                      | MIT                                                                                                                                 | Cargo |
| objc2-exception-helper 0.1.1            | Zlib OR Apache-2.0 OR MIT                                                                                                           | Cargo |
| objc2-foundation 0.3.2                  | MIT                                                                                                                                 | Cargo |
| objc2-io-surface 0.3.2                  | Zlib OR Apache-2.0 OR MIT                                                                                                           | Cargo |
| objc2-osa-kit 0.3.2                     | Zlib OR Apache-2.0 OR MIT                                                                                                           | Cargo |
| objc2-quartz-core 0.3.2                 | Zlib OR Apache-2.0 OR MIT                                                                                                           | Cargo |
| objc2-ui-kit 0.3.2                      | Zlib OR Apache-2.0 OR MIT                                                                                                           | Cargo |
| objc2-user-notifications 0.3.2          | Zlib OR Apache-2.0 OR MIT                                                                                                           | Cargo |
| objc2-web-kit 0.3.2                     | Zlib OR Apache-2.0 OR MIT                                                                                                           | Cargo |
| once_cell 1.21.4                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| open 5.4.5                              | MIT                                                                                                                                 | Cargo |
| openssl-probe 0.2.2                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| option-ext 0.2.0                        | MPL-2.0                                                                                                                             | Cargo |
| ordered-stream 0.2.0                    | MIT OR Apache-2.0                                                                                                                   | Cargo |
| os_pipe 1.2.3                           | MIT                                                                                                                                 | Cargo |
| osakit 0.3.1                            | MIT OR Apache-2.0                                                                                                                   | Cargo |
| p256 0.14.0                             | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| p384 0.14.0                             | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| p521 0.14.0                             | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| pageant 0.2.5                           | Apache-2.0                                                                                                                          | Cargo |
| pango 0.18.3                            | MIT                                                                                                                                 | Cargo |
| pango-sys 0.18.0                        | MIT                                                                                                                                 | Cargo |
| parking 2.2.1                           | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| parking_lot 0.12.5                      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| parking_lot_core 0.9.12                 | MIT OR Apache-2.0                                                                                                                   | Cargo |
| password-hash 0.6.1                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| pbkdf2 0.13.0                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| pem-rfc7468 1.0.0                       | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| percent-encoding 2.3.2                  | MIT OR Apache-2.0                                                                                                                   | Cargo |
| petgraph 0.8.3                          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| phc 0.6.1                               | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| phf 0.13.1                              | MIT                                                                                                                                 | Cargo |
| phf_codegen 0.13.1                      | MIT                                                                                                                                 | Cargo |
| phf_generator 0.13.1                    | MIT                                                                                                                                 | Cargo |
| phf_macros 0.13.1                       | MIT                                                                                                                                 | Cargo |
| phf_shared 0.13.1                       | MIT                                                                                                                                 | Cargo |
| pin-project-lite 0.2.17                 | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| piper 0.2.5                             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| pkcs1 0.8.0                             | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| pkcs5 0.8.1                             | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| pkcs8 0.11.0                            | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| pkg-config 0.3.34                       | MIT OR Apache-2.0                                                                                                                   | Cargo |
| plist 1.10.3                            | MIT                                                                                                                                 | Cargo |
| png 0.18.1                              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| polling 3.11.0                          | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| poly1305 0.9.1                          | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| polyval 0.7.3                           | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| portable-atomic 1.15.0                  | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| portable-atomic-util 0.2.8              | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| portable-pty 0.9.0                      | MIT                                                                                                                                 | Cargo |
| potential_utf 0.1.6                     | Unicode-3.0                                                                                                                         | Cargo |
| powerfmt 0.2.1                          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| precomputed-hash 0.1.1                  | MIT                                                                                                                                 | Cargo |
| primefield 0.14.0                       | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| primeorder 0.14.0                       | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| proc-macro-crate 1.3.1                  | MIT OR Apache-2.0                                                                                                                   | Cargo |
| proc-macro-crate 2.0.2                  | MIT OR Apache-2.0                                                                                                                   | Cargo |
| proc-macro-crate 3.5.0                  | MIT OR Apache-2.0                                                                                                                   | Cargo |
| proc-macro-error 1.0.4                  | MIT OR Apache-2.0                                                                                                                   | Cargo |
| proc-macro-error-attr 1.0.4             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| proc-macro2 1.0.107                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| pxfm 0.1.30                             | BSD-3-Clause OR Apache-2.0                                                                                                          | Cargo |
| quick-error 2.0.1                       | MIT/Apache-2.0                                                                                                                      | Cargo |
| quick-xml 0.41.0                        | MIT                                                                                                                                 | Cargo |
| quick-xml 0.42.0                        | MIT                                                                                                                                 | Cargo |
| quinn 0.11.12                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| quinn-proto 0.11.19                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| quinn-udp 0.5.16                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| quote 1.0.47                            | MIT OR Apache-2.0                                                                                                                   | Cargo |
| r-efi 5.3.0                             | MIT OR Apache-2.0 OR LGPL-2.1-or-later                                                                                              | Cargo |
| r-efi 6.0.0                             | MIT OR Apache-2.0 OR LGPL-2.1-or-later                                                                                              | Cargo |
| rand 0.10.3                             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| rand_core 0.10.1                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| rand_pcg 0.10.2                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| raw-window-handle 0.6.2                 | MIT OR Apache-2.0 OR Zlib                                                                                                           | Cargo |
| redox_syscall 0.5.18                    | MIT                                                                                                                                 | Cargo |
| redox_users 0.5.3                       | MIT                                                                                                                                 | Cargo |
| ref-cast 1.0.27                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| ref-cast-impl 1.0.27                    | MIT OR Apache-2.0                                                                                                                   | Cargo |
| regex 1.13.1                            | MIT OR Apache-2.0                                                                                                                   | Cargo |
| regex-automata 0.4.18                   | MIT OR Apache-2.0                                                                                                                   | Cargo |
| regex-syntax 0.8.11                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| reqwest 0.13.5                          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| rfc6979 0.6.0                           | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| rfd 0.17.2                              | MIT                                                                                                                                 | Cargo |
| ring 0.17.14                            | Apache-2.0 AND ISC                                                                                                                  | Cargo |
| rpassword 7.5.4                         | Apache-2.0                                                                                                                          | Cargo |
| rsa 0.10.0                              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| rsqlite-vfs 0.1.1                       | MIT                                                                                                                                 | Cargo |
| rtoolbox 0.0.6                          | Apache-2.0                                                                                                                          | Cargo |
| rusqlite 0.38.0                         | MIT                                                                                                                                 | Cargo |
| russh 0.65.1                            | Apache-2.0                                                                                                                          | Cargo |
| russh-cryptovec 0.62.0                  | Apache-2.0                                                                                                                          | Cargo |
| russh-sftp 3.0.1                        | Apache-2.0                                                                                                                          | Cargo |
| russh-util 0.52.0                       | Apache-2.0                                                                                                                          | Cargo |
| rustc-hash 2.1.3                        | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| rustc_version 0.4.1                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| rustix 1.1.6                            | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT                                                                                 | Cargo |
| rustls 0.23.46                          | Apache-2.0 OR ISC OR MIT                                                                                                            | Cargo |
| rustls-native-certs 0.8.5               | Apache-2.0 OR ISC OR MIT                                                                                                            | Cargo |
| rustls-pki-types 1.15.1                 | MIT OR Apache-2.0                                                                                                                   | Cargo |
| rustls-platform-verifier 0.7.1          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| rustls-platform-verifier-android 0.2.0  | MIT OR Apache-2.0                                                                                                                   | Cargo |
| rustls-webpki 0.103.16                  | ISC                                                                                                                                 | Cargo |
| rustversion 1.0.23                      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| salsa20 0.11.0                          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| same-file 1.0.6                         | Unlicense/MIT                                                                                                                       | Cargo |
| schannel 0.1.30                         | MIT                                                                                                                                 | Cargo |
| schemars 0.8.22                         | MIT                                                                                                                                 | Cargo |
| schemars 0.9.0                          | MIT                                                                                                                                 | Cargo |
| schemars 1.2.3                          | MIT                                                                                                                                 | Cargo |
| schemars_derive 0.8.22                  | MIT                                                                                                                                 | Cargo |
| scopeguard 1.2.0                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| scrypt 0.12.0                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| sec1 0.8.1                              | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| secret-service 5.2.0                    | MIT OR Apache-2.0                                                                                                                   | Cargo |
| security-framework 3.7.0                | MIT OR Apache-2.0                                                                                                                   | Cargo |
| security-framework-sys 2.17.0           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| selectors 0.38.0                        | MPL-2.0                                                                                                                             | Cargo |
| semver 1.0.28                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| serde 1.0.229                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| serde-untagged 0.1.9                    | MIT OR Apache-2.0                                                                                                                   | Cargo |
| serde_bytes 0.11.19                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| serde_core 1.0.229                      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| serde_derive 1.0.229                    | MIT OR Apache-2.0                                                                                                                   | Cargo |
| serde_derive_internals 0.29.1           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| serde_json 1.0.154                      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| serde_repr 0.1.21                       | MIT OR Apache-2.0                                                                                                                   | Cargo |
| serde_spanned 0.6.9                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| serde_spanned 1.1.2                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| serde_with 3.24.0                       | MIT OR Apache-2.0                                                                                                                   | Cargo |
| serde_with_macros 3.24.0                | MIT OR Apache-2.0                                                                                                                   | Cargo |
| serdect 0.4.3                           | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| serial2 0.2.39                          | BSD-2-Clause OR Apache-2.0                                                                                                          | Cargo |
| serialize-to-javascript 0.1.2           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| serialize-to-javascript-impl 0.1.2      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| servo_arc 0.4.3                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| sha1 0.11.0                             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| sha2 0.10.9                             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| sha2 0.11.1                             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| sha3 0.12.0                             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| shake 0.1.0                             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| sharded-slab 0.1.7                      | MIT                                                                                                                                 | Cargo |
| shared_library 0.1.9                    | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| shell-words 1.1.1                       | MIT OR Apache-2.0                                                                                                                   | Cargo |
| shlex 2.0.1                             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| signal-hook-registry 1.4.8              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| signature 3.0.0                         | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| simd-adler32 0.3.10                     | MIT                                                                                                                                 | Cargo |
| simd_cesu8 1.2.0                        | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| simdutf8 0.1.5                          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| siphasher 1.0.4                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| slab 0.4.12                             | MIT                                                                                                                                 | Cargo |
| smallvec 1.16.4                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| socket2 0.6.5                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| softbuffer 0.4.8                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| soup3 0.5.0                             | MIT                                                                                                                                 | Cargo |
| soup3-sys 0.5.0                         | MIT                                                                                                                                 | Cargo |
| spin 0.9.9                              | MIT                                                                                                                                 | Cargo |
| spki 0.8.1                              | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| sponge-cursor 0.1.0                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| sqlite-wasm-rs 0.5.5                    | MIT                                                                                                                                 | Cargo |
| ssh-cipher 0.3.0                        | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| ssh-encoding 0.3.0                      | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| ssh-key 0.7.0-rc.12                     | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| stable_deref_trait 1.2.1                | MIT OR Apache-2.0                                                                                                                   | Cargo |
| static_vcruntime 3.0.0                  | MIT OR Apache-2.0 OR Zlib                                                                                                           | Cargo |
| string-interner 0.19.0                  | MIT/Apache-2.0                                                                                                                      | Cargo |
| string_cache 0.9.0                      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| string_cache_codegen 0.6.1              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| strsim 0.11.1                           | MIT                                                                                                                                 | Cargo |
| subtle 2.6.1                            | BSD-3-Clause                                                                                                                        | Cargo |
| swift-rs 1.0.9                          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| symlink 0.1.0                           | MIT/Apache-2.0                                                                                                                      | Cargo |
| syn 1.0.109                             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| syn 2.0.119                             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| syn 3.0.9                               | MIT OR Apache-2.0                                                                                                                   | Cargo |
| sync_wrapper 1.0.2                      | Apache-2.0                                                                                                                          | Cargo |
| synstructure 0.14.0                     | MIT                                                                                                                                 | Cargo |
| system-configuration 0.7.0              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| system-configuration-sys 0.6.0          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| system-deps 6.2.2                       | MIT OR Apache-2.0                                                                                                                   | Cargo |
| tao 0.37.2                              | Apache-2.0                                                                                                                          | Cargo |
| tao-macros 0.1.4                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| tar 0.4.46                              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| target-lexicon 0.12.16                  | Apache-2.0 WITH LLVM-exception                                                                                                      | Cargo |
| tauri 2.12.5                            | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| tauri-build 2.7.4                       | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| tauri-codegen 2.7.4                     | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| tauri-macros 2.7.4                      | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| tauri-plugin 2.7.2                      | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| tauri-plugin-clipboard-manager 2.5.0    | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| tauri-plugin-dialog 2.8.4               | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| tauri-plugin-fs 2.7.1                   | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| tauri-plugin-opener 2.7.2               | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| tauri-plugin-single-instance 2.5.5      | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| tauri-plugin-updater 2.14.1             | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| tauri-runtime 2.12.2                    | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| tauri-runtime-wry 2.12.3                | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| tauri-utils 2.10.2                      | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| tauri-winres 0.3.7                      | MIT                                                                                                                                 | Cargo |
| tempfile 3.27.0                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| tendril 0.5.1                           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| thiserror 1.0.69                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| thiserror 2.0.21                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| thiserror-impl 1.0.69                   | MIT OR Apache-2.0                                                                                                                   | Cargo |
| thiserror-impl 2.0.21                   | MIT OR Apache-2.0                                                                                                                   | Cargo |
| thread_local 1.1.10                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| tiff 0.11.3                             | MIT                                                                                                                                 | Cargo |
| time 0.3.55                             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| time-core 0.1.9                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| time-macros 0.2.32                      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| tinystr 0.8.5                           | Unicode-3.0                                                                                                                         | Cargo |
| tinyvec 1.13.3                          | Zlib OR Apache-2.0 OR MIT                                                                                                           | Cargo |
| tokio 1.54.1                            | MIT                                                                                                                                 | Cargo |
| tokio-macros 2.7.2                      | MIT                                                                                                                                 | Cargo |
| tokio-rustls 0.26.6                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| tokio-stream 0.1.19                     | MIT                                                                                                                                 | Cargo |
| tokio-util 0.7.20                       | MIT                                                                                                                                 | Cargo |
| toml 0.8.2                              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| toml 1.1.8+spec-1.1.0                   | MIT OR Apache-2.0                                                                                                                   | Cargo |
| toml_datetime 0.6.3                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| toml_datetime 1.1.2+spec-1.1.0          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| toml_edit 0.19.15                       | MIT OR Apache-2.0                                                                                                                   | Cargo |
| toml_edit 0.20.2                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| toml_edit 0.25.17+spec-1.1.0            | MIT OR Apache-2.0                                                                                                                   | Cargo |
| toml_parser 1.1.5+spec-1.1.0            | MIT OR Apache-2.0                                                                                                                   | Cargo |
| toml_writer 1.1.3+spec-1.1.0            | MIT OR Apache-2.0                                                                                                                   | Cargo |
| tower 0.5.3                             | MIT                                                                                                                                 | Cargo |
| tower-http 0.6.11                       | MIT                                                                                                                                 | Cargo |
| tower-layer 0.3.3                       | MIT                                                                                                                                 | Cargo |
| tower-service 0.3.3                     | MIT                                                                                                                                 | Cargo |
| tracing 0.1.44                          | MIT                                                                                                                                 | Cargo |
| tracing-appender 0.2.5                  | MIT                                                                                                                                 | Cargo |
| tracing-attributes 0.1.31               | MIT                                                                                                                                 | Cargo |
| tracing-core 0.1.36                     | MIT                                                                                                                                 | Cargo |
| tracing-log 0.2.0                       | MIT                                                                                                                                 | Cargo |
| tracing-subscriber 0.3.23               | MIT                                                                                                                                 | Cargo |
| tray-icon 0.25.1                        | MIT OR Apache-2.0                                                                                                                   | Cargo |
| tree_magic_mini 3.2.2                   | MIT                                                                                                                                 | Cargo |
| try-lock 0.2.5                          | MIT                                                                                                                                 | Cargo |
| typeid 1.0.3                            | MIT OR Apache-2.0                                                                                                                   | Cargo |
| typenum 1.20.1                          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| uds_windows 1.2.1                       | MIT                                                                                                                                 | Cargo |
| unicode-ident 1.0.27                    | (MIT OR Apache-2.0) AND Unicode-3.0                                                                                                 | Cargo |
| unicode-segmentation 1.13.3             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| unicode-width 0.2.3                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| universal-hash 0.6.1                    | MIT OR Apache-2.0                                                                                                                   | Cargo |
| untrusted 0.9.0                         | ISC                                                                                                                                 | Cargo |
| url 2.5.8                               | MIT OR Apache-2.0                                                                                                                   | Cargo |
| urlpattern 0.6.0                        | MIT                                                                                                                                 | Cargo |
| utf8_iter 1.1.0                         | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| utf_types 1.0.0                         | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| uuid 1.29.0                             | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| valuable 0.1.1                          | MIT                                                                                                                                 | Cargo |
| vcpkg 0.2.15                            | MIT/Apache-2.0                                                                                                                      | Cargo |
| version-compare 0.2.1                   | MIT                                                                                                                                 | Cargo |
| version_check 0.9.5                     | MIT/Apache-2.0                                                                                                                      | Cargo |
| vswhom 0.1.0                            | MIT                                                                                                                                 | Cargo |
| vswhom-sys 0.1.3                        | MIT                                                                                                                                 | Cargo |
| walkdir 2.5.0                           | Unlicense/MIT                                                                                                                       | Cargo |
| want 0.3.2                              | MIT                                                                                                                                 | Cargo |
| wasi 0.11.1+wasi-snapshot-preview1      | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT                                                                                 | Cargo |
| wasip2 1.0.4+wasi-0.2.12                | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT                                                                                 | Cargo |
| wasm-bindgen 0.2.130                    | MIT OR Apache-2.0                                                                                                                   | Cargo |
| wasm-bindgen-futures 0.4.80             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| wasm-bindgen-macro 0.2.130              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| wasm-bindgen-macro-support 0.2.130      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| wasm-bindgen-shared 0.2.130             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| wasm-encoder 0.263.0                    | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT                                                                                 | Cargo |
| wasm-streams 0.5.0                      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| wasmi 1.1.0                             | MIT/Apache-2.0                                                                                                                      | Cargo |
| wasmi_collections 1.1.0                 | MIT/Apache-2.0                                                                                                                      | Cargo |
| wasmi_core 1.1.0                        | MIT/Apache-2.0                                                                                                                      | Cargo |
| wasmi_ir 1.1.0                          | MIT/Apache-2.0                                                                                                                      | Cargo |
| wasmparser 0.239.0                      | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT                                                                                 | Cargo |
| wasmparser 0.263.0                      | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT                                                                                 | Cargo |
| wast 263.0.0                            | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT                                                                                 | Cargo |
| wat 1.263.0                             | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT                                                                                 | Cargo |
| wayland-backend 0.3.17                  | MIT                                                                                                                                 | Cargo |
| wayland-client 0.31.15                  | MIT                                                                                                                                 | Cargo |
| wayland-protocols 0.32.13               | MIT                                                                                                                                 | Cargo |
| wayland-protocols-wlr 0.3.12            | MIT                                                                                                                                 | Cargo |
| wayland-scanner 0.31.11                 | MIT                                                                                                                                 | Cargo |
| wayland-sys 0.31.11                     | MIT                                                                                                                                 | Cargo |
| web-sys 0.3.107                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| web-time 1.1.0                          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| web_atoms 0.2.6                         | MIT OR Apache-2.0                                                                                                                   | Cargo |
| webkit2gtk 2.0.2                        | MIT                                                                                                                                 | Cargo |
| webkit2gtk-sys 2.0.2                    | MIT                                                                                                                                 | Cargo |
| webpki-root-certs 1.0.11                | CDLA-Permissive-2.0                                                                                                                 | Cargo |
| webview2-com 0.39.1                     | MIT                                                                                                                                 | Cargo |
| webview2-com-macros 0.8.1               | MIT                                                                                                                                 | Cargo |
| webview2-com-sys 0.39.1                 | MIT                                                                                                                                 | Cargo |
| weezl 0.1.12                            | MIT OR Apache-2.0                                                                                                                   | Cargo |
| winapi 0.3.9                            | MIT/Apache-2.0                                                                                                                      | Cargo |
| winapi-i686-pc-windows-gnu 0.4.0        | MIT/Apache-2.0                                                                                                                      | Cargo |
| winapi-util 0.1.11                      | Unlicense OR MIT                                                                                                                    | Cargo |
| winapi-x86_64-pc-windows-gnu 0.4.0      | MIT/Apache-2.0                                                                                                                      | Cargo |
| window-vibrancy 0.8.1                   | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| windows 0.62.2                          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows-collections 0.3.2               | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows-core 0.62.2                     | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows-future 0.3.2                    | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows-implement 0.60.2                | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows-interface 0.59.3                | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows-link 0.2.1                      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows-native-keyring-store 1.1.0      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows-numerics 0.3.1                  | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows-registry 0.6.1                  | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows-result 0.4.1                    | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows-strings 0.5.1                   | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows-sys 0.45.0                      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows-sys 0.52.0                      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows-sys 0.61.2                      | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows-targets 0.42.2                  | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows-targets 0.52.6                  | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows-threading 0.2.1                 | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows-version 0.1.7                   | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows_aarch64_gnullvm 0.42.2          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows_aarch64_gnullvm 0.52.6          | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows_aarch64_msvc 0.42.2             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows_aarch64_msvc 0.52.6             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows_i686_gnu 0.42.2                 | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows_i686_gnu 0.52.6                 | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows_i686_gnullvm 0.52.6             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows_i686_msvc 0.42.2                | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows_i686_msvc 0.52.6                | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows_x86_64_gnu 0.42.2               | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows_x86_64_gnu 0.52.6               | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows_x86_64_gnullvm 0.42.2           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows_x86_64_gnullvm 0.52.6           | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows_x86_64_msvc 0.42.2              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| windows_x86_64_msvc 0.52.6              | MIT OR Apache-2.0                                                                                                                   | Cargo |
| winnow 0.5.40                           | MIT                                                                                                                                 | Cargo |
| winnow 1.0.4                            | MIT                                                                                                                                 | Cargo |
| winreg 0.10.1                           | MIT                                                                                                                                 | Cargo |
| winreg 0.56.0                           | MIT                                                                                                                                 | Cargo |
| wit-bindgen 0.57.1                      | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT                                                                                 | Cargo |
| wl-clipboard-rs 0.9.5                   | MIT OR Apache-2.0                                                                                                                   | Cargo |
| wnaf 0.14.1                             | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| writeable 0.6.4                         | Unicode-3.0                                                                                                                         | Cargo |
| wry 0.57.1                              | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| x11 2.21.0                              | MIT                                                                                                                                 | Cargo |
| x11-dl 2.21.0                           | MIT                                                                                                                                 | Cargo |
| x11rb 0.13.2                            | MIT OR Apache-2.0                                                                                                                   | Cargo |
| x11rb-protocol 0.13.2                   | MIT OR Apache-2.0                                                                                                                   | Cargo |
| xattr 1.7.0                             | MIT OR Apache-2.0                                                                                                                   | Cargo |
| yoke 0.8.4                              | Unicode-3.0                                                                                                                         | Cargo |
| yoke-derive 0.8.4                       | Unicode-3.0                                                                                                                         | Cargo |
| zbus 5.19.0                             | MIT                                                                                                                                 | Cargo |
| zbus-secret-service-keyring-store 1.0.1 | MIT OR Apache-2.0                                                                                                                   | Cargo |
| zbus_macros 5.19.0                      | MIT                                                                                                                                 | Cargo |
| zbus_names 4.3.5                        | MIT                                                                                                                                 | Cargo |
| zcheapstr 1.2.0                         | MIT                                                                                                                                 | Cargo |
| zerocopy 0.8.63                         | BSD-2-Clause OR Apache-2.0 OR MIT                                                                                                   | Cargo |
| zerocopy-derive 0.8.63                  | BSD-2-Clause OR Apache-2.0 OR MIT                                                                                                   | Cargo |
| zerofrom 0.1.8                          | Unicode-3.0                                                                                                                         | Cargo |
| zerofrom-derive 0.1.8                   | Unicode-3.0                                                                                                                         | Cargo |
| zeroize 1.9.1                           | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| zeroize_derive 1.5.0                    | Apache-2.0 OR MIT                                                                                                                   | Cargo |
| zerotrie 0.2.5                          | Unicode-3.0                                                                                                                         | Cargo |
| zerovec 0.11.9                          | Unicode-3.0                                                                                                                         | Cargo |
| zerovec-derive 0.11.7                   | Unicode-3.0                                                                                                                         | Cargo |
| zlib-rs 0.6.8                           | Zlib                                                                                                                                | Cargo |
| zmij 1.0.23                             | MIT                                                                                                                                 | Cargo |
| zune-core 0.5.3                         | MIT OR Apache-2.0 OR Zlib                                                                                                           | Cargo |
| zune-jpeg 0.5.15                        | MIT OR Apache-2.0 OR Zlib                                                                                                           | Cargo |
| zvariant 5.15.1                         | MIT                                                                                                                                 | Cargo |
| zvariant_derive 5.15.1                  | MIT                                                                                                                                 | Cargo |
| zvariant_utils 4.2.0                    | MIT                                                                                                                                 | Cargo |

## npm 生产依赖

| 名称与版本                                 | 声明许可证                       | 来源 |
| ------------------------------------------ | -------------------------------- | ---- |
| @babel/helper-string-parser 7.29.11        | MIT                              | npm  |
| @babel/helper-validator-identifier 7.29.7  | MIT                              | npm  |
| @babel/parser 7.29.12                      | MIT                              | npm  |
| @babel/types 7.29.11                       | MIT                              | npm  |
| @jridgewell/sourcemap-codec 1.6.0          | MIT                              | npm  |
| @lucide/vue 1.66.0                         | ISC (Feather-derived icons: MIT) | npm  |
| @tauri-apps/api 2.12.4                     | Apache-2.0 OR MIT                | npm  |
| @tauri-apps/plugin-clipboard-manager 2.5.0 | MIT OR Apache-2.0                | npm  |
| @types/trusted-types 2.0.7                 | MIT                              | npm  |
| @vue/compiler-core 3.5.44                  | MIT                              | npm  |
| @vue/compiler-dom 3.5.44                   | MIT                              | npm  |
| @vue/compiler-sfc 3.5.44                   | MIT                              | npm  |
| @vue/compiler-ssr 3.5.44                   | MIT                              | npm  |
| @vue/devtools-api 7.7.10                   | MIT                              | npm  |
| @vue/devtools-kit 7.7.10                   | MIT                              | npm  |
| @vue/devtools-shared 7.7.10                | MIT                              | npm  |
| @vue/reactivity 3.5.44                     | MIT                              | npm  |
| @vue/runtime-core 3.5.44                   | MIT                              | npm  |
| @vue/runtime-dom 3.5.44                    | MIT                              | npm  |
| @vue/server-renderer 3.5.44                | MIT                              | npm  |
| @vue/shared 3.5.44                         | MIT                              | npm  |
| @xterm/addon-fit 0.11.0                    | MIT                              | npm  |
| @xterm/addon-search 0.16.0                 | MIT                              | npm  |
| @xterm/addon-web-links 0.12.0              | MIT                              | npm  |
| @xterm/xterm 6.0.0                         | MIT                              | npm  |
| birpc 2.9.0                                | MIT                              | npm  |
| copy-anything 4.1.5                        | MIT                              | npm  |
| crc-32 1.2.2                               | Apache-2.0                       | npm  |
| csstype 3.2.3                              | MIT                              | npm  |
| dompurify 3.4.17                           | (MPL-2.0 OR Apache-2.0)          | npm  |
| entities 7.0.1                             | BSD-2-Clause                     | npm  |
| estree-walker 2.0.2                        | MIT                              | npm  |
| hookable 5.5.3                             | MIT                              | npm  |
| magic-string 0.30.21                       | MIT                              | npm  |
| marked 14.0.0                              | MIT                              | npm  |
| mitt 3.0.1                                 | MIT                              | npm  |
| monaco-editor 0.57.0                       | MIT                              | npm  |
| nanoid 3.3.20                              | MIT                              | npm  |
| perfect-debounce 1.0.0                     | MIT                              | npm  |
| picocolors 1.1.1                           | ISC                              | npm  |
| pinia 3.0.4                                | MIT                              | npm  |
| postcss 8.5.32                             | MIT                              | npm  |
| rfdc 1.4.1                                 | MIT                              | npm  |
| source-map-js 1.2.2                        | BSD-3-Clause                     | npm  |
| speakingurl 14.0.1                         | BSD-3-Clause                     | npm  |
| superjson 2.2.6                            | MIT                              | npm  |
| typescript 6.0.3                           | Apache-2.0                       | npm  |
| vue 3.5.44                                 | MIT                              | npm  |
| zmodem.js 0.1.10                           | Apache-2.0                       | npm  |
