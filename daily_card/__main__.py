"""python3 -m daily_card: assemble JSON, optionally invoke the offline renderer."""

import argparse
from datetime import datetime
from http.client import HTTPException
import json
from pathlib import Path
import subprocess
import sys
from urllib.error import URLError

from .model import CalendarData, Config, DataError, Day, UTC, WeatherData, choose_walk, iso, normalize_calendar, normalize_weather
from .providers import MAX_BYTES, fetch_weather, graph_calendar
from .template import template


def read_json(path):
    with Path(path).open("rb") as handle:
        data = handle.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise DataError("JSON input exceeds 256 KiB.")
    return json.loads(data)


def main():
    parser = argparse.ArgumentParser(description="Assemble a times-only daily-card JSON template. No printer access.")
    parser.add_argument("--config", required=True, help="Reusable location and work-window configuration JSON")
    parser.add_argument("--date", required=True, help="Requested local day, YYYY-MM-DD")
    parser.add_argument("--now", default=datetime.now(UTC).isoformat(), help="Explicit-offset ISO instant, injectable")
    calendar = parser.add_mutually_exclusive_group()
    calendar.add_argument("--calendar", help="Times-only JSON with explicit state and events")
    calendar.add_argument("--graph-calendar", help="Timing-only Graph calendarView response requested in UTC")
    weather = parser.add_mutually_exclusive_group()
    weather.add_argument("--weather", help="Normalized numeric weather JSON")
    weather.add_argument("--fetch-weather", action="store_true", help="Fetch only this date from Open-Meteo")
    parser.add_argument("--bottom", choices=("random", "joke", "sudoku-easy", "sudoku-medium", "art"), default="random")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--synthetic", action="store_true", help="Visibly label injected demonstration data")
    parser.add_argument("--output", required=True, help="New template JSON, never overwrite")
    parser.add_argument("--renderer", help="Optional path to the built card-renderer")
    parser.add_argument("--png", help="New output PNG; requires --renderer")
    args = parser.parse_args()
    if bool(args.renderer) != bool(args.png):
        parser.error("--renderer and --png must be supplied together")
    report = {"status": "error", "template_written": False}
    source = "configuration"
    try:
        config = Config.parse(read_json(args.config))
        day = Day.create(args.date, config.timezone, args.now)
        source = "calendar"
        calendar_data = CalendarData("unavailable")
        if args.calendar:
            calendar_data = normalize_calendar(read_json(args.calendar), day)
        elif args.graph_calendar:
            calendar_data = graph_calendar(read_json(args.graph_calendar), day)
        source = "weather"
        weather_data = WeatherData("unavailable")
        if args.weather:
            weather_data = normalize_weather(read_json(args.weather), day)
        elif args.fetch_weather:
            try:
                weather_data = fetch_weather(config, day)
            except (URLError, TimeoutError, OSError, HTTPException, DataError, ValueError):
                weather_data = WeatherData("unavailable")
        warnings = []
        if calendar_data.state == "unavailable":
            warnings.append({"source": "calendar", "code": "calendar_unavailable",
                             "message": "No verified calendar data; not a zero-meeting result."})
        if weather_data.state == "unavailable":
            warnings.append({"source": "weather", "code": "weather_unavailable",
                             "message": "No verified weather data for the requested date."})
        elif choose_walk(config, day, calendar_data, weather_data).state in ("chosen_partial", "incomplete_weather"):
            warnings.append({"source": "weather", "code": "weather_incomplete",
                             "message": "Some candidate walk slots lack complete hourly weather."})
        for warning in warnings:
            print("[" + warning["code"] + "] " + warning["message"], file=sys.stderr)
        report.update({
            "status": "partial" if warnings else "complete",
            "calendar": calendar_data.state, "weather": weather_data.state, "warnings": warnings,
            "date": day.date.isoformat(), "timezone": config.timezone, "as_of": iso(day.now),
            "weather_source": "synthetic" if args.synthetic else "open-meteo" if args.fetch_weather else "injected",
            "synthetic": args.synthetic,
        })
        source = "template"
        value = template(config, day, calendar_data, weather_data, args.bottom, args.seed, args.synthetic)
        encoded = json.dumps(value, ensure_ascii=True, indent=2) + "\n"
        source = "output"
        with Path(args.output).open("x", encoding="utf-8") as handle:
            handle.write(encoded)
        report["template_written"] = True
        if args.renderer:
            source = "renderer"
            result = subprocess.run([args.renderer, "-", args.png], input=encoded, text=True,
                                    capture_output=True, timeout=30)
            if result.returncode:
                raise DataError("Renderer rejected the card or could not write the PNG; template retained.")
            layout = json.loads(result.stdout)
            if not isinstance(layout, dict) or set(layout) != {"width", "height", "pngBytes", "elements"}:
                raise DataError("Invalid renderer report.")
            report.update(layout)
        print(json.dumps(report))
        # Unavailable providers are explicitly represented in the deliverable and
        # nonzero exit status, not success-shaped empty arrays.
        return 3 if warnings else 0
    except (OSError, DataError, ValueError, subprocess.TimeoutExpired):
        message = "Could not process " + source + "; no input data logged."
        print("[invalid_daily_card] " + message, file=sys.stderr)
        print(json.dumps({**report, "status": "error",
                          "error": {"source": source, "code": "invalid_daily_card", "message": message}}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
