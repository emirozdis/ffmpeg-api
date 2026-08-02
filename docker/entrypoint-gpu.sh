#!/bin/sh
set -eu

if ! ffmpeg -hide_banner -encoders 2>/dev/null | grep -q '[[:space:]]h264_nvenc[[:space:]]'; then
  echo >&2 'Fatal: this FFmpeg build does not contain the h264_nvenc encoder.'
  exit 1
fi

if [ "${REQUIRE_NVENC:-true}" = 'true' ]; then
  probe_log="$(mktemp)"
  if ! ffmpeg -hide_banner -loglevel error \
    -f lavfi -i 'color=size=128x128:rate=1' \
    -frames:v 1 -c:v h264_nvenc -f null - 2>"$probe_log"; then
    echo >&2 'Fatal: NVIDIA NVENC is not usable. Start this image with an NVIDIA GPU and video driver capability.'
    sed -n '1,20p' "$probe_log" >&2
    rm -f "$probe_log"
    exit 1
  fi
  rm -f "$probe_log"
fi

exec "$@"
