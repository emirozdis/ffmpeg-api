#!/bin/sh
set -eu

if [ "${ENABLE_VAST_SERVERLESS:-false}" = 'true' ]; then
  echo >&2 'Fatal: Dockerfile.gpu is the always-on worker and cannot run with ENABLE_VAST_SERVERLESS=true.'
  echo >&2 'Use Dockerfile.serverless only for a Vast Serverless workergroup.'
  exit 1
fi

if [ "${REQUIRE_RUNTIME_CONFIG:-true}" = 'true' ]; then
  missing=''
  for name in \
    API_KEY \
    TRANSCODER_WEBHOOK_SECRET \
    TRANSCODER_ALLOWED_WEBHOOK_ORIGINS \
    CLOUDFLARE_R2_ACCOUNT_ID \
    CLOUDFLARE_R2_ACCESS_KEY_ID \
    CLOUDFLARE_R2_SECRET_ACCESS_KEY \
    CLOUDFLARE_R2_BUCKET_NAME
  do
    if [ -z "$(printenv "$name" 2>/dev/null || true)" ]; then
      missing="$missing $name"
    fi
  done

  if [ -n "$missing" ]; then
    echo >&2 "Fatal: missing required stable-worker environment variables:$missing"
    exit 1
  fi

  webhook_secret="$(printenv TRANSCODER_WEBHOOK_SECRET)"
  if [ "${#webhook_secret}" -lt 32 ]; then
    echo >&2 'Fatal: TRANSCODER_WEBHOOK_SECRET must contain at least 32 characters.'
    exit 1
  fi
  unset webhook_secret
fi

if ! ffmpeg -hide_banner -encoders 2>/dev/null | grep -q '[[:space:]]h264_nvenc[[:space:]]'; then
  echo >&2 'Fatal: this FFmpeg build does not contain the h264_nvenc encoder.'
  exit 1
fi

if [ "${REQUIRE_NVENC:-true}" = 'true' ]; then
  probe_log="$(mktemp)"
  if ! ffmpeg -hide_banner -loglevel error \
    -f lavfi -i 'color=size=720x1280:rate=1' \
    -frames:v 1 -c:v h264_nvenc -f null - 2>"$probe_log"; then
    echo >&2 'Fatal: NVIDIA NVENC is not usable. Start this image with an NVIDIA GPU and video driver capability.'
    sed -n '1,20p' "$probe_log" >&2
    rm -f "$probe_log"
    exit 1
  fi
  rm -f "$probe_log"
fi

if [ "${REQUIRE_CUDA_PIPELINE:-true}" = 'true' ]; then
  if ! ffmpeg -hide_banner -hwaccels 2>/dev/null | grep -qx 'cuda'; then
    echo >&2 'Fatal: this FFmpeg build does not expose CUDA hardware acceleration.'
    exit 1
  fi
  if ! ffmpeg -hide_banner -filters 2>/dev/null | grep -q '[[:space:]]scale_cuda[[:space:]]'; then
    echo >&2 'Fatal: this FFmpeg build does not contain the scale_cuda filter.'
    exit 1
  fi

  cuda_device="${CUDA_DEVICE:-0}"
  gpu_probe_dir="$(mktemp -d)"
  gpu_probe_log="$gpu_probe_dir/pipeline.log"
  if ! ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i 'testsrc2=size=720x1280:rate=30:duration=0.2' \
    -c:v libx264 -pix_fmt yuv420p "$gpu_probe_dir/input.mp4" 2>"$gpu_probe_log"; then
    echo >&2 'Fatal: unable to create the CUDA pipeline probe input.'
    sed -n '1,40p' "$gpu_probe_log" >&2
    rm -rf "$gpu_probe_dir"
    exit 1
  fi
  if ! ffmpeg -hide_banner -loglevel error -y \
    -hwaccel cuda -hwaccel_device "$cuda_device" -hwaccel_output_format cuda -extra_hw_frames 16 \
    -i "$gpu_probe_dir/input.mp4" \
    -filter_complex '[0:v]split=3[v1080src][v720src][v480src];[v1080src]scale_cuda=w=-2:h=1920:format=yuv420p:interp_algo=bilinear:passthrough=0[v1080out];[v720src]scale_cuda=w=-2:h=1280:format=yuv420p:interp_algo=bilinear:passthrough=0[v720out];[v480src]scale_cuda=w=-2:h=854:format=yuv420p:interp_algo=bilinear:passthrough=0[v480out]' \
    -map '[v1080out]' -map '[v720out]' -map '[v480out]' \
    -frames:v 1 -c:v h264_nvenc -gpu "$cuda_device" -preset p3 -tune hq -multipass disabled \
    -f null - 2>"$gpu_probe_log"; then
    echo >&2 'Fatal: the NVDEC/CUDA-scale/three-session-NVENC pipeline is not usable.'
    sed -n '1,80p' "$gpu_probe_log" >&2
    rm -rf "$gpu_probe_dir"
    exit 1
  fi
  rm -rf "$gpu_probe_dir"
  echo "CUDA_PIPELINE_READY device=$cuda_device decode=nvdec scale=scale_cuda encode=h264_nvenc renditions=3"
fi

exec "$@"
