from __future__ import annotations

from slusko_worker.pipeline.transliteration import to_latin_script


def test_transliterates_serbian_cyrillic_sentence_to_latin() -> None:
    assert (
        to_latin_script("Ћао свима, данас причамо о транскрипту.")
        == "Ćao svima, danas pričamo o transkriptu."
    )


def test_already_latin_text_is_unchanged() -> None:
    assert to_latin_script("Zdravo svima, transcript stays Latin.") == (
        "Zdravo svima, transcript stays Latin."
    )


def test_mixed_serbian_and_english_technical_terms_are_preserved() -> None:
    assert to_latin_script("Deploy иде после API review-а у petak.") == (
        "Deploy ide posle API review-a u petak."
    )


def test_serbian_digraph_mappings_keep_expected_casing() -> None:
    assert to_latin_script("Љиљана, Његош и Џон") == "Ljiljana, Njegoš i Džon"
    assert to_latin_script("љ њ џ") == "lj nj dž"
