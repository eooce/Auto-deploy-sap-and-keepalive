#!/bin/sh

# 环境变量配置
EMAIL="xxxxx@xxxx.com"   # 登录邮箱
PASSWORD="xxxxxxxxx"     # 登录密码
SG_ORG="xxxxtrial"       # SG组织名称
US_ORG=""                # US组织名称
SPACE="dev" # 多区请使用同样的空间名称

# 要保活的URL列表,多个用英文空格分隔
URLS="https://xxxx.cfapps.ap21.hana.ondemand.com https://xxxx.cfapps.us10-001.hana.ondemand.com"  

# 颜色定义
green() {
    echo -e "\e[1;32m$1\033[0m"
}
red() {
    echo -e "\e[1;91m$1\033[0m"
}
yellow() {
    echo -e "\e[1;33m$1\033[0m"
}

# 检测并安装SAP CLI
install_cf_cli() {
    if command -v cf >/dev/null 2>&1; then
        green "SAP CLI已安装，跳过安装步骤"
        return 0
    fi
    
    yellow "未检测到SAP CLI，开始安装..."
    
    # 检测系统架构
    ARCH=$(uname -m)
    case $ARCH in
        x86_64|amd64)
            CF_PACKAGE="cf8-cli-installer_8.14.1_x86-64.deb"
            ;;
        aarch64|arm64)
            CF_PACKAGE="cf8-cli-installer_8.14.1_arm64.deb"
            ;;
        *)
            red "不支持的架构: $ARCH"
            exit 1
            ;;
    esac
    
    # 下载并安装
    DOWNLOAD_URL="https://github.com/cloudfoundry/cli/releases/latest/download/$CF_PACKAGE"
    
    # Alpine使用apk安装必要的依赖
    if command -v apk >/dev/null 2>&1; then
        apk add --no-cache ca-certificates
        apk add --no-cache wget
        wget -O /tmp/cf-cli.deb "$DOWNLOAD_URL"
        apk add --no-cache --virtual .cf-deps dpkg
        dpkg -x /tmp/cf-cli.deb /tmp/cf-cli
        cp /tmp/cf-cli/usr/bin/cf /usr/local/bin/
        apk del .cf-deps
        rm -rf /tmp/cf-cli.deb /tmp/cf-cli
    elif command -v apt >/dev/null 2>&1; then
        apt-get update
        apt-get install -y wget
        wget -O /tmp/cf-cli.deb "$DOWNLOAD_URL"
        dpkg -i /tmp/cf-cli.deb || apt-get install -f -y
        rm /tmp/cf-cli.deb
    else 
        red "不支持的操作系统"
    fi
    
    if command -v cf >/dev/null 2>&1; then
        green "SAP CLI 安装成功"
    fi
}

# 登录CF
login_cf() {
    local region="$1"
    local api_endpoint=""
    
    case "$region" in
        "us")
            api_endpoint="https://api.cf.us10-001.hana.ondemand.com"
            ORG=$US_ORG
            ;;
        "sg")
            api_endpoint="https://api.cf.ap21.hana.ondemand.com"
            ORG=$SG_ORG
            ;;
        *)
            red "未知区域: $region"
            return 1
            ;;
    esac
    
    green "登录到 $region 区域..."
    cf login -a "$api_endpoint" -u "$EMAIL" -p "$PASSWORD" -o "$ORG" -s "$SPACE"
    
    # 检查登录是否成功
    if [ $? -ne 0 ]; then
        red "登录失败"
        return 1
    fi
    
    return 0
}

# 获取应用名称列表
get_app_names() {
    # 确保已登录
    if ! cf target >/dev/null 2>&1; then
        red "未登录到CF，无法获取应用列表"
        return 1
    fi
    
    # 获取应用列表
    cf apps | awk 'NR>3 {print $1}' | grep -v '^$'
}

# 重启应用
restart_apps() {
    yellow "获取应用列表..."
    APP_NAMES=$(get_app_names)
    
    if [ -z "$APP_NAMES" ]; then
        red "未找到任何应用"
        return 1
    fi
    
    green "找到应用: $APP_NAMES"
    
    for APP_NAME in $APP_NAMES; do
        yellow "重启应用: $APP_NAME"
        cf restart "$APP_NAME"
        sleep 15  # 间隔15秒
    done
}

# URL监控函数
monitor_urls() {
    for URL in $URLS; do
        yellow "检查 URL: $URL"
        
        # 使用curl检查URL状态
        STATUS_CODE=$(curl -o /dev/null -s -w "%{http_code}" --connect-timeout 10 "$URL")
        
        if [ "$STATUS_CODE" -ne 200 ]; then
            yellow "检测到异常状态码: $STATUS_CODE"
            
            # 检查URL中是否包含特定区域标识
            if echo "$URL" | grep -q "us10-001"; then
                yellow "检测到US区域应用异常，执行重启..."
                if login_cf "us"; then
                    restart_apps
                else
                    red "登录失败，无法重启应用"
                fi
            elif echo "$URL" | grep -q "ap21"; then
                yellow "检测到SG区域应用异常，执行重启..."
                if login_cf "sg"; then
                    restart_apps
                else
                    red "登录失败，无法重启应用"
                fi
            else
                red "URL不包含已知区域标识，跳过处理"
            fi
        else
            green "状态正常: $STATUS_CODE"
        fi
    done
}

# 设置上海时区
setup_timezone() {
    if [ -f /etc/alpine-release ]; then
        # Alpine系统
        apk add --no-cache tzdata >/dev/null 2>&1
        cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime >/dev/null 2>&1
        echo "Asia/Shanghai" > /etc/timezone 
        # apk del tzdata
    else
        # 其他系统
        ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime
    fi

    local system_time=$(date +"%Y-%m-%d %H:%M")
    local beijing_time=$(TZ=Asia/Shanghai date +"%Y-%m-%d %H:%M")

    if [ "$system_time" = "$beijing_time" ]; then
        green "✅ 系统已设置为上海时区"
    else
        red "❌ 上海时区未生效,请运行工具箱--系统工具 bash <(curl -Ls ssh_tool.eooce.com) 设置时区为上海时间后再运行脚本"
    fi
}

add_cron_job() {
    SCRIPT_PATH=$(readlink -f "$0")

    # 设置上海时区
    setup_timezone

    if [ -f /etc/alpine-release ]; then
        if ! command -v crond >/dev/null 2>&1; then
            apk add --no-cache cronie bash >/dev/null 2>&1 &
            rc-update add crond && rc-service crond start >/dev/null 2>&1
        fi
    elif command -v apt >/dev/null 2>&1; then
        if ! command -v cron >/dev/null 2>&1; then
            DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null 2>&1
            DEBIAN_FRONTEND=noninteractive apt-get install -y cron >/dev/null 2>&1
        fi
    else
        red "不支持的操作系统" && exit 1
    fi
    
    # 检查定时任务是否已经存在
    if ! crontab -l 2>/dev/null | grep -q "$SCRIPT_PATH"; then
        (crontab -l 2>/dev/null; echo "*/2 8-9 * * * /bin/bash $SCRIPT_PATH >> /root/keep-sap.log 2>&1") | crontab -
        green "已添加计划任务，8-9点每两分钟执行一次"
    else
        green "计划任务已存在，跳过添加计划任务"
    fi
}


# 主函数
main() {
install_cf_cli
add_cron_job
monitor_urls
}

# 执行主函数
main 
