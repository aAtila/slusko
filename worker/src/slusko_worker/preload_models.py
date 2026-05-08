"""Explicit model preload entrypoint for populating the persistent cache volume."""

from __future__ import annotations

import logging

from slusko_worker.config import (
    apply_hf_home_default,
    load_config,
    validate_startup_config,
)
from slusko_worker.main import configure_logging
from slusko_worker.pipeline.diarization import PyannoteDiarizer
from slusko_worker.pipeline.transcription import WhisperTranscriber

logger = logging.getLogger("slusko_worker.preload")


def run() -> int:
    configure_logging()
    config = load_config()
    apply_hf_home_default(config)
    validate_startup_config(config)

    transcriber = WhisperTranscriber(
        whisper_model=config.whisper_model,
        whisper_device=config.whisper_device,
        whisper_compute_type=config.whisper_compute_type,
        model_cache_dir=config.model_cache_dir,
    )
    diarizer = PyannoteDiarizer(
        model_name=config.pyannote_model,
        hf_token=config.huggingface_token,
        model_cache_dir=config.model_cache_dir,
    )

    logger.info("preloading faster-whisper model=%s", config.whisper_model)
    transcriber.preload_model()
    logger.info("preloading pyannote model=%s", config.pyannote_model)
    diarizer.preload_pipeline()

    logger.info("model preload complete; cache_dir=%s", config.model_cache_dir)
    return 0


def main() -> None:
    try:
        raise SystemExit(run())
    except Exception:
        logger.exception("model preload failed")
        raise SystemExit(1) from None
