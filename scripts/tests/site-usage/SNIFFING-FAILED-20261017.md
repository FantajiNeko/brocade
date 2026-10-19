# 嗅探失败目标与混合分类验证（2026-10-17）

范围：本地实现，不连接生产或真实网站，不开启机队采集。不是完整吞吐验收；不以短时或受干扰数据承诺零开销。

## 分类规模及来源

44 个平台/公司 + 其他站点/嗅探失败/未识别，共 47 类；7,922 条规则、9 条正则、无关键词；生成 JSON 222,543 字节。运行时只共享一份只读索引，持续传输不再分类。维护入口见 `components/xray-core/common/siteusage/README.md`。

数据来自 MIT 的 v2fly/domain-list-community 固定 release 提交 `ce6ab62747a59a2023412d355315e07b9d4d8c5c`，dlc.dat SHA-256 `405ad108a016ae20c4dfa94cf97384c93ed1bd688121acdc2c5a09c77cca2a4f`。不使用运行时路由资源热更新，也不把它们的发行包许可带入此分类表。

## 微基准（i7-13700，Go 1.26.0，Linux amd64）

所测域名包括 X 图片、YouTube 的 Google 子域、Apple、未匹配域和 Disney 正则专用 CDN。分类约 74–188 ns/op，全部 0 B/op、0 allocs/op（200 ms、三轮）。这只是每条连接的元数据分类，不能换算为所有协议的吞吐差异。

一次索引编译约 2.72 ms，累计分配 2,001,168 B、26,719 次，仅进程初始化时执行；累计分配不等于保留堆或进程 RSS。目标热累加约 5.61 ns/op、0 B/op、0 allocs/op。共享主机样本只说明量级，不替代独占/隔离 CPU 的重复对照。

```sh
cd components/xray-core
go test ./common/siteusage -run '^$' -bench BenchmarkCatalogClassify -benchmem -benchtime=200ms -count=3
go test ./common/siteusage ./app/stats -run '^$' -bench 'BenchmarkCatalogCompile|BenchmarkFailedTargetHotCounter' -benchmem -benchtime=200ms
```

## 真实进程正确性冒烟

`scripts/tests/site-usage/main.go` 新增互斥的 `-failed-targets` 模式；固定分类/其他域名均关闭，只改变独立目标策略。Host 使用 IP 字面量，不提供可分类 DNS 域名；目标、客户端与 Xray 均在本机。E 单核、4 连接、两秒预热 + 一秒观察，上传/下载各开/关一次：关闭目标字节为零，开启增长，无传输错误。

本次保留的目录为 `/tmp/brocade-site-bench-2224644733`、`/tmp/brocade-site-bench-171315009`、`/tmp/brocade-site-bench-2765063232`、`/tmp/brocade-site-bench-4202887215`，只含假身份/回环端口。当时存在编译和 SMT 兄弟外部负载，**不比较这些吞吐值，不据此计算回归百分比**。P/E 单核及多核完整网络矩阵仍需空闲窗口另行验收。

单测另验证 IPv4/IPv6、不同 TCP/UDP/端口、原始目标而非代理下一跳、嗅探关闭/已识别域名排除、跨小时复用、1024 候选限制、独立预算、关闭后无索引、通用计费查询不泄漏原始 IP，以及专用查询不可 reset。

## 其他检查

相关 Go 包 race/vet、Rust all-targets 严格 Clippy、Agent/共享协议测试、隔离 PostgreSQL 有界幂等/权限/兼容 SQL/属主与 HTTP no-store 测试、前端完整测试及构建通过。

额外的 core 全包 race 检查没有通过：未改动的 UDP 测试服务 `accepting` 字段在启动 goroutine 与 Close 之间存在读写竞态（`testing/servers/udp/udp.go:35,52`）。这不是相关统计包的 race 失败；不把该检查算作通过、不在本轮混入修复。也未把任何未运行的 ignored 原生场景或全 workspace 检查计为通过。
