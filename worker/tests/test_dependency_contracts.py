"""Runtime dependency compatibility contracts."""

from __future__ import annotations

import inspect


def test_huggingface_hub_exposes_modern_auth_keyword_contract() -> None:
    """Our pyannote compatibility shim maps use_auth_token to this keyword."""

    from huggingface_hub import hf_hub_download

    assert "token" in inspect.signature(hf_hub_download).parameters


def test_pyannote_3_pipeline_keeps_legacy_auth_keyword_contract() -> None:
    """The worker passes use_auth_token to pyannote's public pipeline loader."""

    from pyannote.audio import Pipeline

    assert "use_auth_token" in inspect.signature(Pipeline.from_pretrained).parameters


def test_torchaudio_keeps_pyannote_3_audio_metadata_contract() -> None:
    """pyannote.audio 3.x expects torchaudio.AudioMetaData at diarization time."""

    import torchaudio

    assert hasattr(torchaudio, "AudioMetaData")
