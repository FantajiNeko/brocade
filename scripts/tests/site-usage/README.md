# 站点统计开启／关闭性能对照

独立的用户 × 其他域名 Top N 预算、测试记录与复测命令见 [其他域名检查](OTHER-DOMAINS-20261017.md)。它与下文固定预设分类的测量是两个独立开关。

`-failed-targets` 改为独立测量用户 × 嗅探失败原始 IP 目标，与 `-other-domains` 互斥；固定分类和其他域名均关闭。仍只连接本机，HTTP Host 使用 IP 字面量，故没有可分类的 DNS 域名。专用快照必须在开启时增长、关闭时为零。短时样本仅用于真实进程正确性冒烟；不能以编译或其他任务并行时的结果判定性能差异。

2026-10-16 的初测记录见 [测量说明](RESULTS-20261016.md) 和 [原始数据](results/20261016.json)。该次共享主机存在干扰，不能作为全机队性能承诺。

异步注册、计数器复用与分类索引的优化前后对照见 [优化记录](OPTIMIZATION-20261016.md)，它是微基准与慢盘正确性验证，不替代端到端吞吐验收。

只在 Linux 本机回环地址创建测试连接，不连接 Console、生产节点或真实网站。固定 HTTP Host 仅供本地嗅探，目标始终是本地 TCP 服务。不会修改 CPU governor、宿主机服务或其他进程亲和性。

```sh
cd components/xray-core
GOCACHE=/tmp/brocade-go-build-cache go build -o /tmp/brocade-site-usage-xray ./main
cd ../..
go build -o /tmp/brocade-site-usage-bench scripts/tests/site-usage/main.go
/tmp/brocade-site-usage-bench -seconds 8 -repeats 3 -connections 32 > /tmp/site-usage.jsonl
```

默认 CPU 编号针对 i7-13700：P 核为 `0-15`（相邻编号是 SMT 兄弟），E 核为 `16-23`。在其他机器运行前必须按 sysfs 拓扑调整源码中的 profile，确认 `getconf CLK_TCK` 是 100。可用 `-profiles p1` 等限定场景。

| profile | Xray CPU / GOMAXPROCS | 客户端 CPU | 目标端 CPU |
| --- | --- | --- | --- |
| p1 | 4 / 1 | 8,10 | 12,14 |
| e1 | 16 / 1 | 8,10 | 12,14 |
| p4 | 0,2,4,6 / 4 | 8,10 | 12,14 |
| e4 | 16,17,18,19 / 4 | 0,2,4,6 | 8,10,12,14 |

每组上传、下载分别执行，开启／关闭顺序按轮次交错，每次新进程、独立 journal。两边均启用相同计费、嗅探、路由与 stats API，仅私有采集控制文件的 `0/1` 不同。使用无 TLS 的 VLESS，以免加密成本掩盖计数热路径；这不是 AnyTLS/kTLS、UDP 或公网容量测试。

连接共用一个已认证用户，固定分类为 YouTube，故多核会包含同一用户计数的热点争用。两秒预热后计时；下载量由客户端读取，上传量由目标端读取后确认，不使用发送端已入队字节。首尾不足一个读块的窗口误差有界。测试日志与配置保留在输出标注的 `/tmp/brocade-site-bench-*` 目录，包含本地随机端口和固定假身份，无真实用户数据。

JSONL 包含已交付吞吐、Xray 实际 CPU 时间／GiB、CPU 占用、采样峰值 RSS、客户端／目标端 CPU 及逐核占用。开启时额外验证站点计数增长，关闭时验证没有站点字节。单核跑满时可比较 CPU 瓶颈吞吐；多核若未跑满，必须检查端点能力和热点争用，不把结果解释为所有协议的极限容量。RSS 是进程 RSS，不等于独立映射文件大小或整体主机内存增量。

`taskset` 不等于整机独占：应同时检查 SMT 兄弟及未分配核心的占用，标记并重跑其他负载污染的样本，完整保留原始记录，不能按结果高低选择样本。至少报告每组中位数和范围。不要把共享桌面主机上小于试验波动的差异宣称为确定提升或零开销。

微基准另见 `components/xray-core/app/dispatcher/site_usage_bench_test.go`，使用真实 mmap 计费／站点计数、开启门控和并发同用户争用；它度量的是计数热路径而不是网络吞吐：

```sh
cd components/xray-core
taskset -c 4 env GOMAXPROCS=1 GOCACHE=/tmp/brocade-go-build-cache go test ./app/dispatcher -run '^$' -bench 'BenchmarkSiteCounter|BenchmarkSiteClassify' -benchtime=1s -count=3
```

`BenchmarkSiteConnection` 额外覆盖每条新连接的分类元数据与分配，不含首次注册分类的持久化操作。汇总时同时保留全部数据与基于独立核心占用筛选后的整对数据：

```sh
node scripts/tests/site-usage/summarize.mjs /tmp/site-usage.jsonl
node scripts/tests/site-usage/summarize.mjs scripts/tests/site-usage/results/20261016.json
```

## 优化前后微基准

`compare-micro.mjs` 对比两个预先构建的 Go 测试二进制；计时期间不编译。分别在对应代码版本中执行下面的构建命令，给产物使用不同名称，并记录源码版本／工作区差异。不要为测试回退共享工作区或覆盖其他任务的改动。

```sh
cd components/xray-core
GOCACHE=/tmp/brocade-go-build-cache go test -c -o /tmp/site-before.test ./app/dispatcher
# 优化版本使用相同工具链和构建选项，输出到 /tmp/site-after.test。
cd ../..
node scripts/tests/site-usage/compare-micro.mjs /tmp/site-before.test /tmp/site-after.test
```

脚本使用上表的四种 Xray CPU／GOMAXPROCS 组合，各执行三轮交错对照；输出原始日志、二进制 SHA-256、逐核占用和解析后的 `results.json`，默认保存在新的临时目录。此处没有客户端／目标端进程。其他机器先核对并调整脚本里的 CPU 拓扑。单核 P 核额外比较分类索引；其余 profile 测计数和新连接元数据。预热分类注册完成后才计时，故首次注册的磁盘开销不混入稳态连接数据。

可用 `SITE_MICRO_PROFILES=p4,e4 SITE_MICRO_ROUNDS=7 SITE_MICRO_BENCH=BenchmarkSiteCounter` 定向补测；轮次限制为 1–20，未设置时使用完整默认矩阵。补测独立保存，不覆盖首轮结果，也不只挑有利样本。

`BenchmarkSiteCounter` 使用真实持久化计数器，包含单用户多核争用，不能按多核数推导线性吞吐。`BenchmarkSiteConnection` 不包含 socket、TLS 或网络传输。慢盘不阻塞、队列容量、并发注册、失败恢复和退出预算由 `app/stats/site_registration_test.go` 单独验证。微基准的提升不能等同于真实网络吞吐提升，仍需空闲窗口执行上面的端到端对照。
