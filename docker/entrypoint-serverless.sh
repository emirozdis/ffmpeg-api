#!/bin/sh
set -eu

if ! ffmpeg -hide_banner -encoders 2>/dev/null | grep -q '[[:space:]]h264_nvenc[[:space:]]'; then
  echo >&2 'Fatal: this FFmpeg build does not contain the h264_nvenc encoder.'
  exit 1
fi

if [ "${REQUIRE_NVENC:-true}" = 'true' ]; then
  probe_log="$(mktemp)"
  if ! ffmpeg -hide_banner -loglevel error \
    -f lavfi -i 'color=size=720x1280:rate=1' \
    -frames:v 1 -c:v h264_nvenc -f null - 2>"$probe_log"; then
    echo >&2 'Fatal: NVIDIA NVENC is not usable. Vast must attach an NVIDIA GPU with video capability.'
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
  requested_decode_mode="${CUDA_DECODE_MODE:-auto}"
  case "$requested_decode_mode" in
    auto|nvdec|software) ;;
    *)
      echo >&2 'Fatal: CUDA_DECODE_MODE must be auto, nvdec, or software.'
      rm -rf "$gpu_probe_dir"
      exit 1
      ;;
  esac

  pipeline_ready=false
  if [ "$requested_decode_mode" != 'software' ]; then
    if ffmpeg -hide_banner -loglevel error -y \
      -hwaccel cuda -hwaccel_device "$cuda_device" -hwaccel_output_format cuda -threads 1 \
      -i "$gpu_probe_dir/input.mp4" \
      -filter_complex '[0:v]split=3[v1080src][v720src][v480src];[v1080src]scale_cuda=w=-2:h=1920:format=yuv420p:interp_algo=bilinear:passthrough=0[v1080out];[v720src]scale_cuda=w=-2:h=1280:format=yuv420p:interp_algo=bilinear:passthrough=0[v720out];[v480src]scale_cuda=w=-2:h=854:format=yuv420p:interp_algo=bilinear:passthrough=0[v480out]' \
      -map '[v1080out]' -map '[v720out]' -map '[v480out]' \
      -frames:v 1 -c:v h264_nvenc -gpu "$cuda_device" -preset p3 -tune hq -multipass disabled \
      -f null - 2>"$gpu_probe_log"; then
      CUDA_DECODE_MODE=nvdec
      export CUDA_DECODE_MODE
      pipeline_ready=true
    elif [ "$requested_decode_mode" = 'nvdec' ]; then
      echo >&2 'Fatal: CUDA_DECODE_MODE=nvdec was requested but NVDEC initialization failed.'
      sed -n '1,80p' "$gpu_probe_log" >&2
      rm -rf "$gpu_probe_dir"
      exit 1
    else
      echo >&2 'Warning: NVDEC initialization failed; trying software decode with CUDA upload.'
      sed -n '1,20p' "$gpu_probe_log" >&2
    fi
  fi

  if [ "$pipeline_ready" != 'true' ]; then
    if ! ffmpeg -hide_banner -loglevel error -y \
      -i "$gpu_probe_dir/input.mp4" \
      -filter_complex "[0:v]format=yuv420p,hwupload_cuda=device=$cuda_device,split=3[v1080src][v720src][v480src];[v1080src]scale_cuda=w=-2:h=1920:format=yuv420p:interp_algo=bilinear:passthrough=0[v1080out];[v720src]scale_cuda=w=-2:h=1280:format=yuv420p:interp_algo=bilinear:passthrough=0[v720out];[v480src]scale_cuda=w=-2:h=854:format=yuv420p:interp_algo=bilinear:passthrough=0[v480out]" \
      -map '[v1080out]' -map '[v720out]' -map '[v480out]' \
      -frames:v 1 -c:v h264_nvenc -gpu "$cuda_device" -preset p3 -tune hq -multipass disabled \
      -f null - 2>"$gpu_probe_log"; then
      echo >&2 'Fatal: the software-decode/CUDA-upload/three-session-NVENC fallback is not usable.'
      sed -n '1,80p' "$gpu_probe_log" >&2
      rm -rf "$gpu_probe_dir"
      exit 1
    fi
    CUDA_DECODE_MODE=software
    export CUDA_DECODE_MODE
  fi
  rm -rf "$gpu_probe_dir"
  echo "CUDA_PIPELINE_READY device=$cuda_device decode=$CUDA_DECODE_MODE scale=scale_cuda encode=h264_nvenc renditions=3"
fi

model_log="${MODEL_LOG_FILE:-/data/logs/model.log}"
mkdir -p "$(dirname "$model_log")"
: > "$model_log"

node dist/index.js >> "$model_log" 2>&1 &
node_pid=$!

/opt/pyworker-venv/bin/python /app/worker.py &
pyworker_pid=$!

shutdown() {
  kill "$pyworker_pid" "$node_pid" 2>/dev/null || true
  wait "$pyworker_pid" "$node_pid" 2>/dev/null || true
}
trap shutdown INT TERM EXIT

ready=false
attempt=0
while [ "$attempt" -lt 120 ]; do
  if ! kill -0 "$node_pid" 2>/dev/null; then
    echo 'TRANSCODER_FATAL Node model server exited during startup.' >> "$model_log"
    exit 1
  fi
  if ! kill -0 "$pyworker_pid" 2>/dev/null; then
    echo 'TRANSCODER_FATAL Vast PyWorker exited during startup.' >> "$model_log"
    exit 1
  fi
  if node -e "fetch('http://127.0.0.1:${PORT:-3000}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    ready=true
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.5
done

if [ "$ready" != 'true' ]; then
  echo 'TRANSCODER_FATAL Node model server did not become healthy.' >> "$model_log"
  exit 1
fi

echo 'TRANSCODER_READY' >> "$model_log"
wait "$pyworker_pid"
