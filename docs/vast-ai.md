# Stable Vast.ai GPU worker deployment (non-Serverless)

This repository is the transcoding worker. The GPU image does not contain or
start the MyTurn Next.js application. Its only long-running process is the
transcoder service, which accepts authenticated remote jobs, drains its durable
internal queue, transfers media to and from Cloudflare R2, and sends signed
completion webhooks to the backend.

This is the Coolify-style deployment path: one persistent HTTP service listens
on port `3000`. It does not start `worker.py`, does not use the Vast PyWorker
SDK, and does not require `REPORT_ADDR`, `CONTAINER_ID`, `WORKER_PORT`, or a
Serverless endpoint/workergroup.

## 1. Build `linux/amd64` on Apple Silicon

Start Docker Desktop and make sure BuildKit is available:

```bash
docker buildx version
```

From this repository, choose an immutable tag and build the x86-64 image into
the local Docker image store:

```bash
export GHCR_IMAGE=ghcr.io/emirozdis/ffmpeg-api
export IMAGE_TAG="stable-$(git rev-parse --short=12 HEAD)"

docker buildx build \
  --platform linux/amd64 \
  --file Dockerfile.gpu \
  --build-arg VCS_REF="$(git rev-parse HEAD)" \
  --tag "$GHCR_IMAGE:$IMAGE_TAG" \
  --tag "$GHCR_IMAGE:vast-stable" \
  --tag "$GHCR_IMAGE:gpu" \
  --load \
  .
```

The image deliberately checks for a working NVENC device when it starts. It
therefore cannot be run normally on the Mac. Static image checks still work:

```bash
docker image inspect "$GHCR_IMAGE:$IMAGE_TAG" \
  --format '{{.Os}}/{{.Architecture}} {{json .Config.Entrypoint}} {{json .Config.Cmd}}'
```

The expected platform is `linux/amd64` and the command ends in
`node dist/index.js`.

## 2. Publish to GitHub Container Registry

Create a GitHub token that can write packages. Never place it in the Dockerfile
or commit it to an environment file.

```bash
export GHCR_USER=emirozdis
read -s GHCR_TOKEN
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username "$GHCR_USER" --password-stdin
unset GHCR_TOKEN

docker push "$GHCR_IMAGE:$IMAGE_TAG"
docker push "$GHCR_IMAGE:vast-stable"
docker push "$GHCR_IMAGE:gpu"
```

Use the immutable `stable-<commit>` tag in production. `vast-stable` and `gpu`
are only convenient moving aliases. Do not use the `serverless` tag for this
deployment. Make the GHCR package public for credential-free Vast.ai pulls, or
configure the GHCR username and a read-only package token in the private Vast.ai
template's registry fields.

## 3. Create the Vast.ai template

Use these template settings:

- Image: `ghcr.io/emirozdis/ffmpeg-api:<immutable-tag>`
- Launch mode: **Entrypoint** (called `args` by the API)
- Arguments: leave empty so the image's `CMD` starts the worker
- Disk: enough for the largest source plus all temporary renditions; 20 GB is a
  reasonable starting point for short-form media
- Port: TCP `3000` (the image also declares `EXPOSE 3000`)

Add non-secret settings to the template:

```text
-e PORT=3000
-e HOST=0.0.0.0
-e ENABLE_VAST_SERVERLESS=false
-e REQUIRE_RUNTIME_CONFIG=true
-e VIDEO_ENCODER=h264_nvenc
-e NVENC_PRESET=p3
-e NVENC_TUNE=hq
-e REQUIRE_NVENC=true
-e REQUIRE_CUDA_PIPELINE=true
-e CUDA_DEVICE=0
-e CUDA_DECODE_MODE=auto
-e GPU_TELEMETRY_INTERVAL_MS=5000
-e MAX_CONCURRENT_JOBS=1
-e MAX_CONCURRENT_JOBS_CAP=1
-e AUTO_SCALE_CONCURRENCY=false
-e TRANSCODER_ALLOWED_WEBHOOK_ORIGINS=https://your-backend.example
```

Store these secrets in Vast.ai account-level environment variables or in a
private template, not in a public template. The container exits immediately if
any of these values are absent, and the webhook secret must contain at least 32
characters:

```text
API_KEY
TRANSCODER_WEBHOOK_SECRET
CLOUDFLARE_R2_ACCOUNT_ID
CLOUDFLARE_R2_ACCESS_KEY_ID
CLOUDFLARE_R2_SECRET_ACCESS_KEY
CLOUDFLARE_R2_BUCKET_NAME
```

`TRANSCODER_ALLOWED_WEBHOOK_ORIGINS` is also required and must contain the exact
backend origin, such as `https://myturn.app`. Do not add `REPORT_ADDR`,
`PYWORKER_REPO`, `WORKER_PORT`, or `WORKER_HTTP_PORT`.

One HLS job prefers NVDEC hardware decoding, keeps frames in GPU memory through
three `scale_cuda` rendition branches, and opens three NVENC encoders. If NVDEC
cannot initialize, `CUDA_DECODE_MODE=auto` falls back to software decoding and
a CUDA upload before the same GPU scaling and encoding stages. The `p3` preset
balances fast completion with phone-viewing quality, while disabled NVENC
multipass prioritizes speed. Start with one
job at a time. Raise concurrency only after checking the selected GPU's
encode-session capacity and observing memory/throughput. While a job is active,
the worker logs overall GPU, encoder, decoder, memory, and power telemetry every
five seconds.

## 4. Connect the backend

Vast.ai maps container port `3000` to a host IP and external port. Set the web
application's `TRANSCODER_API_URL` to the resulting endpoint:

```text
http://<VAST_PUBLIC_IP>:<VAST_EXTERNAL_PORT>/api/v1/videos/process-remote
```

Then restart the web application so new jobs are dispatched to this worker.
The dispatch request uses `API_KEY`; completion callbacks use
`TRANSCODER_WEBHOOK_SECRET` and are restricted to the exact origin in
`TRANSCODER_ALLOWED_WEBHOOK_ORIGINS`.

An ordinary Vast.ai public TCP mapping is plain HTTP. Do not send production
credentials through it over the public internet. Put the worker behind a TLS
tunnel/private network, or add a backend claim endpoint and convert dispatch to
outbound polling before production use. The current application contract is a
push model, so the worker must remain reachable by the backend.

On the Coolify backend, configure the ordinary worker path and remove the
Serverless selection variables:

```text
TRANSCODER_API_URL=http://<VAST_PUBLIC_IP>:<VAST_EXTERNAL_PORT>
TRANSCODER_API_KEY=<same-value-as-worker-API_KEY>

# Remove/unset these if they were added for the previous deployment:
VAST_SERVERLESS_ENDPOINT_NAME
VAST_SERVERLESS_ENDPOINT_API_KEY
VAST_API_KEY
```

`TRANSCODER_API_URL` may be the base URL shown above or the complete
`/api/v1/videos/process-remote` URL; the backend normalizes either form.

## 5. Verify on the rented GPU

The entrypoint first probes the three-rendition NVDEC -> `scale_cuda` -> NVENC
path without allocating unnecessary extra decode surfaces. If NVDEC cannot
initialize, it probes software decode -> `hwupload_cuda` -> `scale_cuda` ->
NVENC instead. The container exits only when neither GPU encoding path works.
The `CUDA_PIPELINE_READY` log reports either `decode=nvdec` or
`decode=software`.

After startup, verify:

```bash
curl http://<VAST_PUBLIC_IP>:<VAST_EXTERNAL_PORT>/health

curl -H "x-api-key: $API_KEY" \
  http://<VAST_PUBLIC_IP>:<VAST_EXTERNAL_PORT>/api/v1/system/health
```

The first request should return `{"status":"healthy"}`. The authenticated
health request should report HTTP `200`, environment checks, and an available
GPU. Startup logs should contain `HLS Encoder : h264_nvenc`. Submit one real remote
job and confirm that the R2 output contains `master.m3u8`, all three variant
playlists, and their segments, followed by a successful signed webhook.

The queue state lives in `/data/state`. It survives process restarts only when
that path is backed by storage that survives the restart. Destroying a rented
instance destroys its local queue unless a persistent volume is attached, so
the backend should continue retrying jobs that never report completion.
