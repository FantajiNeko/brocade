# 其他域名观测：有界性与性能检查

本功能默认关闭。默认 Top 128、每节点每用户 1024 个候选、节点总容量 4096、30 秒上报；这些数值均可在全局设置修改，范围和语义见仓库 README。这里只测本地虚构身份与 `.example` 域名，不访问真实网站或生产 Console。

## 数据面与存储约束

- 热计数为原子累加；复用同一入口身份／域名计数对。当前与上一小时最多各 4096 对，持续候选索引另受 4096 总容量约束，不预分配每用户容量。
- 跨小时活动连接重新绑定到新窗口；不在每次字节累计时读取时钟、写日志、查询数据库或创建异步任务。关闭后不创建域名计数对象。
- 冷准入用 TryLock，遇争用／容量不足跳过辅助观测并置受限标记；格式化和排序快照不持有该锁。已有流跨小时重新准入时，容量拒绝记到窗口结束、临时争用最多每五秒重试一次，避免满容量下逐块分配／争锁。
- 专用查询返回域名数据，普通 `QueryStats("")` 不包含域名。Agent 独立线程最多保留一个快照、一个上报载荷及当前／上一小时的已确认计数缓存；成功后只发送变化的行，空报告仍更新覆盖状态。不使用持久化离线队列。
- Console 批量 UNNEST 写入，按累计头取差值、按节点独立锁实现幂等。跨进程重启保留既有小时数据，服务器同时限制同节点同小时的新归属／域名键，避免用更换 epoch 绕过容量。
- 域名仅规范化为 ASCII/Punycode DNS 主机名，最长 253 字节；入口标签最长 256 字节。拒绝 IP、URL、端口、路径和无效标签。长名字会增加冷路径和快照开销，容量限制不是 RSS 的硬字节承诺。
- 仅对已采集域名作精确字节排序。达上限后不会推算未采集域名流量，页面明确提示排名不完整。容量不是“全球全部域名准确 Top N”的保证。

## 已运行的检查

受影响 Go 包 test/race/vet；DNS 规范化、每用户跨入口容量、小时连续性、闲置淘汰、并发窗口切换、关闭和只读专用查询。Rust Agent／Store／共享协议单测与 Clippy；隔离 PostgreSQL 并发／重复上报、冻结归属、跨 epoch 累加、默认关闭、权限、策略校验及过期清理；HTTP 无认证／非管理员／跨租户拒绝和 no-store。前端覆盖预算表单、管理员控制、展开明细、范围切换保持面板，以及同一查询缓存切换用户时不保留上一用户域名。

额外扩大的 Go `core -race` 检查在原有 UDP 测试服务器 `testing/servers/udp/udp.go` 的关闭／处理协程之间发现竞态；本功能相关包和版本能力声明定向 race 检查通过。没有修改该测试服务器。

## 微基准（共享桌面主机，不能作为容量验收）

主机 i7-13700，Go 1.26，分别绑定 CPU 4（P）与 16（E），GOMAXPROCS=1，500 ms × 3。执行期间还有构建／浏览器负载，不比较 P/E 优劣，也不将快照耗时换算成确定的生产吞吐损失。

| 项目 | P 核实测范围 | E 核实测范围 | 每次分配 |
| --- | --- | --- | --- |
| 复用域名热计数 | 5.31–5.42 ns | 6.76–6.92 ns | 0 B / 0 alloc |
| 关闭状态判断 | 3.69–4.09 ns | 4.66–4.76 ns | 0 B / 0 alloc |
| 8192 对的双小时快照 | 8.01–8.32 ms | 10.7–18.0 ms | 约 3.35 MiB 临时分配 |

快照夹具使用较短虚构标签／域名，分配量不是最长名字场景的上限，也不包括 gRPC 编码、Agent 解析或 TLS／数据库成本。热计数零分配不表示新连接／快照零分配。默认 30 秒的快照频率可调；高基数小内存机器应调低节点容量。

表格原始日志为 `/tmp/brocade-other-domain-micro-final-p1.log` 与 `/tmp/brocade-other-domain-micro-e1-sequential.log`。初轮日志 `/tmp/brocade-other-domain-micro-p1.log`、`/tmp/brocade-other-domain-micro-e1.log` 也保留，其时序波动再次说明不能用共享主机比较小差异。一次尾轮 E 核微基准与同核回环测试重叠，`/tmp/brocade-other-domain-micro-final-e1.log` 因明确的 CPU 冲突作废，不进入表格；随后在回环测试结束后单独重跑。没有按吞吐高低筛选样本。这些文件均不是生产数据。

## 真实进程冒烟与后续复测

同一受管 Xray 二进制、相同 VLESS／计费／嗅探配置，固定站点采集在两边均关闭，只改变独立域名开关。目标端和客户端始终为回环地址，Host 为 `video.benchmark.example`。已执行 E 核单核、16 连接、上传／下载开启关闭各一次，验证关闭时域名字节为零、开启时增长；输出无传输错误。初轮日志为 `/tmp/brocade-other-domain-network-smoke.jsonl` 与同名前缀 `.log`；末尾代码再跑的 `/tmp/brocade-other-domain-network-final-smoke.jsonl` 同样通过开关／传输正确性检查。这些 3 秒短样本与编译或同核微基准重叠，只作为真实进程功能冒烟，不得用于计算性能回归百分比。

前端完整测试为 108 文件、949 项通过，严格 lint、TypeScript 与构建通过。本次新增及修改的界面文件格式检查通过；全量 `format:check` 仍指出 `panes/deploy.tsx`、`panes/nodes.tsx`、`xray-handoff.ts` 三个非本功能脏文件，没有替其他工作格式化。当前会话没有可用的浏览器自动化工具，因此未新增真实浏览器／移动设备截图验收；本地示例页已加入保留域名的假数据，原浏览器和 Vite 保持不动。

可复现命令：

```sh
cd components/xray-core
GOCACHE=/tmp/brocade-go-build-cache go test -c -o /tmp/other-domain-stats.test ./app/stats
GOCACHE=/tmp/brocade-go-build-cache go build -o /tmp/other-domain-xray ./main
taskset -c 4 env GOMAXPROCS=1 /tmp/other-domain-stats.test -test.run='^$' -test.bench=BenchmarkOtherDomain -test.benchtime=1s -test.count=3
cd ../..
GOCACHE=/tmp/brocade-go-build-cache go build -o /tmp/other-domain-bench scripts/tests/site-usage/main.go
/tmp/other-domain-bench -xray /tmp/other-domain-xray -other-domains -profiles p1,e1,p4,e4 -seconds 8 -repeats 3 -connections 32
```

后续在空闲、隔离端点、核对 CPU 拓扑与干扰的环境执行完整矩阵，另测大量域名／短连接、最长名字、Agent 上报与 Console 写入负载。以上微基准和短冒烟不替代该验收；本轮不部署、不打开生产采集。
