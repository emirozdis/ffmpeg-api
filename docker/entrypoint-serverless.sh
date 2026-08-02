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
    echo >&2 'Fatal: NVIDIA NVENC is not usable. Vast must attach an NVIDIA GPU with video capability.'
    sed -n '1,20p' "$probe_log" >&2
    rm -f "$probe_log"
    exit 1
  fi
  rm -f "$probe_log"
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
