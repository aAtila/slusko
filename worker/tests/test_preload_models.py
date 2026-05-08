from __future__ import annotations

import pytest

from slusko_worker.config import WorkerConfig
from slusko_worker.preload_models import run


class FakeWhisperTranscriber:
    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs
        self.preload_calls = 0

    def preload_model(self) -> None:
        self.preload_calls += 1


class FakePyannoteDiarizer:
    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs
        self.preload_calls = 0

    def preload_pipeline(self) -> None:
        self.preload_calls += 1


def test_run_preloads_whisper_and_pyannote_with_startup_config(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def fake_configure_logging() -> None:
        calls.append("configure_logging")
    config = WorkerConfig(database_url="postgres://example")

    whisper_holder: dict[str, FakeWhisperTranscriber] = {}
    diarizer_holder: dict[str, FakePyannoteDiarizer] = {}

    def fake_load_config() -> WorkerConfig:
        calls.append("load_config")
        return config

    def fake_apply_hf_home_default(_config: WorkerConfig) -> None:
        calls.append("apply_hf_home_default")

    def fake_validate_startup_config(_config: WorkerConfig) -> None:
        calls.append("validate_startup_config")

    def fake_whisper_transcriber(**kwargs: object) -> FakeWhisperTranscriber:
        instance = FakeWhisperTranscriber(**kwargs)
        whisper_holder["instance"] = instance
        return instance

    def fake_diarizer(**kwargs: object) -> FakePyannoteDiarizer:
        instance = FakePyannoteDiarizer(**kwargs)
        diarizer_holder["instance"] = instance
        return instance

    monkeypatch.setattr(
        "slusko_worker.preload_models.configure_logging", fake_configure_logging
    )
    monkeypatch.setattr("slusko_worker.preload_models.load_config", fake_load_config)
    monkeypatch.setattr(
        "slusko_worker.preload_models.apply_hf_home_default", fake_apply_hf_home_default
    )
    monkeypatch.setattr(
        "slusko_worker.preload_models.validate_startup_config",
        fake_validate_startup_config,
    )
    monkeypatch.setattr(
        "slusko_worker.preload_models.WhisperTranscriber", fake_whisper_transcriber
    )
    monkeypatch.setattr("slusko_worker.preload_models.PyannoteDiarizer", fake_diarizer)

    assert run() == 0
    assert calls == [
        "configure_logging",
        "load_config",
        "apply_hf_home_default",
        "validate_startup_config",
    ]

    whisper = whisper_holder["instance"]
    diarizer = diarizer_holder["instance"]

    assert whisper.kwargs == {
        "whisper_model": config.whisper_model,
        "whisper_device": config.whisper_device,
        "whisper_compute_type": config.whisper_compute_type,
        "model_cache_dir": config.model_cache_dir,
    }
    assert diarizer.kwargs == {
        "model_name": config.pyannote_model,
        "hf_token": config.huggingface_token,
        "model_cache_dir": config.model_cache_dir,
    }
    assert whisper.preload_calls == 1
    assert diarizer.preload_calls == 1


def test_run_propagates_startup_validation_error_before_preload(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "slusko_worker.preload_models.load_config",
        lambda: WorkerConfig(database_url="postgres://example"),
    )
    monkeypatch.setattr(
        "slusko_worker.preload_models.apply_hf_home_default", lambda _config: None
    )

    def fail_validation(_config: WorkerConfig) -> None:
        raise RuntimeError("missing required startup config")

    monkeypatch.setattr(
        "slusko_worker.preload_models.validate_startup_config", fail_validation
    )

    def fail_if_called(**_kwargs: object) -> None:
        raise AssertionError("model preload should not start before validation passes")

    monkeypatch.setattr("slusko_worker.preload_models.WhisperTranscriber", fail_if_called)
    monkeypatch.setattr("slusko_worker.preload_models.PyannoteDiarizer", fail_if_called)

    with pytest.raises(RuntimeError, match="missing required startup config"):
        run()
