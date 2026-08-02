"""Vast.ai PyWorker adapter for the local Node transcoder model server."""

import math
import os

from vastai import BenchmarkConfig, HandlerConfig, LogActionConfig, Worker, WorkerConfig


MODEL_PORT = int(os.environ.get("PORT", "3000"))
MODEL_LOG_FILE = os.environ.get("MODEL_LOG_FILE", "/data/logs/model.log")


def workload(payload: dict) -> float:
    """Treat one video as one serialized unit of work by default."""
    raw_value = payload.get("workload", 100)
    try:
        value = float(raw_value)
    except (TypeError, ValueError):
        return 100.0
    return value if math.isfinite(value) and value > 0 else 100.0


worker_config = WorkerConfig(
    model_server_url="http://127.0.0.1",
    model_server_port=MODEL_PORT,
    model_log_file=MODEL_LOG_FILE,
    model_healthcheck_url="/health",
    max_sessions=1,
    handlers=[
        HandlerConfig(
            route="/benchmark",
            allow_parallel_requests=False,
            max_queue_time=60.0,
            workload_calculator=workload,
            benchmark_config=BenchmarkConfig(
                dataset=[{"workload": 100}],
                runs=1,
                concurrency=1,
                do_warmup=False,
            ),
        ),
        HandlerConfig(
            route="/transcode",
            allow_parallel_requests=False,
            max_queue_time=float(os.environ.get("PYWORKER_MAX_QUEUE_TIME", "1800")),
            workload_calculator=workload,
        ),
    ],
    log_action_config=LogActionConfig(
        on_load=["TRANSCODER_READY"],
        on_error=["TRANSCODER_FATAL"],
        on_info=["TRANSCODER_INFO"],
    ),
)


if __name__ == "__main__":
    Worker(worker_config).run()
