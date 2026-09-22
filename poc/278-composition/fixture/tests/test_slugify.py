import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from slugify import slugify


def test_basic():
    assert slugify("Hello World") == "hello-world"


def test_strips_edges():
    assert slugify("  Hello World  ") == "hello-world"


def test_collapses_separators():
    assert slugify("Hello -- World!!") == "hello-world"


def test_no_leading_or_trailing_dash():
    assert slugify("!!Hello!!") == "hello"
