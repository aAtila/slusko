"""Runtime dependency compatibility contracts."""

from __future__ import annotations


def test_torchaudio_keeps_pyannote_3_audio_metadata_contract() -> None:
    """pyannote.audio 3.x expects torchaudio.AudioMetaData at diarization time."""

    import torchaudio

    assert hasattr(torchaudio, "AudioMetaData")
