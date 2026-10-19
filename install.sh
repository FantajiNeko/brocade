#!/bin/sh
# Install a prebuilt Brocade bundle. This script intentionally installs only the small operating
# system prerequisites; PostgreSQL and cloudflared remain launcher-managed downloads.
set -eu
umask 077

install_root=/opt/brocade
launcher_path=$install_root/brocade-launcher
console_path=$install_root/brocade-console
command_path=/usr/local/bin/brocade
service_user=brocade
data_root=/var/lib/brocade
cache_root=/var/cache/brocade
config_root=/etc/brocade
installation_type_path=$config_root/installation-type
public_url_path=$config_root/agent-public-url
database_type_path=$config_root/database-type
database_url_path=$config_root/database-url

say() {
    printf '%s\n' "$*"
}

die() {
    printf 'brocade install: %s\n' "$*" >&2
    exit 1
}

usage() {
    cat <<'EOF'
Usage: [sudo] sh install.sh [--tunnel | --site-url https://console.example.net]
                              [--managed-db | --database-url postgresql://...]
                              [--no-start]

Installs the two binaries from this release bundle, the minimal OS prerequisites, and a dedicated
non-login `brocade` account. Without an option, an interactive terminal first asks whether this
installation uses a Cloudflare Quick Tunnel or an existing HTTPS site. Existing-site operators
must configure DNS, TLS, and the reverse proxy themselves.

PostgreSQL is not installed by apt/apk and no project is compiled.
Starts the managed systemd service and prints the ready URL. Without systemd, the launcher
continues in the foreground. --no-start installs files without starting the runtime.
EOF
}

installation_type=
site_url=
database_type=
database_url=
start_runtime=true
while [ "$#" -gt 0 ]; do
    case $1 in
        -h|--help)
            usage
            exit 0
            ;;
        --no-start)
            start_runtime=false
            shift
            ;;
        --tunnel)
            [ -z "$installation_type" ] || die "--tunnel 不能与其他安装类型同时使用"
            installation_type=tunnel
            shift
            ;;
        --site-url)
            [ -z "$installation_type" ] || die "--site-url 不能与其他安装类型同时使用"
            [ "$#" -ge 2 ] || die "--site-url 后需要填写 HTTPS 站点地址"
            installation_type=site
            site_url=$2
            shift 2
            ;;
        --site-url=*)
            [ -z "$installation_type" ] || die "--site-url 不能与其他安装类型同时使用"
            installation_type=site
            site_url=${1#--site-url=}
            shift
            ;;
        --managed-db)
            [ -z "$database_type" ] || die "--managed-db 不能与其他数据库类型同时使用"
            database_type=managed
            shift
            ;;
        --database-url)
            [ -z "$database_type" ] || die "--database-url 不能与其他数据库类型同时使用"
            [ "$#" -ge 2 ] || die "--database-url 后需要填写 PostgreSQL 连接地址"
            database_type=external
            database_url=$2
            shift 2
            ;;
        --database-url=*)
            [ -z "$database_type" ] || die "--database-url 不能与其他数据库类型同时使用"
            database_type=external
            database_url=${1#--database-url=}
            shift
            ;;
        *)
            usage >&2
            exit 2
            ;;
    esac
done

[ "$(id -u)" -eq 0 ] || die "需要 root 权限；请用 root 执行（有 sudo 时可执行 sudo sh install.sh）"

normalize_site_url() {
    site_url=$1
    while [ "${site_url%/}" != "$site_url" ]; do
        site_url=${site_url%/}
    done
}

valid_site_url() {
    [ "${#site_url}" -le 255 ] || return 1
    case $site_url in
        https://?*) ;;
        *) return 1 ;;
    esac
    case $site_url in
        *[[:space:]]*|*\'*|*\"*|*\`*|*\$*|*\\*) return 1 ;;
    esac
    site_authority=${site_url#https://}
    case $site_authority in
        ''|/*|\?*|\#*|*@*|*\?*|*\#*) return 1 ;;
    esac
    return 0
}

valid_database_url() {
    [ "${#database_url}" -le 2048 ] || return 1
    case $database_url in
        postgres://?*|postgresql://?*) ;;
        *) return 1 ;;
    esac
    case $database_url in
        *[[:space:]]*|*[[:cntrl:]]*) return 1 ;;
    esac
    return 0
}

prompt_installation_type() {
    [ -t 0 ] || die "非交互安装必须指定 --tunnel 或 --site-url https://你的站点"
    while :; do
        say "请选择控制台公网接入方式："
        say "  1) Cloudflare Quick Tunnel（临时公网地址，由 Brocade 管理 cloudflared）"
        say "  2) 已有 HTTPS 站点（DNS、TLS 与反向代理需要自行配置）"
        printf '请输入 1 或 2：'
        IFS= read -r choice || die "未读取到安装类型"
        case $choice in
            1)
                installation_type=tunnel
                return
                ;;
            2)
                installation_type=site
                return
                ;;
            *) say "选择无效，请重新输入。" ;;
        esac
    done
}

prompt_database_type() {
    [ -t 0 ] || die "非交互安装必须指定 --managed-db 或 --database-url postgresql://..."
    while :; do
        say "请选择数据库方式："
        say "  1) Brocade 托管 PostgreSQL（推荐；首次启动自动下载并初始化固定版本）"
        say "  2) 已有 PostgreSQL（需要填写连接地址；连接失败不会回退到新建空库）"
        printf '请输入 1 或 2：'
        IFS= read -r choice || die "未读取到数据库类型"
        case $choice in
            1)
                database_type=managed
                return
                ;;
            2)
                database_type=external
                return
                ;;
            *) say "选择无效，请重新输入。" ;;
        esac
    done
}

[ -n "$installation_type" ] || prompt_installation_type
if [ "$installation_type" = site ]; then
    while :; do
        if [ -z "$site_url" ]; then
            [ -t 0 ] || die "--site-url 后需要填写 HTTPS 站点地址"
            printf '请输入已有站点地址（https://...）：'
            IFS= read -r site_url || die "未读取到站点地址"
        fi
        normalize_site_url "$site_url"
        if valid_site_url; then
            break
        fi
        [ -t 0 ] || die "站点地址无效；必须是最长 255 字符且不含空白、引号的 https:// 地址"
        say "站点地址无效；必须填写 https:// 开头的完整地址，且不能包含空白或引号。"
        site_url=
    done
fi

[ -n "$database_type" ] || prompt_database_type
if [ "$database_type" = external ]; then
    while :; do
        if [ -z "$database_url" ]; then
            [ -t 0 ] || die "--database-url 后需要填写 PostgreSQL 连接地址"
            printf '请输入 PostgreSQL 连接地址（postgresql://...）：'
            terminal_state=$(stty -g) || die "无法读取终端状态"
            trap 'stty "$terminal_state"; exit 130' HUP INT TERM
            stty -echo
            if IFS= read -r database_url; then
                database_read=true
            else
                database_read=false
            fi
            stty "$terminal_state"
            trap - HUP INT TERM
            printf '\n'
            [ "$database_read" = true ] || die "未读取到 PostgreSQL 连接地址"
        fi
        if valid_database_url; then
            break
        fi
        [ -t 0 ] || die "PostgreSQL 连接地址无效；必须使用 postgres:// 或 postgresql://，且不能包含空白"
        say "PostgreSQL 连接地址无效；必须使用 postgres:// 或 postgresql://，且不能包含空白。"
        database_url=
    done
fi

say "安装配置："
if [ "$installation_type" = tunnel ]; then
    say "  公网接入：Cloudflare Quick Tunnel"
else
    say "  公网接入：已有 HTTPS 站点（$site_url）"
fi
if [ "$database_type" = managed ]; then
    say "  数据库：Brocade 托管 PostgreSQL"
else
    say "  数据库：已有 PostgreSQL"
fi

script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
for required in brocade-launcher brocade-console BROCADE_PLATFORM SHA256SUMS; do
    [ -f "$script_dir/$required" ] || die "发行包缺少 $required"
done
command -v sha256sum >/dev/null 2>&1 || die "系统缺少 sha256sum，无法先验证发行包"

# Verify before installing packages or touching system paths. The manifest is generated beside the
# binaries by CI and names only files in this bundle.
say "验证发行包…"
(cd "$script_dir" && sha256sum -c SHA256SUMS) || die "发行包 SHA-256 校验失败"

case $(uname -m) in
    x86_64|amd64) machine_arch=x86_64 ;;
    aarch64|arm64) machine_arch=aarch64 ;;
    *) die "只支持 x86_64 与 aarch64，当前为 $(uname -m)" ;;
esac

ldd_banner=$(ldd --version 2>&1 || true)
case "$ldd_banner" in
    *musl*) machine_libc=musl ;;
    *GLIBC*|*glibc*|*GNU*) machine_libc=gnu ;;
    *)
        if [ -f /etc/alpine-release ]; then
            machine_libc=musl
        else
            die "无法判断当前系统使用 GNU libc 还是 musl"
        fi
        ;;
esac

bundle_platform=$(sed -n '1p' "$script_dir/BROCADE_PLATFORM")
[ "$bundle_platform" = "$machine_arch-$machine_libc" ] ||
    die "发行包是 $bundle_platform，当前系统是 $machine_arch-$machine_libc"

has_ca_bundle() {
    for candidate in \
        /etc/ssl/certs/ca-certificates.crt \
        /etc/pki/tls/certs/ca-bundle.crt \
        /etc/ssl/ca-bundle.pem; do
        [ -s "$candidate" ] && return 0
    done
    return 1
}

has_privilege_dropper() {
    command -v su-exec >/dev/null 2>&1 && return 0
    command -v setpriv >/dev/null 2>&1 && setpriv --help 2>&1 | grep -q 'reuid' && return 0
    return 1
}

has_gnu_runtime_libraries() {
    [ "$machine_libc" = musl ] && return 0
    found_liblzma=false
    found_libgcc=false
    for candidate in \
        /lib/liblzma.so.5 /lib/*/liblzma.so.5 /lib64/liblzma.so.5 \
        /usr/lib/liblzma.so.5 /usr/lib/*/liblzma.so.5 /usr/lib64/liblzma.so.5; do
        [ -e "$candidate" ] && found_liblzma=true
    done
    for candidate in \
        /lib/libgcc_s.so.1 /lib/*/libgcc_s.so.1 /lib64/libgcc_s.so.1 \
        /usr/lib/libgcc_s.so.1 /usr/lib/*/libgcc_s.so.1 /usr/lib64/libgcc_s.so.1; do
        [ -e "$candidate" ] && found_libgcc=true
    done
    [ "$found_liblzma" = true ] && [ "$found_libgcc" = true ]
}

install_prerequisites() {
    say "安装系统 CA 与服务账号工具…"
    if command -v apt-get >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get update
        apt-get install -y --no-install-recommends \
            ca-certificates passwd util-linux liblzma5 libgcc-s1
    elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache ca-certificates su-exec
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y ca-certificates shadow-utils util-linux xz-libs libgcc
    elif command -v yum >/dev/null 2>&1; then
        yum install -y ca-certificates shadow-utils util-linux xz-libs libgcc
    elif command -v zypper >/dev/null 2>&1; then
        zypper --non-interactive install ca-certificates shadow util-linux liblzma5 libgcc_s1
    else
        die "无法自动安装 ca-certificates 与账号工具：不支持当前包管理器"
    fi
}

if ! has_ca_bundle || ! has_privilege_dropper || ! has_gnu_runtime_libraries ||
    { ! command -v useradd >/dev/null 2>&1 && ! command -v adduser >/dev/null 2>&1; }; then
    install_prerequisites
fi
command -v update-ca-certificates >/dev/null 2>&1 && update-ca-certificates >/dev/null
has_ca_bundle || die "ca-certificates 安装后仍找不到系统 CA bundle"
has_privilege_dropper || die "安装后仍缺少可用的 setpriv 或 su-exec"
has_gnu_runtime_libraries || die "安装后仍缺少 launcher 所需的 liblzma 或 libgcc"

if id "$service_user" >/dev/null 2>&1; then
    [ "$(id -u "$service_user")" -ne 0 ] || die "现有 brocade 账号不能是 root"
else
    nologin=/bin/false
    [ -x /usr/sbin/nologin ] && nologin=/usr/sbin/nologin
    [ -x /sbin/nologin ] && nologin=/sbin/nologin
    if command -v useradd >/dev/null 2>&1; then
        useradd --system --user-group --no-create-home \
            --home-dir "$data_root" --shell "$nologin" "$service_user"
    elif command -v adduser >/dev/null 2>&1; then
        if ! grep -q "^${service_user}:" /etc/group; then
            addgroup -S "$service_user"
        fi
        adduser -S -D -H -h "$data_root" -s "$nologin" -G "$service_user" "$service_user"
    else
        die "无法创建 brocade 服务账号"
    fi
fi

service_group=$(id -gn "$service_user")
for managed_path in "$install_root" "$data_root" "$cache_root" "$config_root"; do
    [ ! -L "$managed_path" ] || die "$managed_path 不能是符号链接"
done
install -d -o root -g root -m 0755 "$install_root"
[ -d /usr/local/bin ] || install -d -o root -g root -m 0755 /usr/local/bin
install -d -o "$service_user" -g "$service_group" -m 0700 "$data_root" "$cache_root"
install -d -o root -g root -m 0755 "$config_root"
for config_path in \
    "$installation_type_path" "$public_url_path" \
    "$database_type_path" "$database_url_path"; do
    if [ -e "$config_path" ] || [ -L "$config_path" ]; then
        [ -f "$config_path" ] && [ ! -L "$config_path" ] ||
            die "$config_path 已存在但不是普通文件"
    fi
done

launcher_stage=$install_root/.brocade-launcher.$$
console_stage=$install_root/.brocade-console.$$
command_stage=/usr/local/bin/.brocade.$$
installation_type_stage=$config_root/.installation-type.$$
public_url_stage=$config_root/.agent-public-url.$$
database_type_stage=$config_root/.database-type.$$
database_url_stage=$config_root/.database-url.$$
service_stage=$config_root/.brocade.service.$$
ready_error=$config_root/.install-ready.$$
cleanup_staging() {
    rm -f "$launcher_stage" "$console_stage" "$command_stage" \
        "$installation_type_stage" "$public_url_stage" \
        "$database_type_stage" "$database_url_stage" "$service_stage" "$ready_error"
}
trap cleanup_staging 0 HUP INT TERM

install -o root -g root -m 0755 "$script_dir/brocade-launcher" "$launcher_stage"
install -o root -g root -m 0755 "$script_dir/brocade-console" "$console_stage"

# Compatibility-check untrusted executable bytes only after dropping to the dedicated account.
if command -v su-exec >/dev/null 2>&1; then
    su-exec "$service_user" "$launcher_stage" --version >/dev/null 2>&1 ||
        die "launcher 无法在当前系统执行"
else
    service_uid=$(id -u "$service_user")
    service_gid=$(id -g "$service_user")
    setpriv --reuid="$service_uid" --regid="$service_gid" --init-groups \
        "$launcher_stage" --version >/dev/null 2>&1 || die "launcher 无法在当前系统执行"
fi

# The public command supplies system paths and, when invoked through sudo/root, drops privileges
# before the Rust launcher starts. This keeps `sudo brocade up` convenient without ever running
# initdb or Console as root.
cat >"$command_stage" <<'EOF'
#!/bin/sh
set -eu
service_user=brocade
runtime=/opt/brocade/brocade-launcher
installation_type_path=/etc/brocade/installation-type
public_url_path=/etc/brocade/agent-public-url
database_type_path=/etc/brocade/database-type
database_url_path=/etc/brocade/database-url
: "${BROCADE_DATA_DIR:=/var/lib/brocade}"
: "${BROCADE_CACHE_DIR:=/var/cache/brocade}"
export BROCADE_DATA_DIR BROCADE_CACHE_DIR

installation_type=
if [ -r "$installation_type_path" ]; then
    IFS= read -r installation_type < "$installation_type_path" || {
        printf 'brocade: 无法读取安装类型配置\n' >&2
        exit 1
    }
fi
case $installation_type in
    tunnel) ;;
    site)
        if [ -z "${BROCADE_AGENT_PUBLIC_URL:-}" ]; then
            [ -r "$public_url_path" ] || {
                printf 'brocade: 已有站点模式缺少公网地址配置\n' >&2
                exit 1
            }
            IFS= read -r BROCADE_AGENT_PUBLIC_URL < "$public_url_path" || {
                printf 'brocade: 无法读取公网地址配置\n' >&2
                exit 1
            }
            case $BROCADE_AGENT_PUBLIC_URL in
                https://?*) ;;
                *)
                    printf 'brocade: 公网地址配置必须使用 https://\n' >&2
                    exit 1
                    ;;
            esac
            export BROCADE_AGENT_PUBLIC_URL
        fi
        ;;
    '') ;;
    *)
        printf 'brocade: 未识别的安装类型配置：%s\n' "$installation_type" >&2
        exit 1
        ;;
esac

database_type=
if [ -r "$database_type_path" ]; then
    IFS= read -r database_type < "$database_type_path" || {
        printf 'brocade: 无法读取数据库类型配置\n' >&2
        exit 1
    }
fi
case $database_type in
    managed) ;;
    external)
        if [ -z "${DATABASE_URL:-}" ]; then
            [ -r "$database_url_path" ] || {
                printf 'brocade: 外部数据库模式缺少连接地址配置\n' >&2
                exit 1
            }
            IFS= read -r DATABASE_URL < "$database_url_path" || {
                printf 'brocade: 无法读取数据库连接地址配置\n' >&2
                exit 1
            }
            case $DATABASE_URL in
                postgres://?*|postgresql://?*) ;;
                *)
                    printf 'brocade: 数据库连接地址必须使用 postgres:// 或 postgresql://\n' >&2
                    exit 1
                    ;;
            esac
            export DATABASE_URL
        fi
        ;;
    '') ;;
    *)
        printf 'brocade: 未识别的数据库类型配置：%s\n' "$database_type" >&2
        exit 1
        ;;
esac

if { [ "${1-}" = up ] || [ "${1-}" = url ]; } && [ "$installation_type" = tunnel ]; then
    tunnel_requested=false
    for argument in "$@"; do
        [ "$argument" = --tunnel ] && tunnel_requested=true
    done
    [ "$tunnel_requested" = true ] || set -- "$@" --tunnel
fi
if [ "${1-}" = up ] && { [ "$database_type" = managed ] || [ "$database_type" = external ]; }; then
    database_requested=false
    for argument in "$@"; do
        case $argument in
            --managed-db|--external-db) database_requested=true ;;
        esac
    done
    if [ "$database_requested" = false ]; then
        if [ "$database_type" = managed ]; then
            set -- "$@" --managed-db
        else
            set -- "$@" --external-db
        fi
    fi
fi

if [ "$(id -u)" -eq 0 ]; then
    HOME=/var/lib/brocade
    export HOME
    if command -v su-exec >/dev/null 2>&1; then
        exec su-exec "$service_user" "$runtime" "$@"
    fi
    if command -v setpriv >/dev/null 2>&1 && setpriv --help 2>&1 | grep -q 'reuid'; then
        uid=$(id -u "$service_user")
        gid=$(id -g "$service_user")
        exec setpriv --reuid="$uid" --regid="$gid" --init-groups "$runtime" "$@"
    fi
    printf 'brocade: 无法切换到 brocade 服务账号\n' >&2
    exit 1
fi

if [ "$(id -u)" -ne "$(id -u "$service_user")" ]; then
    printf 'brocade: 系统安装版只能由 root 或 brocade 服务账号启动\n' >&2
    exit 1
fi
HOME=/var/lib/brocade
export HOME
exec "$runtime" "$@"
EOF
chmod 0755 "$command_stage"

printf '%s\n' "$installation_type" >"$installation_type_stage"
chmod 0644 "$installation_type_stage"
if [ "$installation_type" = site ]; then
    printf '%s\n' "$site_url" >"$public_url_stage"
    chmod 0644 "$public_url_stage"
fi
printf '%s\n' "$database_type" >"$database_type_stage"
chmod 0644 "$database_type_stage"
if [ "$database_type" = external ]; then
    printf '%s\n' "$database_url" >"$database_url_stage"
    chown root:"$service_group" "$database_url_stage"
    chmod 0640 "$database_url_stage"
fi

# Publish Console and launcher before their defaults, then publish the public command last. A
# concurrent invocation therefore uses either the previous wrapper or a complete new configuration.
mv -f "$console_stage" "$console_path"
mv -f "$launcher_stage" "$launcher_path"
install -o root -g root -m 0644 "$script_dir/BROCADE_PLATFORM" "$install_root/BROCADE_PLATFORM"
install -o root -g root -m 0644 "$script_dir/SHA256SUMS" "$install_root/SHA256SUMS"
if [ "$installation_type" = site ]; then
    mv -f "$public_url_stage" "$public_url_path"
    mv -f "$installation_type_stage" "$installation_type_path"
else
    mv -f "$installation_type_stage" "$installation_type_path"
    rm -f "$public_url_path"
fi
if [ "$database_type" = external ]; then
    mv -f "$database_url_stage" "$database_url_path"
    mv -f "$database_type_stage" "$database_type_path"
else
    mv -f "$database_type_stage" "$database_type_path"
    rm -f "$database_url_path"
fi
mv -f "$command_stage" "$command_path"
trap - 0 HUP INT TERM

say "Brocade 已安装完成。"
if [ "$installation_type" = tunnel ]; then
    say "安装类型：Cloudflare Quick Tunnel（临时地址可能在每次启动时变化）"
else
    say "安装类型：已有 HTTPS 站点"
    say "已登记地址：$site_url"
    say "请确认该站点的 DNS、TLS 与反向代理已就绪，并把请求转发到 http://127.0.0.1:8080。"
fi
if [ "$database_type" = managed ]; then
    say "数据库：Brocade 托管 PostgreSQL（首次启动自动下载并初始化）"
else
    say "数据库：已有 PostgreSQL（连接地址已保存到仅 root 与 brocade 账号可读的配置）"
fi
if [ "$start_runtime" = false ]; then
    say "已按 --no-start 跳过启动；运行 sudo brocade up 后打开输出的完整初始化链接。"
    exit 0
fi

if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
    say "当前系统没有 systemd，正在前台启动 Brocade；请保持此终端运行。"
    exec "$command_path" up
fi

service_unit=/etc/systemd/system/brocade.service
if [ -e "$service_unit" ] || [ -L "$service_unit" ]; then
    [ -f "$service_unit" ] && [ ! -L "$service_unit" ] &&
        grep -Fq '# Managed by Brocade installer' "$service_unit" ||
        die "brocade.service 已存在且不由安装器管理；请核对服务配置后使用 --no-start 安装"
fi
cat >"$service_stage" <<EOF
# Managed by Brocade installer
[Unit]
Description=Brocade Console and managed runtime
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
User=$service_user
Group=$service_group
ExecStart=$command_path up
Restart=on-failure
RestartSec=5s
KillMode=mixed
TimeoutStopSec=60s

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$service_stage"
mv -f "$service_stage" "$service_unit"
systemctl daemon-reload
systemctl enable brocade.service
systemctl restart brocade.service

say "正在等待数据库、控制台与公网入口就绪…"
trap 'rm -f "$ready_error"' 0
ready_attempt=0
until "$command_path" url >/dev/null 2>"$ready_error"; do
    ready_attempt=$((ready_attempt + 1))
    if [ "$ready_attempt" -ge 600 ] || systemctl is-failed --quiet brocade.service; then
        cat "$ready_error" >&2
        die "Brocade 未能就绪；请运行 systemctl status brocade.service 和 journalctl -u brocade.service 检查"
    fi
    sleep 1
done
rm -f "$ready_error"
trap - 0
say "Brocade 已启动并设置开机启动。请打开下面的完整链接；首次使用时创建管理员："
"$command_path" url
