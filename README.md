# brocade

brocade 是面向自建多地域网络的声明式控制系统。它以统一模型描述节点、链路、代理组件、路由规则与用户授权，并将模型编译为各节点所需的配置产物。控制面不向节点发送一次性操作命令；节点上的 agent 持续获取期望状态、观测本机状态，并使二者收敛。

该设计主要关注三个性质：配置生成的确定性、发布过程的可审计性，以及控制面与节点失联时的数据面自治。brocade 适合需要集中管理多台网络节点，同时要求变更可预览、可分批发布并可追溯的场景。

> brocade 会生成网络服务配置，并由 agent 在节点上执行具有系统权限的收敛操作。将其用于生产环境之前，应当独立审查生成的配置、访问控制和部署边界。

## 设计概述

### 确定性编译

系统以一份完整的模型快照作为编译输入。编译过程不访问数据库、文件系统或外部服务；在版本与输入相同的条件下，输出产物按字节保持一致。核心数据流如下：

```text
ModelSnapshot → 中间表示（IR）→ 节点产物 → 期望状态 → Agent 收敛
```

基准产物作为测试夹具纳入版本控制。编译器发生修改时，测试会直接呈现产物差异，从而区分预期的语义变化与非预期回归。相同机制也用于发布前预览和历史修订的重新编译。

### 模型与拓扑

一个快照包含节点、用户、外部出口和应用。节点记录地址、密钥及运行参数；应用包含链、入口、转发步骤、规则与授权。每个中转监听由 `(chain, node)` 唯一拥有自己的端口、安全参数和有序规则表；其它规则可以引用这个身份并进入整棵规则子树，但不会复制端口或规则。链路路径不作为独立状态重复存储，而是由入口位置、逐跳转发规则和显式监听引用推导得到。由此，拓扑成为规则的确定性结果，避免两套表示之间产生一致性偏差。

### 修订与发布

会改变机器产物的编辑首先写入草稿，提交后形成不可变修订；名称、展示顺序、用户以及只影响未来对象或下一轮任务的设置则保存即提交。一次界面操作可以原子地修改多张关系表，而不必暴露中间状态。发布以特定修订为输入，并按影响范围划分为若干波次；包含破坏性操作的波次必须由操作者确认后才会继续。

配置发布与授权发布相互独立。配置发布中的 Xray 更新只允许热切或代际交接；条件不足时保留旧进程并让目标失败，不会静默退回断流重启。授权发布只更新运行中的访问主体，因此仍具有不同的风险和执行代价。回滚不会修改既有修订，而是以历史修订为目标创建一次新的发布，以保留完整的因果记录。

普通 VLESS 出站仅调整目标地址或端口时，Agent 通过临时出站和路由表完成 API 热更新，最终恢复原标签，保留进程与已有 TCP 连接；默认出站、反向隧道和其它未支持的结构变化仍需交接。公网中继沿用原来的地址族规则：存在 IPv6 直连时监听 `::`，仅 IPv4 直连时监听 `0.0.0.0`；实际监听地址变化仍走代际交接。启用新的计划分类前须先完成配套 Agent 更新。

授权变更与自动发布任务在同一事务中入库。提交时从前后两个已保存快照复用编译缓存，通过授权专用投影比较账户，不生成完整节点配置或计算发布波次；入口迁移、协议、Flow、撤权及节点退役仍参与比较，不可发布模型仍保守排入待收敛任务。只要有任务到期，后台就把全部待处理权限任务（包括退避中的旧任务）合并到最新修订；已有授权单未落地时继续等待，不提前判定“无需下发”，也不修改已经下发的名单。等待不计为失败重试；暂停的授权单需要先由操作者处理。用户页的每张授权卡独立等待写入后的快照修订确认，刷新失败时保持禁用并提供重试；拨测面板在当前用户修改授权后的 60 秒内每 3 秒重读 Serving 计划，之后停止自动刷新。授权卡上的已保存状态不代表节点已执行完成。

system-admin 可直接从机器详情的更多操作中隔离 active 机器，无需等待某次发布出现目标行。隔离会立即把机器从服务视图和可接入节点中摘除；若机器同时处于一个或多个发布中，相关目标会在同一事务中转为隔离待补偿，已经下发或失败的现场状态会标记为不确定并重新生成完整期望。Agent 在隔离期间仍领取并收敛最新债务；只有债务清零、轮询与运行上报新鲜且各运行组件均已确认后，机器详情才允许人工恢复服务。

Agent 和 Xray 可执行文件不属于模型修订。发布页共用二进制发布单结构，冻结组件、当前 Console 内嵌的双架构摘要、明确的机器名单与更新前摘要。建议先为灰度机器创建一单，观察完成后再为其余机器创建新单；不会因部署 Console 或后来加入机器而自动更新机队。每次重试保存独立证据，历史按需分页读取，只保存元数据而不保存历史二进制，也没有历史单内回滚入口。后续上传覆盖会接入当前产物目录，本版尚不提供上传入口；目前人工回退仍需部署携带所需字节的 Console，再创建新单。

Agent 替换前持久保存回执，重启后恢复轮询与运行上报且摘要匹配才确认成功；旧 Agent 首次升级缺少执行回执时明确标为“观测确认”。Xray 仍独立执行大小、摘要、版本和当前配置预检，在收敛安全边界替换，验证监听和运行摘要；失败时本地恢复原字节。仅正在运行受管 Xray 且摘要一致的节点可加入 Xray 单。任一执行失败会暂停未领取目标；领取后失联的目标在租约到期后可人工重试。停止不是回滚，迟到结果仍留存；节点离开 active 生命周期会停止相关发布，永久删除节点也不删除历史证据。安装器将确定的 Xray 路径写入 `BROCADE_XRAY_BIN`，兼容旧安装时优先识别 Agent 同目录的 `xray`。具体门槛见[发布手册](.agents/runbooks/release-and-rollback.md)。

用量以日账本和计数器最新基线为准，不依赖逐笔历史重新计费。逐用户明细只保存非零流量或
缺口事件，正常零流量窗口不再逐用户落盘；机器曲线改读独立的机器/租户/原始时间点投影，
保留真实零点和原有精度，不插补缺失上报。明细接口因此不是完整采样时间线。机器投影与
剩余用户/链路明细仍保留 7 天，日账本长期保留。原始累计读数只保留最近 24 小时的排错
历史，每分钟最多清理 50,000 行，首次缩短保留期时渐进追赶；正常运行下清理有约一分钟
调度延迟，故障或积压时可更长。它不影响最新计数基线、账本和曲线；代价是无法再用超过
24 小时的原始计数快照逐笔复核。幂等回执独立保留 7 天，不随原始读数一起缩短。

### 节点自治与观测

Agent v28 与对应受管 Xray 支持跨进程的用户 / 转发累计计数，配置重启不再清空尚未
上报的值；splice 每次内核传输后递增。已确认的重启停机区间单独上报为零窗口，未知
采集缺失仍断开。近一小时用户图按真实采样时长重采样，不改写计费；队列满或采集落盘
失败时保留检查点并暂缓破坏性操作。兼容、存储上限和回滚边界见
[配置重启的连续用量](.agents/runbooks/console-deployment.md#配置重启的连续用量)。

主机指标与网卡累计流量计使用独立采样线程：指标仍每 10 秒采集、每 30 秒汇总，完成的指标窗口先进入私有磁盘队列，再由独立线程上报；队列只保留最近 120 个窗口（约一小时），Console 短暂停机后按时间顺序补报，重复窗口由数据库键去重。流量计独立每 10 秒原子持久化。运行状态报告只读取成功落盘后的内存快照，不触发流量采集或写盘；超过 30 秒的旧快照不再携带，恢复后用累计值补回已知流量。正常退出由流量线程完成最后一次持久化。磁盘慢写不会通过流量计锁阻塞指标采样；异常轮次会记录采集耗时、调度延迟及缺口原因，但真实主机停顿、磁盘队列写入失败或 Console 不可达超过一小时仍可能造成指标缺口。

agent 接收期望状态，而非待执行的命令序列。它将期望状态与本机实际状态比较，仅在存在偏差时执行操作，并将收敛结果回报控制面。最近一次期望状态会保存在节点本地，因此控制面暂时不可达时，节点仍能发现并修正本机漂移。

除配置收敛外，agent 还负责上报用量与运行指标、执行链路探测，并给出路径 MTU 建议。用量按固定窗口累计，配额状态的变化会触发相应的授权调整。机器观测最近约 1 小时保留原始 30 秒窗口，较早历史逐步按分钟聚合，保留期仍为 7 天；超过 1 小时的历史查询统一分钟粒度，最新状态和告警仍使用原始上报。聚合保留峰值、事件总数和真实断档，容量/内存组成取末次快照，Ping 与计费用量不受影响。磁盘面板针对 agent 状态目录所在文件系统，区分容量、inode、块设备吞吐、IOPS、完成延迟、队列与 I/O PSI；网络面板除连接与内核错误外，还按真实匿名端口范围估算最繁忙目标的出站端口压力。目标地址只在节点内参与聚合，不会上报控制面。兼容与不可逆边界见 [Load 分钟历史](.agents/runbooks/console-deployment.md#load-分钟历史有损)。

机器详情观测页的时间范围写在地址栏：默认近 1 小时不写参数，其余快速范围为 `?range=6h`，固定区间为 `?from=<unix 秒>&to=<unix 秒>`（1 分钟–24 小时，参数不合法时按近 1 小时显示）。在任一图表的绘图区按住左键横向拖动，松开后整页切换到所选时段；起止按图上一个像素对应的时长取整，不足 1 分钟按 1 分钟补足。双击图表把范围扩大一倍，结束不晚于当前时间，最长 24 小时。每次切换写一条浏览器历史，前进、后退、刷新和复制链接都保留所选时段；时间按钮左侧的返回按钮与浏览器后退相同。固定区间不自动刷新，在时间菜单选择快速范围即恢复实时；触屏不启用拖选。

Ping 探测目标在设置页按 ICMP / TCP 分类，每个目标有 IPv4、IPv6 两个地址栏，至少填写一个，留空的地址族不探测。地址栏填写该地址族的 IP 或域名，域名只取该族记录（A 或 AAAA）；TCP 写作 `主机:端口`，IPv6 地址写作 `[地址]:端口`。Agent 按地址族分别解析并行探测，各自计时；机器没有该地址族的路由、域名没有该族记录或解析失败时，样本记为未探测并附原因，不计作丢包。Agent 协议 v24 之前的节点只收到 IP 字面量地址，域名目标在节点升级前没有样本。

机器详情的 Ping 面板一次只显示一个地址族，由面板右上角的地址族开关切换，ICMP PING 与 TCP PING 两张图同时切换；没有填写或机器没有路由的地址族不可选，另一族在所选时段有丢包时开关上显示圆点。图例显示当前所选时段、当前地址族的丢包率，即已实际发出的探测中未响应的比例；未发包与缺少上报不计入分母，没有有效探测时显示 `—` 或未探测原因。部分丢包为金色，已探测的全部无响应为红色。曲线在丢包处断开，x 轴下方的红色细条标出丢包时段；悬浮提示显示毫秒延迟，无响应为红色。切换时间范围时图例同步重新统计，复用已有历史数据，不增加请求。机器卡片的 TCP 读数优先取 IPv4，最新一轮无响应显示红色「—」，IPv6 最新一轮无响应时读数后追加红色「v6」。

实时网卡速率是第三条独立通道：Agent 主动维持到控制面的 WebSocket，无浏览器查看时只保活、不采样；查看机器或机器总览时，控制面下发临时租约并按全局 1/2/5 秒配置采样，最后一个查看者离开 15 秒后停止。控制面只保留每台机器最近 120 秒、最多 600 点的内存环，进程重启即可丢失，不写数据库、不进入离线重放，也不改变诊断和用量的 30 秒口径。浏览器仅通过控制面的 SSE 读取数据，永远不连接 Agent，也不会收到节点地址或节点令牌。

「用量 → 实时」的机器 × 用户速率矩阵允许访客只读访问，沿用站点的访客开关、租户范围与资产脱敏。快照和 SSE 均只返回可见范围内的接入、转发速率及网卡读数，不返回机器诊断；公开读取不开放实时设置、凭据、目的站点／域名／地址明细或下述用户历史明细。矩阵仍公开用户、租户和机器的名称或标识、关联及当前速率，不是匿名统计；资产地址沿用掩码。

机器详情和用户详情的「用户实时流量」向已登录的操作者开放，包括只读、编辑、发布者、租户管理员与系统管理员。Agent v29 按同一实时频率读取入口 Xray 的接入用户与转发规则累计计数器，保持 `reset=false`，用本地两次读数计算上下行速率；机器页按用户汇总，用户页汇总该用户当前授权的所有入口机器。带租户范围的操作者仅可读所属租户子树，普通用户与访客不能获取。控制面合并并发观察需求，再按每个请求的权限过滤输出；用户速率只保留最新内存报告，关闭页面后随观察租约停止，不进入计费或历史。旧 Agent 明确显示未支持；断线、采样失败、计数器重置和截断不会冒充正常零流量。转发按规则所属租户、用户和机器归属合计，并保留来源分类；中继、出口不提供最终用户身份。旧 Agent 只有接入统计时明确提示转发实时待升级。卡片打开时另读近 1 小时的真实计费窗口（`GET /realtime/nodes/{node_id}/user-history`、`GET /users/{tenant_id}/{user_id}/realtime/history`，权限与实时接口相同），画成合计图和每行走势，之后每 30 秒重读；当前速率只显示为读数，与历史分开呈现。未采集的窗口在图上断开，不画成 0。出现过的行保留到离开页面，实时通道断开时保留最后一次读数并提示；默认按名称排列，选择按下行、上行或近 1 小时用量排序后每 5 秒重排，指针停在列表上时暂停；支持按名称或租户搜索。用户详情的入口机器排成多列紧凑格，每项两行：名称与用量，走势与当前下行、上行。机器详情的布局见下段。

机器详情的「流量」页签依次是实时流量、统计范围、流入统计与流出统计，权限同上。实时流量的读数栏给出本机当前合计、上下行与当前经过的接入链，右侧是本机近 1 小时 30 秒窗口走势，下方是用户 × 接入面的当前速率网格：用户固定在左侧，接入面名称斜排在顶部，格子按固定 Mbit/s 档位着色，右侧为用户合计、底部为接入面合计，悬停、键盘聚焦或点选查看当前上下行，点用户也可查看近 1 小时用量；空闲、无读数与未授权分别标记，窄卡在网格内部横向滚动；默认按名称排列，按当前速率排序后名次只在确认重排时更新。统计范围是 UTC+8 的当天、周一起的当周与当月，只作用于下面两张卡。流入统计用流向图显示用户经哪些接入链（含本机端口转发）进入本机，带宽与字节成正比，卡片窄于 720px 时改为排行条形；中继、落地流量没有用户身份，不在此列。接入链取自记账窗口写入时的入口归属，之后调整模型不改变历史；按接入链统计上线前的流量列为「未按接入链记录」，不估算。流出统计把本机认证代理流量按目的站点归类，点站点可看主要用户，不含端口转发。接口为 `GET /nodes/{node_id}/inflow-usage`、`/site-usage`、`/other-domains`、`/sniffing-failed-targets`，参数 `period=day|week|month`，均不缓存；已有数据库须先执行兼容脚本，见 Console 部署手册。

机器配置中的「流量统计」另行记录默认路由网卡的累计接收与发送字节，并与 Xray 用户/中继用量同时展示。Agent 每 10 秒把逻辑累计值原子写入私有状态文件，进程重启沿用原值；整机重启时保留累计值并接入新 boot 的内核计数。异常断电、网卡替换、计数倒退或状态文件丢失时不会猜测缺少的字节，而是把该边界标为缺口；控制面跨 UTC 日期长时间失联时，绝对累计值仍会补回，但无法精确拆分到可能经过的重置边界，也会标出缺口，供操作者以当前总量校准建立新锚点。月度或年度重置均以 UTC+0 的 00:00 为界；当月不存在所选日期时取月末。重置策略与校准属于运行态账务设置，不进入模型修订，也不触发发布。

用户转发的域名由入口 Xray 在新连接建立时解析，并在 TCP 拨号前、UDP 发送前校验实际目标 IP；显式禁止私网、环回、链路本地、云元数据及特殊地址。Agent 不做阻塞式 DNS 预检查，按 15 秒周期先移除撤销的监听，再独立增改规则，单条失败不阻止其他规则收敛。界面的「已监听」只表示入口安装完成，不代表目标可达；DNS 缓存仍按节点策略生效，已有 TCP 连接和持续 UDP 会话不因 DNS 变化强制迁移。带 `forwarding-close-connections-v1` 能力的 Xray 在移除 `fwd:` 监听时同时取消并关闭该监听的现有 TCP 连接；普通接入维持原排空语义。

此修复需要分别发布 Xray、含显式 `ipsBlocked` 的新配置，以及 Agent；先完成 Xray 和配置，再升级 Agent。新版 Agent 遇到缺少安全策略的配置会停止安装转发并清理旧监听，报告需要发布安全配置。Console 应先更新，以接收撤销失败后仍有残留监听的错误回报；只升级 Console 不代表节点侧修复已生效。回滚 Agent 不应同时撤掉 Xray 的地址防护。

转发用量保留独立事实账本，与接入账本按查询边界合计：用户本月、用量页每日/月累计、机器 XRAY 月量/角色曲线和容量预测均纳入转发；物理网卡账本已经包含转发，不能再叠加一次。规则移机、撤销或删除不删除历史归属；收据指纹、持久计数头与顺序检查保证重放不重复记账，Agent 实例变化不重置连续计数。细窗口可清理，日汇总持续保留；首读、同秒尾部和旧数据没有实际区间时只显示总量，不伪造曲线。按线路的订阅额度维持接入口径。已有部署的兼容、独立 Agent 29 发布和回滚边界见[部署手册](.agents/runbooks/console-deployment.md#转发统一统计兼容)。

系统管理员和所属租户管理员可在用户详情「转发」的机器菜单中设置独立的月度流量配额（GiB，留空不限制）。按用户 × 机器、UTC+8 自然月累计上下行，删除规则不会清除已用额度，也不占用线路接入配额。Console 每 60 秒评估，修改配额后立即唤醒评估；耗尽时用持久 `forwarding-quota` 工单暂停该用户在该机器上的全部转发，调高或取消额度、进入新月份后自动恢复。暂停层不改写规则的手动开关；已禁用、删除、撤销授权的规则不会自动开启。工单分页可查，节点离线或移除失败时保留待执行/错误，只有匹配当前完整期望状态的节点回执才能确认完成，更新意图会取消旧待执行工单。计量上报、后台评估和节点收敛均有间隔，不是逐字节硬限额；配置/Xray 交接期的旧进程也须完成排空，暂停不能视为瞬时全局断流。

接入配额沿用授权自动化工单和 Agent 的 `SyncGrants`。带 `user-session-revocation-v1` 的 Xray 在移除授权时，VLESS 会取消并关闭该入站、该授权的现有 TCP/复用载体（含 Vision），Hysteria2 会关闭该用户的整个 QUIC 会话及其 TCP/UDP 流；AnyTLS 和 MTProto 保留既有按用户关闭语义。不关闭共享监听、不重启 Xray，其他用户及另一入站的同名授权不受这次撤权影响，累计计量不重置。认证和撤权竞争时会重新核对授权实例；重新授权只允许新会话，不复活旧载体。纯静态 Hy2 密码配置保持兼容，但动态用户全部撤销后不会回退到静态密码。VLESS UUID 和 Hy2 auth 在同一入站内必须唯一，拒绝以另一个用户身份覆盖现有凭据。

这项接入修复须单独发布 Xray；Console/Agent 的授权协议无需改变，也不能仅凭升级 Console 声称旧连接已关闭。计量、后台评估、工单和交接/离线等待仍决定实际延迟；配置交接期间既有授权队列的等待策略不变，不承诺瞬时硬限额。调高配额或跨月后，授权工单恢复访问，客户端重新连接；回退旧 Xray 会退回其原有撤权语义，不会复活已经关闭的套接字。

现有数据库需在备份及隔离恢复演练后使用 `scripts/compat-forwarding-quota.sql` 应用目标 `0001_init.sql` 中的 `BEGIN/END FORWARDING QUOTA SCHEMA` 块，并单独核对 SQLx 兼容与对象所有权；脚本不设置额度、不删除历史。启用前必须独立发布并验证带上述连接关闭能力的 Xray，不能只升级 Console 后声称已有 TCP 会话也已停止。回滚 Console 不会自动解除已下发的配额暂停，应先取消配额并等恢复工单成功，或使用支持该暂停层的版本恢复；不得清空用量、作业或手动状态来回退。

节点日志默认有界：设置页配置全局上限（Agent 20 MiB、Xray 20 MiB、每个 Phantun 实例 10 MiB，三类最低均为 10 MiB），机器可单独覆盖；清除覆盖后会继续继承全局值。Agent 每轮轮询直接取得最终值，不需要创建修订或发布线路。systemd 节点使用独立 journald namespace；OpenRC（Alpine）节点写入 `$BROCADE_AGENT_STATE_DIR/logs/agent.log`；Agent 拉起的 Xray 与每个 Phantun 实例也分别写入该 `logs` 目录。每个日志项的当前段与前一段合计不超过生效上限，降低上限会在线截断已有分段，不重启 Xray/Phantun。systemd 上使用 `journalctl --namespace=brocade-agent -u brocade-agent` 查看 Agent 日志，OpenRC 上使用 `tail -n 100 $BROCADE_AGENT_STATE_DIR/logs/agent.log`。不要删除仍被进程打开的日志来释放空间；有界 sink 会自行滚动。

Ping 链路探测最多保存 6 个目标，IPv4 和 IPv6 分别配置。设置页按“北京 → 上海 → 广东 → 重庆”提供方案，每组填入电信、联通、移动各一组 TCP（80 端口）与 ICMP 双栈地址，点击保存后才生效，不改变巡检周期和单次超时。已保存的目标照常读取，不会自动套用方案。北京使用百度和微信静态资源 CDN，上海使用 QQ 首页 CDN，重庆使用腾讯视频和微信头像 CDN；北京、上海、重庆地址于 2026-10-19 按 ITDOG 当地测点延迟核对，不能仅凭 IPv6 地址库的位置标注判断物理位置。

机器公网 IP 观测复用设置页的端到端探测落点。Agent 按同一间隔并行强制 IPv4、IPv6 直连该 CGI Trace 地址，从 `ip=`/`loc=` 取得两族事实，再分别上报 Console；没有 IPv6 不会阻塞或清空 IPv4。它不使用 Agent 请求的 `X-Real-IP`、`X-Forwarded-For` 或 Cloudflare 代理地址，也不把内核默认路由的 `src` 当作 NAT 后公网地址。配置中的公网地址、默认路由源地址和实际公网观测分别存放；首次观测立即生效，后续变更须跨至少 10 秒连续确认两次。稳定样本只刷新最后观测时间，变更事件默认保留 7 天，机器详情请求的最近 14 天窗口会按实际保留期收窄；保留期可在设置页调整。

机器通知同样以控制面确认的状态转换为准：新 Agent 身份第一次轮询或离线后恢复产生上线事件，连续 90 秒没有期望状态轮询产生下线事件，公网 IP 只有在上述双样本确认完成后才产生变化事件。CPU steal 不低于 10% 持续 60 秒时开启宿主机抢占告警，不高于 5% 持续 90 秒时恢复；缺失样本和带 gap 的低值不作为恢复证据。事件与 Webhook 投递状态分别持久化；设置 `BROCADE_NOTIFICATION_WEBHOOK_URL` 后，Console 以 schema v2 JSON POST 投递，非 2xx、超时与连接失败均按指数退避重试，进程重启后继续。没有配置 Webhook 时仍可通过全局通知中心或 `/notifications` 读取默认保留 7 天的事件（保留期可在设置页调整），但不会积压日后突然补发的 Webhook 任务。Webhook URL 可能带凭据，错误日志不会输出它。

通知中心支持一键清空告警：系统管理员会同步清空所有账号，其他已登录账号只清空自身；服务端保存
独立于已读位置的清空游标，刷新或换设备仍有效。清空不删除机器事件、公网 IP 变更历史或 Webhook
投递；进行中告警不会被视作已恢复，之后的恢复和新事件仍会通知。
`POST /notifications/clear` 接受 `through_event_id`，只清空该位置及以前的通知，
不会吞掉请求期间到达的新事件。访客不能主动清空，但会跟随系统管理员的全局清空；通知列表可能附带
旧的告警起始事件以解释新的恢复，展示时以告警最后事件 ID 和
`cleared_through_event_id` 判断，不把上下文当作新通知。

VPN Gate 是节点的可选能力，普通 Agent 安装不会安装 OpenVPN。在纳管向导的「安装 Agent」阶段选择安装 OpenVPN 扩展，展示和复制的安装命令都会追加 `--enable-openvpn`；也可手动追加该参数。该选择只影响安装命令，不写入登记配置或产生修订；命令过期、已兑换时不可更改，上线后显示 Agent 实际上报的安装状态。安装器会补齐 OpenVPN 与隔离命名空间所需的 iptables，加载 `tun` 内核模块并写入 `/etc/modules-load.d/brocade-vpngate.conf` 保证重启后仍可用；模块、设备节点或容器权限不满足时会在消费纳管 token 前失败。Agent 每 30 秒仅在 OpenVPN 和 `/dev/net/tun` 都可用时上报 `openvpn --version` 的首行，但不会启用系统级 OpenVPN 常驻服务；只有已发布规则实际引用地区池或固定节点时，才在独立 netns 中按需启动进程。OpenVPN 服务端推送的 DNS 由 Agent 的 namespace-aware up/down hook 写入 `/etc/netns/<name>/resolv.conf`，不会把 netns 内的接口序号交给宿主机 systemd-resolved。机器详情的 CONFIG 运行状态显示「已安装 / 未安装」，完整版本及当前池状态在 VPN Gate 的观测页查看。没有最新兼容上报、OpenVPN/TUN 能力不可用、已隔离或非 active 的机器不会列为可接入节点；控制面也会在发布预览中提示并拒绝把新增或变更的 VPN Gate 规则发布到该机器。每轮运行时收敛完成后，Agent 会可靠上报包含零个池在内的完整池集合；Console 只在集合与当前期望拓扑完全一致时更新状态，并删除该机器未再上报的旧池指针。卸载后的空期望状态因此会同时清理旧进程、命名空间和「承载机器」状态，历史拨测证据继续保留。

VPN Gate 默认关闭；设置页的整体开关只控制目录同步、候选拨测和出口 IP 情报后台任务，关闭不会删除目录、机器选择或候选池，也不会修改已经发布的 Chain，再次开启后从保留状态恢复。上游目录由设置页「情报任务」中独立选定的「目录收集 Agent」集合分布式采集，出口 IP 情报由另一套「IP 情报 Agent」集合领取；两套集合默认收起，点击「修改」后展开，可独立选择。上游会按请求出口返回显著不同的节点集合，因此每台目录收集 Agent 都有独立周期和租约，并压缩传输自己网络视角下的有界原文；Console 不访问上游，而是在服务端统一校验、清洗，保留每台采集者的最新完整快照，再按服务器 ID 和配置摘要合并去重后更新候选目录。某台采集失败只保留它的上次成功视角，不会让最后一个上报者覆盖其它地域，也不会作为整个目录的前端错误；失败运行和采集者错误仍保留供审计。采集者身份、原文摘要、行数和逐节点观测保留在同步记录中。共享目录拨测与采集、IP 情报及实际出口运行分别使用独立循环：system-admin 在 VPN Gate 的「目录采集」页另外选择承担 OpenVPN 目录拨测的 Agent 子集。控制面用本地 GeoIP 数据把拨测任务按大洲就近放置：亚洲目录优先亚洲机器，美洲目录优先美洲机器；欧洲、非洲和大洋洲没有本洲机器时交给相邻区域。同一区域不再按服务器 ID 固定分片；每台机器按自己的最后拨测时间独立遍历完整区域目录，因此同一个节点会获得来自不同网络出口的多份真实样本，一台机器失败或离线也不会阻塞其它机器。GeoIP 尚未加载时暂时使用完整队列，避免冷启动让拨测停摆。每台机器都持续遍历完整累积区域目录，而不只扫描模型已配置的地区或当前候选节点；各自选择最久未测的有界批次，避免小地区被反复测量时大地区仍有节点从未覆盖。并发拨测使用彼此隔离的 OpenVPN worker，并把下载测速限制为 2 路，防止测速流量互相挤压；实际并发不会超过 Agent 上报的 128 worker 能力和该机器自己的有界配置。Agent 上报后立即领取下一批，因此完整目录不会变成节点上的无界任务队列。上游的保留未知地区代码 `ZZ` 不进入目录展示、拨测任务或规则目标。每个地区最多 32 个通过硬门槛的入口进入目录候选短名单；单个实际出口仍按自己的 `max_candidates` 上限取用其中节点，该短名单上限不裁剪其它地区的目录展示和拨测覆盖面。`current` 表示节点是否出现在任一采集机器的最新完整快照中；快照中暂时消失的历史节点仍属于目录，并可凭合格的最新拨测证据进入自动池或手动池。是否加入共享拨测集合不会改变已发布线路；真正引用该出口的每台机器仍会在本机复核实际出口和性能。访客可以读取目录、候选证据和运行结论；服务器地址、主机名、手动节点标识、验证出口和错误详情统一在服务端响应边界脱敏，目录同步和拨测机器设置仍只允许有权限的操作者修改。

VPN Gate 候选不使用 Brocade 合成的“综合质量分”。Agent 先完成 OpenVPN 拨测并上报建连耗时、实测下载速率和两次独立查询一致的实际出口 IP；只有成功拨通并发现的出口 IP 才会进入情报队列。当前目录、自动池和手动池只读取每个拨测 Agent 对候选的最新投影；高频原始拨测行仅保留 24 小时供故障复盘，清理它们不会让仍然新鲜的候选退出池。一次成功的拨测证据可保留候选资格 5 小时；后续失败会立即把同一服务器/Profile 放到目录拨测的高优先级复核队列，并从第一次失败起进入独立的 20 分钟宽限期。连续第三次失败会立即暂停候选资格；不足三次但宽限期届满也会暂停。任意一次后续成功都会清零失败次数、结束宽限期并立即恢复资格。控制面把出口 IP 全局去重并租给设置页选中的一台 Agent，Agent 通过独立于 OpenVPN 目录拨测的工作循环持续领取，长时间运行的隧道批次不会阻塞情报查询。默认只在出口 IP 首次出现时查询；相同 IP 不做固定周期复查。设置页可以改为定期刷新，但无论哪种模式，只有最后成功拨通发生在配置窗口内（默认 72 小时）的出口才会领取任务。长期不可拨、从未拨通或仅存于历史记录中的 IP 会保留审计证据，但不会继续消耗第三方查询。操作者也可以手动把当前仍可拨的出口重新加入队列。

承担任务的 Agent 并行查询 ProxyCheck v3、FFraud 与 IPLogs，分别保留三家的地区、0–100 来源分数、ISP 和网络类型（机房、家宽、商宽、移动网络、中继或未知）。任一来源成功即可形成可用证据，地区结论按来源保留，不要求三家一致；全部来源失败会保留上次成功情报并退避重试。拨测失败同样不会删除或隐藏历史情报：观测页把最新拨测结果与最后成功出口、最后成功情报分别展示。设置页分别配置每家来源自己的分数阈值，并配置最少成功来源数、地区匹配方式以及“任一来源通过”或“所有可用来源通过”；系统只组合来源的通过/拒绝结论，绝不比较或聚合不同口径的原始分数。情报只对完全相同的出口 IP 生效，出口变化立即回到待查询状态。情报是否复查与旧情报是否准入是两套独立策略；默认继续使用最近一次成功结果，也可选择超过指定期限后仅标记陈旧或禁止准入。地区、来源风险、建连和下载仍是独立准入门槛，不加权也不相互补偿；修改准入规则会立即重新评估已保存的原始情报，无需重新查询。共享候选节点在完全相同的来源集合内以逐来源的 Pareto 支配关系分层；不同来源集合互不可比，不同来源的原始分数绝不相加，情报来源数量也不形成排名。候选先按 Pareto 层排序，同层再按全局下载速率和建连耗时稳定排序；全局性能只取每台 Agent 对该节点最新的新鲜样本后再聚合，Agent 覆盖数、累计拨测次数和运行时长均不参与排名。实际出口池再应用自身配置的门槛。

设置页「情报任务」向系统管理员显示已保存的 ProxyCheck Key 数量和脱敏列表，每条仅保留首尾各 6 位，中间两组隐藏；历史单 Key 与旧 Key 池无需重新录入。完整 Key 继续加密保存，管理 API 不返回完整原文；追加会保留旧 Key、去重并立即更新列表，池内最多 32 个 Key，按随机起点轮换使用。

已验证出口的任一 IP 情报来源将 ISP 识别为 OPTAGE 或 Chubu Telecommunications Company, Inc. 时，该节点不进入 VPN Gate 的候选、候补或实际下发池（包括手动选择）；目录和拨测证据仍保留。ISP 尚无情报时不凭主机名推断。

WARP 使用 Xray MASQUE 出站，默认 HTTP/3（UDP/443），也可在隧道参数中选择 HTTP/2（TCP/443）；两者都承载 TCP/UDP 业务，不自动互相回退。Endpoint 默认 `162.159.198.2:443`，TLS SNI 固定为 `consumer-masque.cloudflareclient.com`；设备使用 P-256 密钥认证并校验注册返回的服务端公钥。隧道内 DNS 默认 `1.1.1.1`、`1.0.0.1`，域名目标通过 WARP 查询。

申请流程仍是“创建并提交隧道 → 按机器同意条款并申请身份 → 发布”。注册适配器先创建临时设备，再登记 MASQUE 公钥；登记失败会注销临时设备。密钥和设备令牌加密保存，草稿预览不调用 Cloudflare。WARP 不再接受 WireGuard 的 MTU、Keepalive、Allowed IPs、TUN、Workers 和 reserved 参数；旧 WG 身份不能复用，需重新申请。此变更不兼容旧 WARP 模型和绑定数据，升级已有安装前须完成旧绑定清理与重新注册；运行时仅接受 MASQUE 格式，不转换旧快照。已有安装应先备份、停止 Console 写入，再使用 `scripts/migrate-warp-checkpoints.py` 审计并以 `--apply` 迁移未绑定、未引用的旧默认配置；脚本原子更新存储格式和订阅摘要，保留修订编号及运行引用。携带旧 WG 身份或引用旧隧道的数据会拒绝迁移，必须先显式重新注册并发布。先发布支持 MASQUE 的 Brocade Xray，再发布使用它的配置。

外部隧道的资源 ID 是不承载业务语义的随机标识：手工隧道使用 `custom-xxxx-xxxx`，WARP 使用 `warp-xxxx-xxxx`，VPN Gate 地区池或固定节点使用 `vpngate-xxxx-xxxx`，其中 `x` 是小写十六进制。地区、节点、租户和展示名称只保存在各自字段中，旧前缀或语义化 ID 不再接受。

VPN Gate 出口直接在规则的目标菜单选择：`VPN Gate → 地区` 使用自动维护的地区池；展开该地区节点列表可勾选 1–16 个节点组成手动池。手动池只在所选节点间切换，节点退役或不满足准入门槛时不会补入其它节点。隧道页只负责目录观测与采集，不再要求先创建独立出站。选择和规则一起保存到变更集，提交并发布后生效；底层继续复用可审计的出站引用，兼容历史 `server_id` 固定节点。一批模型操作全部落地后，控制面会在同一事务中删除已经没有规则或前置组引用的 VPN Gate 派生出口；自定义隧道仍可作为未引用资源保留，历史观测也不依赖派生出口继续存在。手动池使用 `server_ids` 模型字段，需部署对应新版 Console；Agent 收到的是最多 16 个的有界候选列表。

每个实际出口池在 Agent 上维持一个主用和一个热备 OpenVPN namespace，稳定 SOCKS 地址由原子路由规则指向当前主用。Agent 每 5 秒通过两个独立 HTTPS 目标并行检查真实出口；进程退出或 SOCKS 不可达立即切换，出口连续两轮不可达时切换，因此探测与路由替换的预算小于 30 秒。Agent 在池内保存自己最近一段时间的成功端到端样本，按窗口内平均下载速率降序、平均建连耗时升序选择候选；有本机统计的候选始终先于无统计候选，样本数本身不参与排名。全部候选均无本机统计时使用系统随机源打散顺序，使不同机器不会因为拿到相同名单而集中到同一首节点。窗口默认 15 分钟，可用 Agent 环境变量 `BROCADE_VPNGATE_STATS_WINDOW_SECS` 或安装参数 `--vpngate-stats-window-secs` 配置为 60–86400 秒；窗口外样本和配置摘要已变化的样本不会参与选择。主用变化时，Agent 会随收敛摘要重新携带窗口内最新的本机完整样本；若没有可复用样本，则保持路由切换的快速路径，并让新主用在下一轮约 5 秒后优先进行完整拨测。失效槽位会从剩余候选中补齐；全部候选均失败时按 10 秒到 5 分钟的有界指数退避重试，不形成无界任务队列。目录 OpenVPN 拨测运行在独立线程，不会阻塞主备探活。节点页通过既有按需实时通道展示池状态、主备角色、失败原因、连续失败、探活/切换/补位计数和最近 32 条状态事件；持久化运行摘要仍只在状态变化时上报。该实时形状从 Agent 协议 v16 开始提供。

VPN Gate 观测页的「规则与承载机器」也使用同一实时通道显示主用、备用、就绪备用数和主备切换次数；超过 15 秒未更新时标记为过期。出口、风险、建连和单流性能优先按实时主用节点读取该承载机器的拨测证据，主用切换后不会继续显示旧节点的指标。新主用的本机样本尚未到达时，页面可暂用该候选在共享目录拨测中的最新成功结果，并明确标为「候选参考」；本机证据到达后自动替换，不把参考值冒充为当前机器实测。

自动池可以从 VPN Gate 观测页手动切换。控制面优先用新鲜实时主用校验切换目标，实时观测不可用时沿用可靠上报的运行摘要；确认期间主用变化会要求重新确认，过期实时状态禁止点击切换。控制面记录一次性请求并由承载机器执行：优先切到已经验证的热备，没有热备时先验证另一候选；只有稳定 SOCKS 路由成功指向替代节点后才确认成功。旧主节点随后停止并进入 10 分钟冷却，冷却状态保存在 Agent 本地，重启或暂时失联也不会提前重新选中；没有合格替代时保持现状并返回失败，不中断当前出口，也不创建模型修订或重启主 Xray。

### 用户站点流量

「全局设置 → 站点统计」统一控制机队，默认关闭，仅系统管理员可修改。策略随 Agent 的期望状态轮询同步，Xray 每秒检查私有控制文件，无需配置发布或重启；开启后为新连接分类，关闭后停止已有连接的站点计数，计费用量与历史站点数据不受影响。关闭／重新开启会更新采集边界，首次上报重新建立基线。缺少新版 Console 的策略头时 Agent 默认关闭；升级旧 Agent/Xray 后才具备采集能力。

MTProxy 不经过通用 Dispatcher，依据已认证的 Telegram 专用协议直接归入 Telegram，不依赖嗅探。

用户详情的「站点流量」统计用户 × 固定站点集合的上下行字节与占比，已登录操作者可读所属租户范围；普通用户与访客不能获取。集合版本与域名后缀定义共用 [catalog.json](components/xray-core/common/siteusage/catalog.json)，只上报固定分类标识，不保存逐条域名、URL 或访问日志。优先使用嗅探取得的域名，其次使用代理请求自带的域名；是否允许覆盖路由目标不影响分类。未命中集合归「其他站点」，启用嗅探但未取得域名归「嗅探失败」，未启用嗅探且无域名归「未识别」。无法识别的加密流量、纯 IP 协议及共享 CDN 无法凭此准确还原网站，分类只用于观测，不作为计费或访问审计依据。

报表嵌在当前用户的详情内，不是机队站点汇总；全局设置将「站点分类」「未分类域名」「嗅探失败目标」整合到一个「站点统计」面板，侧栏只保留一个入口；三类策略独立，站点分类开关即时保存，域名和目标参数分别保存。「站点流量」合并时间分布、分类排行、其他站点域名明细和嗅探失败目标明细。正文合计行提供当天／当周／当月筛选，按 UTC+8 自然日、周一起的自然周、自然月查询。当天和当周按小时、当月按天绘制堆叠柱，前五类站点单独着色，其余合并；未来时段留空，未观测区域与当前时刻有标记。窄屏上下排列图表和排行，切换周期保持卡片与展开状态。站点名称前显示本地内嵌、随主题适配的品牌图标，兜底分类复用通用界面图标，不请求第三方 favicon；素材来源见 [图标说明](frontend/src/ui/site-brand-icons.LICENSE.md)。本地视觉夹具标明示例用户，不能当作真实报表。

三条用户观测接口 `site-usage`、`other-domains`、`sniffing-failed-targets` 使用 `period=day|week|month`（默认 `day`，非法值返回 400）；旧 `hours` 参数不再控制范围。站点响应包含周期结束时间、桶宽和各类上下行时间序列，分类合计与时间序列取自同一数据库快照。前端与 Console 需作为同一产物更新；此次查询与展示调整不改变 Agent/Xray 上报协议，也不需要数据库迁移。

Agent v31 与带 `user-site-usage-v1` 能力的受管 Xray 使用独立、有界的 `xray-site-accounting.bin`（约 8 MiB）保存累计站点计数；中继身份、探测身份与独立端口转发不参与统计。该维度随原用量报告离线补报，在同一幂等事务内按冻结授权归属落库，不加入计费总量。首次上报或 journal 更换建立基线，不把未知历史归入当前时段；按 UTC 小时聚合，跨小时区间按时间比例分配，保留 31 天，查询当天／当周／当月内截至当前的桶。未支持、上报过期、覆盖不足和计数受限会明确提示，范围切换保留现有面板。

分类索引全进程复用，不缓存逐条域名。相同用户与站点复用一对计数器；首次注册交给单个后台工作线程，队列最多 256 项、缓存最多 8192 对，并限制键长度。转发路径不等待站点注册的磁盘同步，持续传输只做原子累加，不复制载荷、不逐包投递异步任务；统计快照遇到注册繁忙会跳过本轮站点标签刷新，不等待它。队列满、容量耗尽或注册失败只影响观测并标记受限，失败后由后续连接触发至少间隔 5 秒的重试，不阻断计费和转发。

尚未注册完成的站点字节暂存内存：进程突然退出可能丢失这部分观测，持久化的 `site>>>pending` 标记使新版 Agent 将其报告为不完整，而不是伪装为完整用量；注册完成后直接累加到 mmap。正常退出最多等待 2 秒排空，超时明确标记受限。必需的计费计数不经过这个异步队列。Agent 与 Xray 应使用配套版本，以识别新增的待注册标记。优化对照方法和边界见 [性能测试说明](scripts/tests/site-usage/README.md)。

现有数据库先核对生产 schema 与 migration checksum，再评估执行 [兼容 SQL](scripts/compat-user-site-usage.sql)；以数据库管理员执行时必须传入 `-v app_role=brocade`，保证新增对象归应用角色所有。脚本只覆盖三张站点观测表与全局开关字段，不包含工作区其他 schema 改动。推荐先 Console，再按发布单更新 Agent 与 Xray；只部署 Console 不会自动升级机队，也不会补出升级前的网站数据。新字段可选，旧计量报告和旧回执仍可重放。本地视觉夹具见 `frontend/tests/fixtures/site-usage-preview.html`，通过 Vite 的 `/@fs/` 路径访问，明确标记为示例数据。

### 其他站点 Top N（用户 × 域名）

固定站点分类采用「固定版本 geosite 精选集合 + 手工补全/精细覆盖」：目前覆盖 44 个平台/公司，另有其他站点、嗅探失败与未识别三种兜底。包括 X/Twitter、Facebook、Instagram，以及字节跳动、百度、腾讯、阿里巴巴等国内公司；具体产品优先于母公司，共享 Meta CDN 单列，不把整个共享 CDN 根域归给某网站。构建时生成、全进程复用，运行时不联网拉取、不做 DNS 反查。规则来源、匹配语义、优先级与更新方式见 [分类资源说明](components/xray-core/common/siteusage/README.md)。分类扩充需先升级 Console 再发布 Xray；既有连接与历史数据不回溯重分类。

「全局设置 → 其他站点 Top N」是独立、默认关闭的策略，不依赖固定站点开关。仅系统管理员可修改；用户详情中的结果只允许系统管理员与作用域内租户管理员读取，普通用户（含本人）、访客和其他操作角色均不可读，接口禁止缓存。

默认展示每用户 Top 128；每个节点持续维护每用户最多 1,024 个未分类域名候选，24 小时无流量后淘汰。节点总容量默认 4,096，同时约束候选域名索引及每小时入口身份 × 域名计数对，不按用户预分配；多用户或多入口共享该预算。上述数值与上报间隔（默认 30 秒）可配置：Top N 为 1–512，每用户容量不小于 Top N、节点容量不小于每用户容量，两种容量均不超过 4,096；间隔为 15–300 秒。容量调整会重建采集窗口，展示数量／间隔调整不清空采集；关闭停止数据面计数，重新开启建立新窗口，只有开启时新建的连接具备域名观测包装。

只记录已获认证的用户入口、未命中固定预设分类的规范化 ASCII/Punycode DNS 主机名及上下行字节，不保存 URL、路径、内容、IP 或逐次访问记录，不做 DNS／外部 favicon 请求。每节点最多保存当前与上一 UTC 小时的内存计数，热路径仅原子累加，冷准入使用 TryLock；快照格式化／排序不持有准入锁。单独的 Agent 后台线程通过专用 `otherdomain>>>` 查询并增量批量上报；不增加计费快照、计费回执、fsync、逐包队列或网络等待。转发失败与否不取决于可选统计。

Console 按冻结用量代际确定用户归属，累计头幂等计算增量，跨节点合并后排序；保留包含当前小时的最近 24 个小时桶。明细跟随当天／当周／当月筛选，查询起点取自然周期起点与保留起点的较晚者，周／月不会补出已过期的明细。前端用随构建内嵌的公共后缀表（含私有后缀）将主机名按可注册域归并，避免将 `github.io` 等平台的不同租户合成一个站点；不联网解析域名。每节默认展示六项，可展开全部、折叠预览或从排行跳转；说明行写明保留范围、采集起点、覆盖量和限制。固定分类无数据或读取失败时，独立明细仍可查看。仅对实际采集的域名排名：达到容量后不接纳新域名，并标记覆盖不完整，**不是无界、全量域名排名保证**。节点重启／交接会丢失未上报 RAM 观测；离线补偿仅覆盖仍保留的两小时桶，无持久化离线队列。缺报、采集前时段、受限和重建窗口会明确提示，不将辅助观测冒充完整计费。

需要协议 v34 Agent 与声明 `other-domain-usage-v1` 的 Xray；推荐 Console → Agent → Xray，均就绪后再开启。旧 Agent 忽略策略头，新 Agent 遇旧 Console 默认关闭、遇旧 Xray 显示无可用观测，不影响主计费。新 Agent 的常规启动及热交接均传递私有 `other-domain-policy.json` 路径。已有库先审查 [域名观测兼容 SQL](scripts/compat-other-domain-usage.sql) 和所有待部署 schema 差异，再使用构建所含 `0001_init.sql` 的 SHA-384 更新 checksum；该脚本不包含其他功能的 schema 变更。此功能与固定站点历史互不回填。

### 嗅探失败目标 Top N（用户 × IP／端口／协议）

「全局设置 → 嗅探失败目标 Top N」提供独立、默认关闭的全局策略。默认每用户展示 Top 128，每节点持续维护每用户 1,024 个目标，节点总容量 4,096、每 30 秒异步上报；可配置范围、容量关系和 24 小时保留窗口与其他域名维度一致，两个维度预算互不挤占。只有系统管理员能修改；系统管理员及作用域内租户管理员可查看用户详情，普通用户、访客及其他操作角色均不可读，接口禁止缓存。

仅对新建、已认证、启用嗅探却未识别出域名的连接，统计原始 TCP/UDP 目标 IP 与端口的上下行字节。IPv4/IPv6 均支持并规范化，TCP/UDP、不同端口分别统计；原始地址可能是 FakeIP，不等于最终出口地址或代理下一跳。不保存载荷、URL、逐连接日志，也不以 IP 猜网站。未启用嗅探、域名目标和已识别域名不计入。明细合并在站点流量卡片底部，按协议、IP 与端口列出；跟随自然周期筛选，仍只保留近 24 小时，切换范围不移除面板。

数据面复用有界冷准入及原子计数器，关闭不创建目标索引；专用 `sniffingfailed>>>` 查询不会混入计费或其他域名查询。Agent 独立线程批量上报，计费不等待可选观测；快照、未上报数据及重启/交接的丢失边界与其他域名维度相同，达到容量明确标为不完整，并非全量 Top N 保证。需要协议 v35 Agent 和 `sniffing-failed-targets-v1` Xray，推荐 Console → Agent → Xray 后再启用；缺少策略头默认关闭，旧 Xray 无观测而不影响计费。正常启动及热交接均传递私有 `sniffing-failed-policy.json` 路径。

现有数据库先核对生产 schema、checksum 及所有工作区差异，再评估 [目标观测兼容 SQL](scripts/compat-sniffing-failed-usage.sql)，通过 `-v app_role=brocade` 指定对象属主；脚本只包含本功能，既不启用采集，也不修改 migration checksum。它不能替代对其他待部署 schema 的审查。

## REALITY 回落限速

新建 VLESS REALITY 接入及启用 AnyTLS REALITY 时，fallback 限速默认使用「严格」：上传超过 256 KiB 后约 64 KiB/s，下载超过 1 MiB 后约 256 KiB/s；编译时按入口生成稳定的 ±10% 扰动。该限制只作用于未通过 REALITY 验证的回落连接，不限制已认证用户的代理吞吐。修改其他字段不会覆盖已有明确选择；存量入口需要通过草稿和配置发布切换档位，历史快照中缺失的策略仍按原来的关闭语义读取。

## 客户端订阅

koipy 测速订阅仅允许管理员（`system-admin` 或作用域内的 `tenant-admin`）查看、生成和撤销。
普通用户自助订阅及编辑/发布角色的订阅响应不下发测速地址，普通 Clash 订阅不受影响。
首次生成使用 `POST /users/{tenant}/{user}/clash-subscription/haitun`，重复请求返回现有有效地址；
`DELETE /users/{tenant}/{user}/clash-subscription/haitun` 停止旧地址后续拉取，不自动生成新地址。
撤销后可由管理员再次 POST 生成新 Token；重复 DELETE 保持首次撤销时间。移除直接重新生成接口，
不提供 `/me/clash-subscription/haitun` 自助操作，无需数据库迁移。

**风险：测速地址是可转交的访问凭据，不要求测速客户端登录管理员账号。** 其内容包含用户 UUID
等真实节点凭据，持有者可以使用节点，应只交给可信服务。撤销仅停止后续拉取，不修改 UUID、
普通订阅或节点授权，也不会触发发布；已下载的节点配置仍可使用。若凭据已泄露，需要同时撤销
测速地址、更换用户 UUID 并发布授权，待节点生效后旧凭据才失效。收紧管理权限不会自动替换已签发
的地址；管理员应对曾交给不可信服务的地址执行上述处置。

普通订阅地址 `/sub/v1/{uuid}/clash.yaml` 在拉取时按 `User-Agent` 的首个产品名协商格式：`Shadowrocket`（大小写不敏感，可带版本号）返回 Base64 编码的节点 URI 列表，其 `STATUS` 行展示 `↑:1.23G,↓:2.34G,TOT:21.21T`。单位按 1024 进位、最多两位小数；上传、下载和总额统一使用 `K/M/G/T` 等紧凑单位，不限量显示 `TOT:∞`。订阅状态文字不展示统计缺口，但保留原有 `x-brocade-usage-gap` 响应头供诊断。其余客户端、浏览器和缺少 UA 的请求仍返回原有 Clash YAML，`subscription-userinfo` 的键名和字节整数不变。UA 只决定表现形式，不参与鉴权；若客户端伪装成 Clash，仍会收到 Clash 格式。Haitun 测速链接固定返回专用 YAML，不受 UA 影响。

两种格式使用同一份已生效服务视图、地址/协议筛选和月度计费数据，不增加数据库查询或改变 Agent 协议。若当前筛选结果包含前置代理或自签证书，Brocade 现有通用 URI 导出器尚未完整实现对应的路由或证书信任信息，整份订阅保持 Clash YAML，不丢弃节点、不启用 insecure。这是当前导出实现的兼容边界，并非断言 Shadowrocket 或所有协议 URI 都不支持这些能力。此兼容路径仍使用标准流量响应头，暂不提供自定义状态文字。响应的 `x-brocade-subscription-format` 表示实际格式，`x-brocade-subscription-fallback` 标明 `front_proxy` 或 `self_signed_certificate`；所有响应继续禁止缓存，成功响应增加 `Vary: User-Agent`。月份重置时间不是订阅到期时间，不会伪造 `expire`。

用户详情「接入」页签的「订阅」卡列出 Clash 订阅地址（koipy 测速订阅只给管理员），协议、地址族筛选只影响订阅地址；页面上遮住地址里的 Token，完整地址只在「显示」或「复制」时使用。「节点」卡把网络拨测与节点链接合在一起：一个接入点一行，格子写 IP + 端口与安全层 · 传输，点格子复制分享链接。URI 表达不了的条目（带前置代理、VLESS 自签入口）没有分享链接，格子里只有拨测状态，服务端的跳过说明写在矩阵下方。节点链接默认同时列出自签证书节点：这些链接带 `insecure=1`，客户端不验证证书，格子标 insecure。这只影响卡片里显示的链接，订阅地址与未带 `insecure` 参数的 URI 导出仍不启用 insecure。网络拨测从控制台发起，只给通过 / 失败与失败原因，不显示首字节时延。

## 一键启动与临时 Tunnel

CI 按版本、CPU 与 libc 生成 `brocade-dist-<version>-linux-<arch>-<libc>.tar.gz`。解压后的目录结构如下：

```text
brocade-dist-<version>-linux-x86_64-gnu/
├── brocade-launcher
├── brocade-console
├── install.sh
├── BROCADE_PLATFORM
└── SHA256SUMS
```

CI 同时生成同名 `.tar.gz.sha256`，用于在解压前校验整个归档。其中发行物内的组件使用完整名称 `brocade-launcher`，安装后仍由简洁的 `brocade` 命令作为用户入口。系统级安装执行：

```sh
sudo sh install.sh
```

安装器首先选择公网接入方式与数据库方式。公网接入可选由 launcher 管理的 Cloudflare Quick Tunnel，或登记一个已经准备好的 HTTPS 站点；后者的 DNS、TLS 与反向代理仍由操作者自行配置，默认应转发到 `127.0.0.1:8080`。数据库可选 Brocade 托管 PostgreSQL，或填写已有 PostgreSQL 的连接地址；外部连接地址以仅 root 与 `brocade` 账号可读的权限保存，连接失败不会回退并建立空库。非交互安装必须显式给出两项选择，例如：

```sh
sudo sh install.sh --tunnel --managed-db
sudo sh install.sh --site-url https://console.example.net \
  --database-url postgresql://brocade:password@database.example.net/brocade
```

包含密码的连接地址优先在交互菜单中填写，避免进入 shell 历史。安装器随后校验发行包与 CPU/libc 是否匹配，再通过 apt、apk、dnf、yum 或 zypper 补齐系统 CA、账号工具及 GNU 构建所需的 `liblzma`/`libgcc`，创建无登录权限的 `brocade` 服务账号，并原子安装两个二进制和选择结果。musl 发行物由 CI 强制检查为无动态库依赖。有 systemd 时安装器自动启用并启动 `brocade.service`，等待数据库、控制台与公网入口就绪后输出完整初始化链接；打开链接只需设置管理员用户名和密码，无需读取服务器文件。无 systemd 时在当前终端前台运行 launcher，需保持终端打开。无需 Docker，也不会通过系统包管理器安装或编译 PostgreSQL；PostgreSQL 与 cloudflared 由 launcher 下载并校验。自动化只安装文件时可加 `--no-start`，稍后手动启动：

```sh
sudo brocade up
```

未设置 `DATABASE_URL` 时，launcher 会按当前 CPU 与 libc（x86_64/aarch64、GNU/musl）下载并校验固定的 PostgreSQL 17.11.0 运行时，在用户数据目录维护数据库；设置了 `DATABASE_URL` 则只连接外部数据库，绝不会因连接失败回退并新建空库。需要把选择写得更明确时，可使用 `--managed-db` 或 `--external-db`。PostgreSQL 不会由本项目编译或塞进 launcher；所选预编译归档自带匹配的共享库，并通过相对 RUNPATH 从自己的 `lib/` 加载。这些 PG 私有库不能安全替换成发行版包：OpenSSL、ICU 与 libxml2 在不同 Debian、Ubuntu、Alpine 版本上的 SONAME 并不稳定，而数据目录必须继续由同一套 PG 版本读取。

选择 Quick Tunnel 后，系统安装版的同一条启动命令会按保存的安装类型自动启用它；也可以在未使用系统安装配置时显式传入选项：

```sh
sudo brocade up --tunnel
```

首次启动时，launcher 生成 32 字节随机初始化凭据，以 `0600` 私有文件保存供重启恢复。完整初始化链接把一次性凭据放在 `#/initialize/...` fragment 中，浏览器不会把 fragment 放进 HTTP 请求或 Referer；网页接收后立即从地址栏清除，只在内存保留直到提交。完整链接仅向交互终端输出，重定向和 systemd 日志只输出普通地址；再次获取入口可在终端运行 `sudo brocade url`。初始化成功后凭据立即失效，私有文件被删除。手动部署指定 `BROCADE_BOOTSTRAP_TOKEN` 的旧入口仍可填写凭据，以兼容已有部署。初始化只创建系统管理员和根租户，不预置网络用户；登录后由可恢复的入门向导依次纳管首台机器、创建链和首个用户、发布配置，并以真实用户授权完成一次节点拨测。

使用 `--tunnel` 时，一次性凭据先保护初始化接口，launcher 再建立 Tunnel，安装终端输出带有随机 `https://*.trycloudflare.com` 地址的完整链接。若不希望初始化提交经过 Cloudflare，可在浏览器所在电脑建立 `ssh -N -L 8080:127.0.0.1:8080 <用户>@<服务器>` 转发，把完整链接的站点部分改成 `http://127.0.0.1:8080` 并保留 fragment。launcher 查询 Cloudflare 官方 latest stable release，校验官方 SHA-256 后缓存 `cloudflared`。查询失败时只会回退到最近一个已验证缓存；不会执行 cloudflared 自更新，也不会把它打进 Brocade 发行包。需要可复现环境时使用 `--cloudflared-version VERSION`，已有受管安装时使用 `--cloudflared-bin PATH`。

Cloudflare Quick Tunnel 适合临时查看和联调，不提供 SLA，公网地址每次可能变化，并受 Cloudflare 的并发限制；正式部署仍应使用自己的域名、TLS 与受管 Tunnel/反向代理。Quick Tunnel 不支持 SSE，控制台会在实时流失败后自动切换到同权限、无缓存的短轮询接口。

系统安装器把数据和下载缓存分别放在 `/var/lib/brocade` 与 `/var/cache/brocade`；`sudo brocade` 会先降权到专用账号，PostgreSQL 和 Console 都不会以 root 运行。直接从解压目录执行时，默认仍为 `$XDG_DATA_HOME/brocade`（或 `~/.local/share/brocade`）与 `$XDG_CACHE_HOME/brocade`（或 `~/.cache/brocade`）。完整参数见 `brocade up --help`。

## 代码结构

| 组件                 | 职责                                                       |
| -------------------- | ---------------------------------------------------------- |
| `brocade-core`       | 纯函数编译器：模型快照 → IR → 节点产物                     |
| `brocade-store`      | PostgreSQL 持久化：修订、草稿、发布、凭据、配额与用量      |
| `brocade-console`    | 控制台 API、节点 API，以及内嵌的 Web 控制台与 agent 发行物 |
| `brocade-launcher`   | 一键编排 Console、可选受管 PostgreSQL 与 Cloudflare Tunnel |
| `brocade-deployment` | 发布计划和控制面—节点协议类型                              |
| `brocade-agent`      | 节点侧收敛、观测、探测与用量采集                           |
| `brocade-probe`      | Agent 与控制面共用的临时 Xray 客户端和端到端拨测执行器     |
| `brocade-preview`    | 基于 Docker 的本地集群预览环境                             |
| `frontend`           | React + Vite 控制台                                        |
| `components/xray-core` | Brocade Xray fork 源码；当前钉在官方 `v26.4.25` 基线     |

生产构建会把前端资源以及 `x86_64`、`aarch64` 两种架构的静态 Agent 和 Brocade Xray 一并嵌入 `brocade-console`。因此，控制面部署只需分发一个二进制文件，前端、API 与节点发行物也不会因独立部署而发生版本漂移。Xray 的发布身份取自实际内嵌字节；构建时关闭 Go VCS 元数据并使用钉住的上游基线作为 banner build id，避免 README 或前端提交制造一次没有数据面变化的 Xray 发布。

## 构建与验证

### 前置条件

仓库通过 [`rust-toolchain.toml`](rust-toolchain.toml) 固定 Rust 工具链和 agent 所需的 musl targets。完整构建还需要：

- Node.js 22 与 npm，用于构建前端；
- [`components/xray-core/.go-version`](components/xray-core/.go-version) 指定的精确 Go 版本，用于构建或校验 Brocade Xray；
- Zig 0.16，用于交叉编译静态 agent；
- Docker，用于执行 PostgreSQL 集成测试；
- 目标平台的交叉链接器，仅在控制面本身需要交叉编译时使用。

构建脚本会在开始阶段检查必要工具，并在缺失时报告对应的安装方式。标准发行构建为：

```sh
cargo build --release --locked -p brocade-console -p brocade-launcher
```

输出位于 `target/release/brocade-console` 与 `target/release/brocade-launcher`，部署 launcher 时应保持二者同目录。构建脚本会执行 `npm ci` 与前端生产构建，并分别生成两种架构的 Agent 和 Brocade Xray。若前端已由其他流水线构建，可通过绝对路径指定待嵌入目录，从而跳过 npm：

```sh
BROCADE_CONSOLE_ASSETS_DIR=/absolute/path/to/frontend/dist \
  cargo build --release --locked -p brocade-console
```

Xray 构建会固定 Go 参数与环境，并为双架构产物自动生成 `xray-<arch>.build.json`（位置打印在构建日志中）。记录包含实际编译输入指纹、编译配方和二进制摘要；相同输入出现不同摘要会中止构建。首次遇到一组输入时，会使用独立 Go 缓存再次编译核对。`BROCADE_XRAY_BIN_X86_64` / `BROCADE_XRAY_BIN_AARCH64` 只接受与当前源码、配方及摘要匹配的预编译文件，必须同时提供 `<二进制路径>.build.json`，仍需精确版本的 Go 来验证输入；无记录的旧文件不能继续混入构建。这些构建检查不会触发节点 Xray 升级。

### 测试

基础检查与默认测试集如下：

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked

cd frontend
npm ci
npm run lint
npm test
npm run build
```

PostgreSQL 集成测试由 testcontainers 启动临时数据库，必须显式执行被忽略的测试：

```sh
BROCADE_RUN_PG_TESTS=1 \
  cargo test -p brocade-store --test pg_integration --locked -- --ignored

BROCADE_RUN_PG_TESTS=1 \
  cargo test -p brocade-store --test tunnel_probe_pg --locked -- --ignored

BROCADE_RUN_PG_TESTS=1 \
  cargo test -p brocade-console --test http_integration --locked -- --ignored
```

## 部署 brocade-console

以下示例假定：构建主机为 `x86_64` Linux，目标服务器为 `aarch64` Ubuntu，并使用 PostgreSQL、systemd 与 Nginx。域名、账号和密码均为占位符，部署时必须替换。若目标架构与构建主机一致，可省略交叉编译相关设置。

### 1. 交叉编译控制面

在构建主机安装目标标准库与交叉链接器：

```sh
rustup target add aarch64-unknown-linux-gnu
sudo apt-get update
sudo apt-get install gcc-aarch64-linux-gnu
```

随后构建控制面：

```sh
CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
  cargo build --release --locked \
  --target aarch64-unknown-linux-gnu \
  -p brocade-console
```

产物位于：

```text
target/aarch64-unknown-linux-gnu/release/brocade-console
```

`brocade-console` 的构建脚本还会生成两种架构的静态 agent。对构建目录执行清理后，这些内嵌产物需要重新编译，因此完整构建所需时间通常明显长于普通 Rust crate。

### 2. 准备系统账号与 PostgreSQL

建议使用无登录权限的独立系统账号运行服务：

```sh
sudo useradd --system --no-create-home \
  --home-dir /opt/brocade \
  --shell /usr/sbin/nologin brocade
sudo install -d -o root -g root -m 0755 /opt/brocade
```

在 PostgreSQL 中创建专用角色和数据库。`createuser --pwprompt` 会交互式读取密码，避免将密码写入 shell 历史：

```sh
sudo -u postgres createuser --pwprompt brocade
sudo -u postgres createdb --owner=brocade brocade
```

数据库迁移会在控制面启动时自动执行。若数据库不存在且角色具有 `CREATEDB` 权限，控制面也可以自动创建数据库；生产环境通常更适合预先创建数据库，并遵循最小权限原则。

### 3. 控制面拨测 Xray

用户页的「授权验证」会使用当前 Serving 中的真实用户授权发起短生命周期拨测；隧道详情页的手动拨测可选择当前 Serving 或点击时的完整草稿，设置页的定时监测则始终只列出并监测 Console 能执行的 Serving 出口。它们都由 Console 机器发起，并强制流量只经过所选外部出口。Serving 任务引用不可变发布快照；草稿任务只把所选出口加密冻结到任务中，并在任务结束时清除密文，不会创建模型修订。公共落点和超时同样在入队时冻结，结果与定时策略持久化到 PostgreSQL；Console 重启或多实例抢占不会重复执行同一任务。草稿结果会进入最近记录，但不参与 Serving 健康、趋势或告警。定时任务采用稳定抖动且不补跑错过的周期，记录保留 7 天。WARP 因身份按节点分配，在 Console 拥有独立身份前不会出现在定时监测列表；VPN Gate 由引用它的节点 Agent 实拨，同样只在自己的观测页展示。

公共落点只支持明文 HTTP。Console 会先解析并拒绝回环、私网、链路本地、文档和其它非公网地址，再把已批准的 IP 固定写入 SOCKS 请求，避免 DNS 重绑定；原始主机名仅保留在 HTTP `Host` 头。Console 会把本次构建内嵌的对应架构 Brocade Xray 校验并原子写入 `BROCADE_CACHE_DIR`，无需再单独安装。`BROCADE_PROBE_XRAY_BIN` 只保留为显式运维覆盖；一旦设置，路径或版本错误会直接报告，不会静默回退。

### 4. 安装二进制与环境文件

先将构建产物上传至目标服务器的临时目录，再安装到 `/opt/brocade`：

```sh
scp target/aarch64-unknown-linux-gnu/release/brocade-console \
  deploy@console.example.net:/tmp/brocade-console

ssh deploy@console.example.net \
  'sudo install -o root -g root -m 0755 /tmp/brocade-console /opt/brocade/brocade-console'
```

以 [`console.env.example`](console.env.example) 为依据创建 `/opt/brocade/console.env`。以下配置采用单一监听端口同时承载控制台 API 与节点 API，因此有意不设置 `BROCADE_AGENT_BIND`：

```dotenv
DATABASE_URL=postgres://brocade:CHANGE_ME@127.0.0.1:5432/brocade
BROCADE_BOOTSTRAP_TOKEN=CHANGE_ME
BROCADE_ADMIN_BIND=127.0.0.1:8080
BROCADE_AGENT_PUBLIC_URL=https://console.example.net
BROCADE_CACHE_DIR=/var/cache/brocade
BROCADE_PROBE_RUNTIME_DIR=/run/brocade/probes
```

环境文件包含数据库密码及密封密钥，应在写入任何内容之前将权限限制为 root 可读。随后在目标服务器上直接生成并追加 `BROCADE_SECRET_KEY`，避免密钥经过构建主机、终端输出或复制过程：

```sh
sudo install -o root -g root -m 0600 /dev/null /opt/brocade/console.env
sudoedit /opt/brocade/console.env
sudo sh -c 'printf "BROCADE_SECRET_KEY=%s\n" "$(openssl rand -base64 32)" >> /opt/brocade/console.env'
sudo sh -c 'printf "BROCADE_BOOTSTRAP_TOKEN=%s\n" "$(openssl rand -base64 32)" >> /opt/brocade/console.env'
sudo chown root:root /opt/brocade/console.env
sudo chmod 0600 /opt/brocade/console.env
```

`BROCADE_SECRET_KEY` 用于密封 DNS 凭据和证书私钥；丢失后，数据库中的既有密文无法恢复，因此应与数据库备份一同保管。对已有部署重新执行生成命令会改变密钥，使既有密文失效；该步骤只应在首次部署或明确执行密钥轮换时运行。

`BROCADE_BOOTSTRAP_TOKEN` 只授权一次 `/auth/init`。首次打开页面时从这个 root 可读的环境文件复制该值；初始化成功后删除这一行并重启服务。直接运行 `brocade-console` 而不是 launcher 时，若未设置该变量，控制面仍提供健康检查和初始化页面，但初始化请求会以 503 失败。

浏览器登录会话以 12 小时无活动为过期界线，而不是从登录时刻计算固定期限。已打开的控制台每 5 分钟发送一次轻量保活；其它已认证请求也会延长服务端期限并同步续写 Cookie。关闭页面或设备休眠后若连续 12 小时没有成功请求，会话仍会正常过期；重置密码和主动退出仍会立即撤销对应会话。

用户详情的「生成直达登录页」会签发 UUID + TOKEN 组合，用于直接换取同一类 HttpOnly 浏览器会话。完整凭据只在生成响应中展示一次，服务端只保存 TOKEN 的 SHA-256；重新生成或撤销后旧页面立即失效，现有浏览器会话不受影响。链接把凭据放在 `#/login/...` 片段中，浏览器不会把它写入 HTTP 请求路径，前端读取后也会立即从地址栏移除。更换用户 UUID 会同时撤销直达登录页。

若数据库密码包含 `@`、`:`、`/` 等 URI 保留字符，必须先对用户名或密码部分进行百分号编码，再写入 `DATABASE_URL`。

若需要分别限制控制台流量与节点流量，可以设置 `BROCADE_AGENT_BIND`，并为第二个监听地址配置独立的反向代理入口。其余环境变量及留空时的行为见 [`console.env.example`](console.env.example)。

### 5. 配置 systemd

先创建 `/etc/systemd/system/brocade-console.socket`。这里的地址必须与
`BROCADE_ADMIN_BIND` 完全一致；默认的单监听模式同时承载 Console 与 Agent API：

```ini
[Unit]
Description=Brocade Console listener

[Socket]
ListenStream=127.0.0.1:8080
Accept=no
Backlog=4096
NoDelay=true
FileDescriptorName=admin
Service=brocade-console.service

[Install]
WantedBy=sockets.target
```

再创建 `/etc/systemd/system/brocade-console.service`：

```ini
[Unit]
Description=Brocade Console
Requires=brocade-console.socket
After=brocade-console.socket network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=brocade
Group=brocade
WorkingDirectory=/opt/brocade
EnvironmentFile=/opt/brocade/console.env
Environment=BROCADE_CACHE_DIR=/var/cache/brocade
ExecStart=/opt/brocade/brocade-console
Restart=on-failure
RestartSec=5s
TimeoutStopSec=90s
UMask=0077
CacheDirectory=brocade
RuntimeDirectory=brocade
RuntimeDirectoryMode=0700
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict

[Install]
WantedBy=multi-user.target
```

控制面会在 `BROCADE_CACHE_DIR` 中保存 GeoIP 数据库缓存。`CacheDirectory=brocade` 由 systemd 创建并授予服务账号写权限，因此无需放宽 `/opt/brocade` 的文件权限。授权与隧道拨测的临时配置包含真实凭据，只会以 `0600` 写入 `RuntimeDirectory` 下的 `probes` 子目录，任务结束后删除；该目录本身由控制面收紧为 `0700`。数据库只保存脱敏后的配置指纹与归类结果，不保存 Xray 原始日志。

用户详情的「在线设备」是一条按公网来源 IP 排列的时间线：在线来源在最前，最近 30 天离线的来源按最后出现分到今天、昨天、7 天内与 30 天内（后两组默认折叠）；打开详情即读取离线来源，在线来源集合变化时重新读取。每行按 ingress 反查并合并为实际接入链，不展示入口机器；同时显示当前连续在线周期的流量、在线时长和 Console 上次接受该来源快照的时间。来源流量由 Xray 按用户、入口和来源 IP 直接计数，不从月用量或机器用量推算；来源完全离线或 Xray 重启后重新起算。旧 Agent/Xray 未上报会话字段时显式显示「—」。本地 GeoIP 仍提供国家／地区及可识别的中国运营商，支持 IPv4、IPv6 和 IPv4-mapped IPv6；查询不会把来源 IP 发给外部服务，也不把归属信息写入 PostgreSQL。同一 IP 跨节点或多条接入链使用时，全局来源数只计一次，各链保留自己的协议和会话指标。

接入协议跟在各自的接入链之后列出（VLESS / AnyTLS / Hysteria2 / MTProxy）。协议来自 Xray 已认证入口的连接引用，不根据配置、端口或嗅探到的 HTTP/TLS 猜测；同一 IP 可同时使用多种协议，断开一种后下一次快照会移除它，不改变来源计数和计费标签。历史仅保留各入口最后观测到的协议和会话指标，不是逐连接审计。旧 Agent/Xray 或旧观测缺少字段时显示「协议未知」。这些可选字段不提高最低 Agent 协议版本；完整展示需要对应版 Xray 和 Agent 都已发布，单独部署 Console 不会升级它们。已有数据库按 [Console 部署手册](.agents/runbooks/console-deployment.md) 做受控兼容处理，全新安装仍只使用 `0001_init.sql`。

运营商索引独立于国家库及 Xray 路由规则，使用 MIT 许可的 [gaoyifan/china-operator-ip](https://github.com/gaoyifan/china-operator-ip) 中电信、移动、联通、教育网、科技网五类双栈网段。Console 后台每天从同一提交版本下载完整列表，校验成功后整体替换内存索引，并在 `BROCADE_CACHE_DIR/geoip-china-operators-v1.json` 保存重启缓存；失败时保留上次有效数据并退避重试。首次下载未完成不阻塞页面，来源接口只查询本地内存，不需要 Agent 升级或数据库迁移。

全新安装时加载并启动 socket 和服务：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now brocade-console.socket
sudo systemctl enable --now brocade-console.service
sudo systemctl status brocade-console
sudo journalctl -u brocade-console -n 100 --no-pager
```

systemd 持有监听 fd；正常 `restart brocade-console.service` 时，新连接在内核监听队列中
等待新进程接管，旧进程仍按关闭期限完成手上的请求。不要在普通发布中重启或停止
`brocade-console.socket`。从旧的进程自绑定部署首次切换时，必须先停止旧服务释放端口，再
启动 socket 和服务；这一次转换本身仍有短维护窗口。若设置了 `BROCADE_AGENT_BIND`，需要
让 systemd 同时传入两个与配置完全相同的监听地址；Console 按本地地址识别它们，与 fd
顺序无关。

首次启动时应核对日志中实际连接或自动创建的数据库名称，避免因 `DATABASE_URL` 拼写错误而得到一个新的空数据库。

### 6. 配置 Nginx 与 TLS

控制面应只监听回环地址，由 Nginx 负责公网 TLS 终止。将以下配置写入 `/etc/nginx/sites-available/brocade`。示例假定证书已安装于 `/etc/letsencrypt/live/console.example.net/`：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name console.example.net;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name console.example.net;

    # Selected Agents gzip VPN Gate snapshots before upload. The application decompresses with a
    # separate 16 MiB ceiling and accepts this larger body only on the catalogue-report route.
    client_max_body_size 4m;

    ssl_certificate /etc/letsencrypt/live/console.example.net/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/console.example.net/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Agent 实时遥测使用出站 WebSocket；浏览器实时视图使用 SSE。两者都经过控制面，
        # 浏览器不会连接或获知节点地址。
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;
    }
}
```

启用配置前必须先验证语法：

```sh
sudo ln -s /etc/nginx/sites-available/brocade /etc/nginx/sites-enabled/brocade
sudo nginx -t
sudo systemctl reload nginx
```

若域名经过 Cloudflare 等代理，应使用可验证的源站证书，并启用严格的端到端 TLS 验证（Cloudflare 对应 `Full (strict)`），而不应依赖不校验证书的兼容模式。

### 7. 更新与回滚准备

升级前应备份数据库，并记录当前二进制的 SHA-256：

```sh
sudo install -d -o postgres -g postgres -m 0700 /var/backups/brocade
sudo -u postgres pg_dump --format=custom \
  --file=/var/backups/brocade/before-upgrade.dump brocade
sha256sum /opt/brocade/brocade-console
```

新二进制应先上传到临时路径，再原子替换并重启服务。上传阶段不会中断现有进程：

```sh
scp target/aarch64-unknown-linux-gnu/release/brocade-console \
  deploy@console.example.net:/tmp/brocade-console.new

ssh deploy@console.example.net '
  set -eu
  sudo install -o root -g root -m 0755 \
    /tmp/brocade-console.new /opt/brocade/brocade-console.new
  sudo mv /opt/brocade/brocade-console.new /opt/brocade/brocade-console
  sudo systemctl restart brocade-console
  sudo systemctl --no-pager --full status brocade-console
'
```

迁移只会在启动时向前执行。常规升级不应通过删除数据库来“重建”状态；若新版本涉及不可逆迁移，应在部署前验证备份可恢复性，并准备与数据库版本相匹配的旧二进制。

升级后除服务状态外，还应确认本地拨测执行器可用：

```sh
sudo systemctl is-active brocade-console
sudo journalctl -u brocade-console -n 100 --no-pager
curl --fail https://console.example.net/healthz
```

登录控制台后，用户页「授权验证」与自定义隧道详情页「拨测」均不应显示“Console 未安装或无法执行拨测 Xray”。授权拨测使用真实用户凭据和真实完整链路，产生的少量流量会正常计入该用户用量；隧道拨测固定从 Console 发出。拨测 Serving 时浏览器只提交条目的不透明 ID；拨测草稿时浏览器提交现有草稿操作，服务端在授权事务中生成并冻结出口，浏览器仍不能直接指定探测落点或后台执行配置。

常用诊断命令如下：

```sh
sudo systemctl status brocade-console
sudo journalctl -u brocade-console -f
sudo -u postgres psql brocade
```

## 性能诊断与基线

Console 默认启用有界、进程内性能统计，可用 `BROCADE_PERFORMANCE_ENABLED=false` 关闭。
系统管理员可读取 `GET /diagnostics/performance`，响应 `Cache-Control: no-store`：

- HTTP 按路由模板、方法及启动前 60 秒 / 稳态分组，统计次数、状态码类别、耗时直方图、
  已知响应字节数；P50/P95 是桶上界，不是假定精确值。
- SQLx 查询指纹与发起它的路由关联，记录查询耗时、返回/影响行数；不保留 SQL 文本、
  参数、请求实际 URL、机器名、订阅凭据或响应内容。指纹是对 SQL 去首尾空白后的
  UTF-8 文本计算 SHA-256，短语句使用 SQLx summary，可离线从代码匹配。
- 保存最近 15 个一分钟桶，每桶最多 512 个 HTTP 分组、256 个 SQL 分组，超出进入
  overflow，不追加日志或数据库时序。重启清空；诊断接口不统计自己。
- 附带当前连接池大小/空闲数，以及 PG 的缓存命中、临时文件、死锁、活动连接和锁等待
  数字。PG 累计值以 `stats_reset` 为起点，不能直接当作最近 15 分钟增量；活动信息受
  数据库角色可见性限制。只报告 `pg_stat_statements` 是否安装，不自动安装、启用或重启 PG。

API 响应的 `Server-Timing` 提供 `handler`、`db`、`pool`，可在浏览器开发者工具读取。
`handler` 截止响应头就绪，不含后续流式传输、网络和页面渲染；未知长度的流不为计量而缓冲。
`db` 是客户端观测的执行/获取行耗时，不是 PG CPU 时间；`pool` 仅包含成功获取连接的
等待（含建立/校验连接），失败获取不会计入。它们可能重叠，不能相减冒充应用 CPU 耗时。
SQL 归因范围是请求任务内的查询，不包含后台任务、另行 spawn 的任务或流返回后的查询。
升级 SQLx 时必须运行性能模块的真实 PostgreSQL 事件契约测试。

通过安全方式设置 `BROCADE_ADMIN_TOKEN`（不要把令牌写入命令、报告或仓库），使用 HTTPS
或 SSH 转发的本地端口，运行顺序、只读的 HTTP 基线：

```sh
BROCADE_BASE_URL=http://127.0.0.1:8080 \
  BROCADE_BASELINE_REPEATS=10 node scripts/performance-baseline.mjs > baseline.json
node --test scripts/performance-baseline.test.mjs
```

可额外设置 `BROCADE_BASELINE_NODE` 测机器 Load/Ping 24 小时数据；默认测试 bootstrap、
节点状态、模型快照和 Ping latest。脚本拒绝重定向、限制 30 秒和 16 MiB 响应，不保存正文，
输出首请求、后续 P50/P95、字节数与 Server-Timing。首请求不是“已证明的冷启动”；对比
时使用相同机器、数据窗口、请求次数及网络位置，记录是否刚启动和缓存情况。

Ping 无损存储兼容、隔离基准与恢复边界见
[Console 部署手册](.agents/runbooks/console-deployment.md#ping-序列字典无损时序存储)。

## 本地前端开发

控制台不再提供独立的「链路与 MTU」页面；旧 `#/links` 地址回到机器列表。
机器详情、线路及设置页已有的拨测和 MTU 功能保留，后端采集与接口不受影响。

列表标题直接继承公共 `.panel.titled` 的 12px 字体规则，与普通配置面板保持一致，不额外覆盖字号、
字重或字距；列表与面板标题图标共用 14px 尺寸，标题栏与按钮的布局尺寸不因此改变。
标题显式使用 14px 行高，避免中文回退字体撑高默认行盒，使文字与图标保持垂直居中。

用量页保留本月 / 上月切换与每日日期，不在面板标题后重复显示年月；汇总、每日柱形和详情
不再展示采集缺口提示。统计仍使用实际收到的数据，后台缺口记录和请求失败提示不受影响。

登录页、普通工作区与拓扑共用随明暗主题及调色盘变化的 32px 方格背景。
暗色网格使用同等低明度的主题色灰阶，玄墨为近中性的钢青灰；亮色沿用各配色的浅灰网格。
`styles.css` 的 `--grid-line` 独立于界面边框的 `--line`，只作用于背景装饰层；面板保持不透明，
图表刻度线不受影响。背景无需图片、额外请求或用户设置，下拉回弹仍使用顶栏的实色底。
根文档底色与顶栏同用 `--surface`，浏览器 `theme-color` / `color-scheme` 会随明暗和配色同步，
内容层的网格和面板透明度不受影响。启动画布和桌面工作区不用全屏 `fixed`，避免 Safari 26
将内容台面作为状态栏的固定边缘取色来源。触屏设备的普通页面使用浏览器原生文档滚动，配合
`viewport-fit=cover` 允许内容延伸到安全区；首屏控件仍保留安全间距，但顶部留白会随页面滚走，
不叠加固定实色遮罩。桌面和拓扑画布仍使用内部工作区；路由统一保存和恢复实际滚动主体的位置。
`theme-color` 只作为支持它的浏览器的提示，原生状态栏透明度与模糊仍由 Safari 决定。
`npm run test:browser-appearance` 可用 Chromium / WebKit 检查真实 CSS 与浏览器主题色同步，
首次运行先执行 `npx playwright install chromium webkit`；该检查不等同于 iOS Safari 真机工具栏验收。

前端开发服务器与生产构建分别使用：

```sh
cd frontend
npm ci
npm run dev
```

```sh
cd frontend
npm run build
```

生产控制面默认使用编译时内嵌的前端。仅在本地迭代或紧急替换静态资源时，才应通过 `BROCADE_CONSOLE_DIST=/absolute/path/to/frontend/dist` 改为运行时读取目录；这种模式无法保证页面与 API 来自同一次构建。

## 许可证

Brocade 自有代码采用 Apache License 2.0，详见 [LICENSE](LICENSE)。仓库内维护的
`components/xray-core` 是基于 XTLS/Xray-core 的 fork，继续遵循 MPL-2.0；其许可证与固定的
上游基线分别见 [components/xray-core/LICENSE](components/xray-core/LICENSE) 和
[components/xray-core/BROCADE_UPSTREAM.toml](components/xray-core/BROCADE_UPSTREAM.toml)。
