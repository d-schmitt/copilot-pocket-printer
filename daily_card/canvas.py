"""Bounded stdin adapter to the original daily template, with no provider imports."""

import json
import sys

from .model import Config, DataError, Day, normalize_calendar, normalize_weather
from .template import template


def build(raw):
    fields = {"version", "layout", "config", "date", "now", "calendar", "weather", "bottom", "seed", "synthetic"}
    if not isinstance(raw, dict) or set(raw) != fields or type(raw["version"]) is not int or raw["version"] != 1:
        raise DataError("Expected the documented daily-card fields and version 1.")
    if raw["layout"] != "daily-card" or raw["bottom"] not in ("joke", "sudoku-easy", "sudoku-medium"):
        raise DataError("Use the original daily-card layout with joke or Sudoku.")
    if type(raw["synthetic"]) is not bool:
        raise DataError("Synthetic must explicitly be true or false.")
    config = Config.parse(raw["config"])
    day = Day.create(raw["date"], config.timezone, raw["now"])
    return template(config, day, normalize_calendar(raw["calendar"], day),
                    normalize_weather(raw["weather"], day), raw["bottom"], raw["seed"], raw["synthetic"])


def main():
    try:
        data = sys.stdin.buffer.read(60 * 1024 + 1)
        if len(data) > 60 * 1024:
            raise DataError("Daily-card document exceeds 60 KiB.")
        raw = json.loads(data)
        print(json.dumps(build(raw), ensure_ascii=True))
        return 0
    except DataError as error:
        print("[invalid_daily_card] " + str(error), file=sys.stderr)
    except (ValueError, TypeError, KeyError, OverflowError):
        print("[invalid_daily_card] Invalid daily-card input; no input content logged.", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
