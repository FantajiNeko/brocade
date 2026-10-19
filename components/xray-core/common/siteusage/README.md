# 站点统计分类资源

`catalog.source.json` 是维护入口；`catalog.json` 是确定性生成物，Go 数据面与 Rust Console/Agent 共用稳定分类 ID。不得直接编辑生成物。此文件只分类流量观测，不改变路由。

## 两层资源

- `sites[].geosite` 导入固定版本的 v2fly/domain-list-community 精选集合，使用其已经展开 include、属性过滤及 affiliation 的 `dlc.dat`。按 `source.url` 的提交号及 SHA-256 双重固定，许可见 `GEOSITE-LICENSE`。它与现有路由用 GeoIP/geosite 资源分开更新。
- `sites[]` 中的 `domains`／`full`／`keywords`／`regexps` 是手工补全，与导入规则合并、排序、去重。站点顺序是显式优先级：具体产品排在母公司前，如 YouTube → Google、TikTok／抖音 → 字节跳动、GitHub → Microsoft。
- `overrides` 是极少量明确覆盖规则，先于基础分类执行。目前将 fbcdn/fbsbx 共享资源归入“Meta 共享”，不强猜 Facebook 或 Instagram。覆盖 ID 必须已存在。不要在此放宽泛的母公司规则，否则会吞掉产品分类。

精确匹配不会扩展为后缀；后缀按 DNS 标签边界匹配。关键词与 Go RE2 正则保留原始语义，不丢弃、不改写为宽泛 CDN 根域。只导入已选集合，不用 `cn`／`geolocation-*` 之类地区总表猜网站，也不以 IP、DNS 反查、ASN 或共享 CDN 服务商推断归属。分类意味着命中社区集合，不是网站所有权的保证。

## 更新与复核

普通构建和运行均不下载资源。维护时从 `source.url` 下载到仓库忽略的 `.tools/site-usage-geosite.dat`；不要覆盖路由使用的 `resources/geosite.dat`。从 Xray 目录运行：

```sh
go run ./common/siteusage/cmd/cataloggen
go run ./common/siteusage/cmd/cataloggen -check
go test ./common/siteusage/...
```

可用 `-asset /path/to/dlc.dat` 指定下载文件；摘要不匹配、集合不存在、未知匹配类型或预算超限均直接失败。`-list` 仅列举文件中的集合，不生成分类。刷新上游资源时先审查数据源与许可，更新来源 URL/摘要，再审查生成差异及回归用例；名称、图标和分类 ID 同步检查。

全进程只编译一次，域名后缀使用反向标签 trie，精确域名使用哈希表；只在需要时检查有界关键词/正则。限制最多 64 个分类、20,000 条规则及 64 条慢匹配规则（当前无关键词、9 条正则）。不创建逐域名运行缓存，不在转发路径读取文件、联网或做异步任务分配；分类只在每条连接绑定时发生，持续传输仍仅累加复用计数器。

现有分类 ID 和协议版本保持兼容；新 ID 需先升级 Console 的校验与展示，再更新 Xray。旧连接保留绑定时的分类，历史“其他站点”不会回溯重分类，也不会重复搬移计数。拓展分类仍共享原有 8,192 对站点计数预算，达到容量明确标记观测不完整。
