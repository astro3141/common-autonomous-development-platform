"""Disposable synthetic fixture for the #278 composition PoC.

Converts text to URL-friendly slugs by:
- Lowercasing and trimming whitespace
- Collapsing sequences of non-alphanumeric characters into single dashes
- Removing leading and trailing dashes
"""

import re


def slugify(text: str) -> str:
    text = text.strip().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = text.strip("-")
    return text
