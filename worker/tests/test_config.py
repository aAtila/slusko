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
