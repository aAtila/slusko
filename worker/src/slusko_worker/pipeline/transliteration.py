"""Deterministic Serbian Cyrillic-to-Latin transliteration helpers."""

from __future__ import annotations

_SERBIAN_CYRILLIC_TO_LATIN = str.maketrans(
    {
        "А": "A",
        "а": "a",
        "Б": "B",
        "б": "b",
        "В": "V",
        "в": "v",
        "Г": "G",
        "г": "g",
        "Д": "D",
        "д": "d",
        "Ђ": "Đ",
        "ђ": "đ",
        "Е": "E",
        "е": "e",
        "Ж": "Ž",
        "ж": "ž",
        "З": "Z",
        "з": "z",
        "И": "I",
        "и": "i",
        "Ј": "J",
        "ј": "j",
        "К": "K",
        "к": "k",
        "Л": "L",
        "л": "l",
        "Љ": "Lj",
        "љ": "lj",
        "М": "M",
        "м": "m",
        "Н": "N",
        "н": "n",
        "Њ": "Nj",
        "њ": "nj",
        "О": "O",
        "о": "o",
        "П": "P",
        "п": "p",
        "Р": "R",
        "р": "r",
        "С": "S",
        "с": "s",
        "Т": "T",
        "т": "t",
        "Ћ": "Ć",
        "ћ": "ć",
        "У": "U",
        "у": "u",
        "Ф": "F",
        "ф": "f",
        "Х": "H",
        "х": "h",
        "Ц": "C",
        "ц": "c",
        "Ч": "Č",
        "ч": "č",
        "Џ": "Dž",
        "џ": "dž",
        "Ш": "Š",
        "ш": "š",
    }
)


def to_latin_script(text: str) -> str:
    """Return text with Serbian Cyrillic characters transliterated to Latin.

    Already-Latin text and non-Serbian characters are left unchanged.
    """

    return text.translate(_SERBIAN_CYRILLIC_TO_LATIN)
