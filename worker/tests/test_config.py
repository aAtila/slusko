from __future__ import annotations

from slusko_worker.config import apply_hf_home_default, load_config


def test_load_config_sets_listener_autocommit_and_tcp_keepalives() -> None:
    config = load_config({"DATABASE_URL": "postgres://example"})

    assert config.listener_connect_kwargs == {
        "autocommit": True,
        "connect_timeout": 5,
        "keepalives": 1,
        "keepalives_idle": 60,
        "keepalives_interval": 30,
        "keepalives_count": 5,
    }
    assert config.poll_interval_seconds == 300
    assert config.meetings_dir == "/data/meetings"
    assert config.model_cache_dir == "/data/models"
    assert config.hf_home == "/data/models"
    assert config.whisper_model == "large-v3"
    assert config.whisper_device == "auto"
    assert config.whisper_compute_type == "auto"
    assert config.pyannote_model == "pyannote/speaker-diarization-3.1"
    assert config.huggingface_token is None
    assert config.openrouter_api_key is None
    assert config.openrouter_model is None
    assert config.openrouter_base_url == "https://openrouter.ai/api/v1"
    assert config.openrouter_timeout_seconds == 120.0
    assert config.transcription_progress_min_delta == 5
    assert config.transcription_progress_min_interval_seconds == 5.0


def test_load_config_defaults_hf_home_to_model_cache_dir() -> None:
    config = load_config(
        {
            "DATABASE_URL": "postgres://example",
            "MODEL_CACHE_DIR": "/custom/models",
        }
    )

    assert config.model_cache_dir == "/custom/models"
    assert config.hf_home == "/custom/models"


def test_apply_hf_home_default_sets_computed_value_without_overwriting_existing_env() -> (
    None
):
    config = load_config(
        {
            "DATABASE_URL": "postgres://example",
            "MODEL_CACHE_DIR": "/custom/models",
        }
    )
    environ: dict[str, str] = {}

    apply_hf_home_default(config, environ)

    assert environ["HF_HOME"] == "/custom/models"

    apply_hf_home_default(config, environ)

    assert environ["HF_HOME"] == "/custom/models"


def test_load_config_allows_overriding_hf_home() -> None:
    config = load_config(
        {
            "DATABASE_URL": "postgres://example",
            "MODEL_CACHE_DIR": "/custom/models",
            "HF_HOME": "/custom/hf-home",
        }
    )

    assert config.model_cache_dir == "/custom/models"
    assert config.hf_home == "/custom/hf-home"


def test_load_config_allows_overriding_whisper_and_progress_settings() -> None:
    config = load_config(
        {
            "DATABASE_URL": "postgres://example",
            "WHISPER_MODEL": "medium",
            "WHISPER_DEVICE": "cpu",
            "WHISPER_COMPUTE_TYPE": "int8",
            "TRANSCRIPTION_PROGRESS_MIN_DELTA": "10",
            "TRANSCRIPTION_PROGRESS_MIN_INTERVAL_SECONDS": "2.5",
        }
    )

    assert config.whisper_model == "medium"
    assert config.whisper_device == "cpu"
    assert config.whisper_compute_type == "int8"
    assert config.transcription_progress_min_delta == 10
    assert config.transcription_progress_min_interval_seconds == 2.5


def test_load_config_falls_back_for_invalid_progress_settings() -> None:
    config = load_config(
        {
            "DATABASE_URL": "postgres://example",
            "TRANSCRIPTION_PROGRESS_MIN_DELTA": "0",
            "TRANSCRIPTION_PROGRESS_MIN_INTERVAL_SECONDS": "-1",
        }
    )

    assert config.transcription_progress_min_delta == 5
    assert config.transcription_progress_min_interval_seconds == 5.0


def test_load_config_parses_pyannote_model_and_huggingface_token() -> None:
    config = load_config(
        {
            "DATABASE_URL": "postgres://example",
            "PYANNOTE_MODEL": "pyannote/speaker-diarization-3.1-custom",
            "HUGGINGFACE_TOKEN": "primary-token",
        }
    )

    assert config.pyannote_model == "pyannote/speaker-diarization-3.1-custom"
    assert config.huggingface_token == "primary-token"


def test_load_config_uses_hf_token_fallback_when_huggingface_token_missing() -> None:
    config = load_config(
        {
            "DATABASE_URL": "postgres://example",
            "HF_TOKEN": "fallback-token",
        }
    )

    assert config.huggingface_token == "fallback-token"


def test_load_config_prefers_huggingface_token_over_hf_token() -> None:
    config = load_config(
        {
            "DATABASE_URL": "postgres://example",
            "HUGGINGFACE_TOKEN": "primary-token",
            "HF_TOKEN": "fallback-token",
        }
    )

    assert config.huggingface_token == "primary-token"


def test_load_config_parses_openrouter_settings() -> None:
    config = load_config(
        {
            "DATABASE_URL": "postgres://example",
            "OPENROUTER_API_KEY": "openrouter-key",
            "OPENROUTER_MODEL": "anthropic/claude-sonnet-4",
            "OPENROUTER_BASE_URL": "https://openrouter.test/api/v1",
            "OPENROUTER_TIMEOUT_SECONDS": "45.5",
        }
    )

    assert config.openrouter_api_key == "openrouter-key"
    assert config.openrouter_model == "anthropic/claude-sonnet-4"
    assert config.openrouter_base_url == "https://openrouter.test/api/v1"
    assert config.openrouter_timeout_seconds == 45.5


def test_load_config_falls_back_for_invalid_openrouter_timeout() -> None:
    config = load_config(
        {
            "DATABASE_URL": "postgres://example",
            "OPENROUTER_TIMEOUT_SECONDS": "0",
        }
    )

    assert config.openrouter_timeout_seconds == 120.0
