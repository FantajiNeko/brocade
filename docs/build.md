# 从源码构建

构建 Console 与 launcher。Console 二进制内嵌前端、双架构 Agent 与 Brocade Xray。

## 前置条件

仓库通过 [`rust-toolchain.toml`](../rust-toolchain.toml) 固定 Rust 工具链和 agent 所需的 musl targets。完整构建还需要：

- Node.js 22 与 npm，用于构建前端；
- [`components/xray-core/.go-version`](../components/xray-core/.go-version) 指定的精确 Go 版本，用于构建或校验 Brocade Xray；
- Zig 0.16，用于交叉编译静态 agent；
- Docker，用于执行 PostgreSQL 集成测试；
- 目标平台的交叉链接器，仅在控制面本身需要交叉编译时使用。

## 发行构建

构建脚本会在开始阶段检查必要工具，并在缺失时报告对应的安装方式。标准发行构建为：

```sh
cargo build --release --locked -p brocade-console -p brocade-launcher
```

输出位于 `target/release/brocade-console` 与 `target/release/brocade-launcher`，部署 launcher 时应保持二者同目录。构建脚本会执行 `npm ci` 与前端生产构建，并分别生成两种架构的 Agent 和 Brocade Xray。若前端已由其他流水线构建，可通过绝对路径指定待嵌入目录，从而跳过 npm：

```sh
BROCADE_CONSOLE_ASSETS_DIR=/absolute/path/to/frontend/dist \
  cargo build --release --locked -p brocade-console
```

## 内嵌产物与 Xray 构建身份

生产构建会把前端资源以及 `x86_64`、`aarch64` 两种架构的静态 Agent 和 Brocade Xray 一并嵌入 `brocade-console`。因此，控制面部署只需分发一个二进制文件，前端、API 与节点发行物也不会因独立部署而发生版本漂移。Xray 的发布身份取自实际内嵌字节；构建时关闭 Go VCS 元数据并使用钉住的上游基线作为 banner build id，避免 README 或前端提交制造一次没有数据面变化的 Xray 发布。

Xray 构建会固定 Go 参数与环境，并为双架构产物自动生成 `xray-<arch>.build.json`（位置打印在构建日志中）。记录包含实际编译输入指纹、编译配方和二进制摘要；相同输入出现不同摘要会中止构建。首次遇到一组输入时，会使用独立 Go 缓存再次编译核对。`BROCADE_XRAY_BIN_X86_64` / `BROCADE_XRAY_BIN_AARCH64` 只接受与当前源码、配方及摘要匹配的预编译文件，必须同时提供 `<二进制路径>.build.json`，仍需精确版本的 Go 来验证输入；无记录的旧文件不能继续混入构建。这些构建检查不会触发节点 Xray 升级。

## 本地前端开发

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

## 验证

格式、lint、单元测试与 PostgreSQL 集成测试的命令见[验证标准](../.agents/standards/testing.md)。
