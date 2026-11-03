"""Minimal arithmetic helpers used by the Hugin smoke run.

The fixture is intentionally red until the smoke task is implemented:
``multiply`` uses the wrong operator and ``divide`` does not exist yet.
"""


def add(a, b):
    return a + b


def multiply(a, b):
    # BUG: wrong operator; the smoke task must fix this.
    return a - b
