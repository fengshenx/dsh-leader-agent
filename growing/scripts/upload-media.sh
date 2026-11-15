#!/usr/bin/env bash
# 上传增长媒体到专用 OSS bucket。
#
# 只做三件事：拒绝已存在的 key、带正确 Content-Type 上传、打印 bytes/sha256。
# 凭据来自本机已配置的 `aliyun` CLI；本脚本不读、不写任何 AccessKey。
#
# 用法：
#   ./growing/scripts/upload-media.sh <本地文件> <case>/<kind>/<文件名> <Content-Type>
#
# 例：
#   ./growing/scripts/upload-media.sh \
#     .dev/promo/video/demo.mp4 \
#     2026-11-16-leader-agent-promo/video/demo-1080x1920.mp4 \
#     video/mp4

set -euo pipefail

BUCKET="${GROWING_OSS_BUCKET:-dsh-agent-leader}"
ENDPOINT="${GROWING_OSS_ENDPOINT:-oss-cn-beijing.aliyuncs.com}"

usage() {
  echo "用法: $0 <本地文件> <case>/<kind>/<文件名> <Content-Type>" >&2
  echo "可选环境变量: GROWING_OSS_BUCKET（默认 ${BUCKET}）、GROWING_OSS_ENDPOINT（默认 ${ENDPOINT}）" >&2
  exit 2
}

if [ "$#" -ne 3 ]; then usage; fi
SRC="$1"
OBJECT_KEY="$2"
CONTENT_TYPE="$3"

if [ ! -f "$SRC" ]; then
  echo "错误: 本地文件不存在: $SRC" >&2
  exit 1
fi
case "$OBJECT_KEY" in
  /*|*..*|growing/*)
    echo "错误: object key 必须是 <case>/<kind>/<文件名>，不要以 / 或 growing/ 开头，也不要用 .." >&2
    exit 1
    ;;
esac
if [ -z "$CONTENT_TYPE" ]; then
  echo "错误: Content-Type 不能为空" >&2
  exit 1
fi

# HTML 不设一年 immutable，避免发版后浏览器一直拿旧页
CACHE_CONTROL="public,max-age=31536000,immutable"
case "$CONTENT_TYPE" in
  text/html*) CACHE_CONTROL="public,max-age=3600" ;;
esac

OSS_KEY="growing/$OBJECT_KEY"
OSS_URL="oss://$BUCKET/$OSS_KEY"

# 先 stat；只有 404 才继续。网络/权限错误不能被当成“不存在”而覆盖旧对象。
STAT_OUTPUT="$(aliyun oss stat "$OSS_URL" -e "$ENDPOINT" 2>&1)" && {
  echo "错误: 对象已存在，拒绝覆盖: $OSS_URL" >&2
  echo "重做请换新 key（例如 -v2），再把新记录追加到 media.json。" >&2
  exit 1
}
case "$STAT_OUTPUT" in
  *StatusCode=404*|*NoSuchKey*|*NoSuchObject*) ;;
  *)
    echo "错误: 无法确认对象是否存在，已中止:" >&2
    echo "$STAT_OUTPUT" | head -5 >&2
    exit 1
    ;;
esac

if command -v shasum >/dev/null 2>&1; then
  SHA256="$(shasum -a 256 "$SRC" | awk '{print $1}')"
else
  SHA256="$(sha256sum "$SRC" | awk '{print $1}')"
fi
BYTES="$(wc -c < "$SRC" | tr -d ' ')"

aliyun oss cp "$SRC" "$OSS_URL" -e "$ENDPOINT" \
  --meta "Content-Type:$CONTENT_TYPE#Cache-Control:$CACHE_CONTROL" \
  --force

PUBLIC_URL="https://$BUCKET.$ENDPOINT/$OSS_KEY"
echo "已上传: $PUBLIC_URL"
echo "bytes: $BYTES"
echo "sha256: $SHA256"
echo "contentType: $CONTENT_TYPE"
echo "cacheControl: $CACHE_CONTROL"
