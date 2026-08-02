# Vast.ai GPU worker deployment

This repository is the transcoding worker. The GPU image does not contain or
start the MyTurn Next.js application. Its only long-running process is the
transcoder service, which accepts authenticated remote jobs, drains its durable
internal queue, transfers media to and from Cloudflare R2, and sends signed
completion webhooks to the backend.

## 1. Build `linux/amd64` on Apple Silicon

Start Docker Desktop and make sure BuildKit is available:

```bash
docker buildx version
```

From this repository, choose an immutable tag and build the x86-64 image into
the local Docker image store:

```bash
export GHCR_IMAGE=ghcr.io/emirozdis/ffmpeg-api
export IMAGE_TAG="$(git rev-parse --short=12 HEAD)"

docker buildx build \
  --platform linux/amd64 \
  --file Dockerfile.gpu \
  --build-arg VCS_REF="$(git rev-parse HEAD)" \
  --tag "$GHCR_IMAGE:$IMAGE_TAG" \
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
docker push "$GHCR_IMAGE:gpu"
```

Use the immutable commit tag in production. The `gpu` tag is only a convenient
moving alias. Make the GHCR package public for credential-free Vast.ai pulls,
or configure the GHCR username and a read-only package token in the private
Vast.ai template's registry fields.

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
-e VIDEO_ENCODER=h264_nvenc
-e REQUIRE_NVENC=true
-e MAX_CONCURRENT_JOBS=1
-e MAX_CONCURRENT_JOBS_CAP=1
-e AUTO_SCALE_CONCURRENCY=false
-e TRANSCODER_ALLOWED_WEBHOOK_ORIGINS=https://your-backend.example
```

Store these secrets in Vast.ai account-level environment variables or in a
private template, not in a public template:

```text
API_KEY
TRANSCODER_WEBHOOK_SECRET
CLOUDFLARE_R2_ACCOUNT_ID
CLOUDFLARE_R2_ACCESS_KEY_ID
CLOUDFLARE_R2_SECRET_ACCESS_KEY
CLOUDFLARE_R2_BUCKET_NAME
```

One HLS job opens three NVENC encoders, one per rendition. Start with one job at
a time. Raise concurrency only after checking the selected GPU's encode-session
capacity and observing memory/throughput.

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

## 5. Verify on the rented GPU

The entrypoint performs a real one-frame NVENC encode before starting Node. A
missing GPU, missing video driver capability, or incompatible driver causes the
container to exit instead of silently falling back to CPU.

After startup, verify:

```bash
curl http://<VAST_PUBLIC_IP>:<VAST_EXTERNAL_PORT>/health

curl -H "x-api-key: $API_KEY" \
  http://<VAST_PUBLIC_IP>:<VAST_EXTERNAL_PORT>/api/v1/system
```

Startup logs should contain `HLS Encoder : h264_nvenc`. Submit one real remote
job and confirm that the R2 output contains `master.m3u8`, all three variant
playlists, and their segments, followed by a successful signed webhook.

The queue state lives in `/data/state`. It survives process restarts only when
that path is backed by storage that survives the restart. Destroying a rented
instance destroys its local queue unless a persistent volume is attached, so
the backend should continue retrying jobs that never report completion.
