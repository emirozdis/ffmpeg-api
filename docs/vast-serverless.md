# Vast.ai Serverless deployment

This is the scale-to-zero deployment path. The image runs only the transcoder:

1. Vast routes `POST /transcode` to the bundled PyWorker on port `5000`.
2. PyWorker serially forwards the payload to the private Node service on
   `127.0.0.1:3000`.
3. Node downloads the source from R2, creates the three-rendition NVENC HLS
   output, uploads it to R2, and sends the signed backend webhook.
4. Only then does the request finish, allowing Vast to safely release the GPU.

The Node port is deliberately bound to loopback and is not publicly exposed.
Do not set `PYWORKER_REPO`; `worker.py` and its pinned SDK are already included
in the image.

## Build and publish from Apple Silicon

Run from the repository root:

```bash
export GHCR_IMAGE=ghcr.io/emirozdis/ffmpeg-api
export IMAGE_TAG="serverless-$(git rev-parse --short=12 HEAD)"

docker buildx build \
  --platform linux/amd64 \
  --file Dockerfile.serverless \
  --build-arg VCS_REF="$(git rev-parse HEAD)" \
  --tag "$GHCR_IMAGE:$IMAGE_TAG" \
  --tag "$GHCR_IMAGE:serverless" \
  --load \
  .

read -s GHCR_TOKEN
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username emirozdis --password-stdin
unset GHCR_TOKEN
docker push "$GHCR_IMAGE:$IMAGE_TAG"
docker push "$GHCR_IMAGE:serverless"
```

Use the immutable tag in the Vast template. Make the GHCR package public, or
configure a read-only GitHub Packages token in the template registry fields.

## Endpoint fields

Use these scale-to-zero starting values:

| Field | Value |
| --- | ---: |
| Endpoint Name | `myturn-transcoder` |
| Minimum Workers | `0` |
| Max Workers | `1` |
| Minimum Load | `0` |
| Target Utilization | `0.8` |
| Cold Multiplier | `0` |
| Minimum Cold Load | `0` |
| Max Queue Time | `300` seconds |
| Target Queue Time | `30` seconds |
| Inactivity timeout | enabled, `300` seconds |

Minimum Workers `0` is what permits scale-to-zero. Expect a cold start when no
worker is running.

## Template fields

Create a private custom template with:

| Field | Value |
| --- | --- |
| Docker image | `ghcr.io/emirozdis/ffmpeg-api:<immutable-serverless-tag>` |
| Image tag | already included in the image value |
| Launch mode | Entrypoint |
| Entrypoint arguments | empty |
| Disk | `20 GB` initially |
| Public TCP ports | `5000`, `5001` |
| Internal Node port | do not publish `3000` |

The image starts both Node and PyWorker automatically. `WORKER_PORT=5000` and
`WORKER_HTTP_PORT=5001` are image defaults; Vast may inject the same values.

Add the following worker secrets/environment variables. Store them only in a
private template or Vast account secrets:

```text
CLOUDFLARE_R2_ACCOUNT_ID=<account-id>
CLOUDFLARE_R2_ACCESS_KEY_ID=<r2-access-key>
CLOUDFLARE_R2_SECRET_ACCESS_KEY=<r2-secret-key>
CLOUDFLARE_R2_BUCKET_NAME=<physical-bucket-name>
TRANSCODER_WEBHOOK_SECRET=<same-32+-character-value-as-Coolify>
TRANSCODER_ALLOWED_WEBHOOK_ORIGINS=https://your-backend.example
```

Do not add the Coolify database credentials or the full web application to the
template. `API_KEY` is not required for the private loopback Serverless route.

## Workergroup fields and GPU filter

Attach one Workergroup to `myturn-transcoder` and select the custom template.
Use:

| Field | Starting value |
| --- | ---: |
| Test workers | `1` |
| GPU RAM estimate | `8 GB` |
| Number of GPUs | `1` |
| Verified machines | enabled |
| Rentable | enabled |
| Minimum disk space | `20 GB` |
| Minimum download bandwidth | `200 Mbps` |
| Minimum upload bandwidth | `100 Mbps` |

Prefer recent NVENC GPUs such as RTX 3090, RTX 4090, RTX A5000/A6000, L4, or
A10. Start with RTX 3090/A5000-class offers for price/performance, then use
Vast's benchmark results to compare. Avoid GPU families without NVENC support.
The entrypoint performs a real encode and fails the worker immediately if NVENC
is unavailable.

One job creates three simultaneous H.264 NVENC sessions. Keep both endpoint max
workers and per-container concurrency at `1` until a real production video has
been verified.

## Coolify backend variables

The long-lived Coolify backend owns the durable one-at-a-time dispatcher. Set:

```text
CRON_MODE=internal
VAST_SERVERLESS_ENDPOINT_NAME=myturn-transcoder
VAST_SERVERLESS_ENDPOINT_API_KEY=<endpoint-scoped-api-key>
VAST_SERVERLESS_QUEUE_TIMEOUT_MS=900000
VAST_SERVERLESS_WORKER_TIMEOUT_MS=2700000
VAST_SERVERLESS_REQUEST_COST=100
TRANSCODER_DISPATCH_STALE_MINUTES=45
TRANSCODER_WEBHOOK_SECRET=<same-value-as-worker>
```

Prefer the endpoint-scoped key. If it is unavailable, omit
`VAST_SERVERLESS_ENDPOINT_API_KEY` and set `VAST_API_KEY`; the backend will use
the account key only to resolve the endpoint-scoped key.

The existing `TRANSCODER_API_URL` and `TRANSCODER_API_KEY` remain available for
the ordinary always-on worker, but are not used when
`VAST_SERVERLESS_ENDPOINT_NAME` is set.

## First controlled test

1. Publish an immutable image and update the template to that tag.
2. Create the Workergroup with one test worker.
3. Wait for its NVENC benchmark to pass and state to become ready.
4. Configure the Coolify variables and redeploy the backend.
5. Upload one short video.
6. Confirm the database progresses from `QUEUED`/`DISPATCHING` to `COMPLETED`,
   R2 contains `master.m3u8` plus all three variant directories, and the Vast
   worker scales down after the inactivity timeout.

Do not add production traffic or increase max workers before that end-to-end
test passes.
