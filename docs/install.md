# 安装与升级

用发行包安装、初始化、升级和备份 Console。不使用安装器的部署方式见[手动部署](manual-deployment.md)。

## 下载

从 [Releases](https://github.com/akiasprin/brocade/releases/latest) 下载与服务器匹配的发行包和同名 `.sha256`，校验后解压。自 `v0.3.1` 起，GNU 包支持 glibc 2.35 及以上；Alpine 等 musl 系统选 `musl`。静态 musl 包也可安装到同架构 GNU 系统，launcher 会按宿主机的 libc 选择受管 PostgreSQL，不要求额外安装 musl 动态加载器。

`v0.3.0` 的 GNU 包要求 glibc 2.39，且该版本 musl 安装器不支持跨 libc 安装。兼容 Ubuntu 22.04、Debian 12 等较旧 GNU 系统时，请下载 `v0.3.1` 或更新版本：

```sh
v=0.3.1 p=linux-x86_64-gnu
url=https://github.com/akiasprin/brocade/releases/download/v$v/brocade-dist-$v-$p.tar.gz
curl -fLO "$url" && curl -fLO "$url.sha256"
sha256sum -c brocade-dist-$v-$p.tar.gz.sha256
tar xzf brocade-dist-$v-$p.tar.gz
cd brocade-dist-$v-$p
```

## 安装

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

安装器默认直接提供服务器 IP 的 HTTP 入口，监听 `0.0.0.0:8080`。交互安装先选择托管或外部 PostgreSQL，再确认自动识别的服务器 IP 和端口；端口提示为 `HTTP 端口 [8080]：`，直接回车使用 8080，也可输入 1 至 65535 之间的自定义端口。重启或升级不会重新分配入口地址。NAT 环境请填写外部机器能访问的 IP，并做好端口映射。非交互安装可指定：

```sh
sudo sh install.sh --public-ip 192.0.2.10 --managed-db
sudo sh install.sh --public-ip 192.0.2.10 --port 9000 \
  --database-url postgresql://brocade:password@database.example.net/brocade
```

省略 `--public-ip` 时，安装器使用默认路由的本机地址；省略 `--port` 时使用 8080。包含密码的数据库连接地址优先在交互菜单中填写，避免进入 shell 历史。安装器校验发行包与 CPU/libc 后补齐系统 CA、账号工具及 GNU 构建所需的 `liblzma`/`libgcc`，创建 `brocade` 服务账号并原子安装二进制和配置。有 systemd 时自动启用并启动 `brocade.service`，等待就绪后输出 `http://服务器IP:8080/#/initialize/...` 完整初始化链接；打开后设置管理员用户名和密码即可。无 systemd 时在当前终端前台运行。自动化仅安装文件可加 `--no-start`，随后手动启动：

```sh
sudo brocade up
```

## 数据库

未设置 `DATABASE_URL` 时，launcher 按 CPU 与 libc 下载并校验固定的 PostgreSQL 17.11.0，在持久目录维护数据库；设置了 `DATABASE_URL` 则只连接外部数据库，失败不会回退并新建空库。可用 `--managed-db` 或 `--external-db` 明确选择。系统安装器将访问地址保存到 `/etc/brocade/agent-public-url`，监听地址保存到 `/etc/brocade/listen-address`，以后启动继续使用。直接从发行包执行时可传 `brocade-launcher up --public-ip 192.0.2.10 --port 8080`；仅查看识别结果可执行 `brocade-launcher address`。

## 初始化

首次启动生成一次性初始化凭据。完整链接把凭据放在 `#/initialize/...` fragment 中，网页接收后清除地址栏 fragment，只在内存保留直到提交。完整链接仅向交互终端输出，重定向和 systemd 日志只输出普通地址；再次获取入口运行 `sudo brocade url`。初始化成功后凭据失效，私有文件被删除。初始化只创建系统管理员和根租户；登录后由入门向导纳管首台机器、创建链和首个用户、发布配置并完成真实节点拨测。登录、订阅链接和 Agent 安装命令均支持 HTTP IP 入口。

## 目录与账号

系统安装器把数据和下载缓存分别放在 `/var/lib/brocade` 与 `/var/cache/brocade`；`sudo brocade` 会先降权到专用账号，PostgreSQL 和 Console 都不会以 root 运行。直接从解压目录执行时，默认仍为 `$XDG_DATA_HOME/brocade`（或 `~/.local/share/brocade`）与 `$XDG_CACHE_HOME/brocade`（或 `~/.cache/brocade`）。完整参数见 `brocade up --help`。

## 升级

下载并校验新版本发行包后，再次运行其中的 `install.sh`。安装器先校验发行包，再原子替换二进制并重启 `brocade.service`；交互安装会重新确认数据库与访问地址，请选择与首次安装相同的选项。托管 PostgreSQL 的数据保留在 `/var/lib/brocade`，重装不会重建数据库。

升级 Console 不会自动升级任何机器上的 Agent 或 Xray；它们通过「发布」页的发布单更新，见[模型、修订与发布](concepts.md#agent-与-xray-发布单)。

## 备份

使用托管 PostgreSQL 时，`/var/lib/brocade` 保存数据库数据和密封密钥 `secret-key`。停止服务后完整复制该目录：

```sh
sudo systemctl stop brocade
sudo tar -C /var/lib -czf brocade-backup.tar.gz brocade
sudo systemctl start brocade
```

备份包含密钥，应按凭据保管。使用已有 PostgreSQL 时，用 `pg_dump` 备份数据库；若为 Console 配置了 `BROCADE_SECRET_KEY`，与数据库备份一同保管。丢失密钥后，已密封的 DNS 凭据和证书私钥无法恢复。
