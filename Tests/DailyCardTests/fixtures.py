"""Entirely synthetic data. No real calendar or weather is stored here."""

from datetime import timedelta
import json
from pathlib import Path

from daily_card.model import Config, Day, iso, local


ROOT = Path(__file__).resolve().parents[2]


def config():
    return Config.parse(json.loads((ROOT / "examples/daily-card-config.json").read_text()))


def day(value="2026-11-15", now=None):
    return Day.create(value, "Europe/Berlin", now or value + "T06:00:00+01:00")


def event(start, end, **extra):
    return {"start": "2026-11-15T" + start + ":00+01:00",
            "end": "2026-11-15T" + end + ":00+01:00", **extra}


def calendar():
    return {"state": "available", "events": [
        event("09:00", "10:00"), event("12:00", "12:30"), event("15:00", "16:00")
    ]}


def weather(context=None):
    context = context or day()
    hours = []
    start = context.start
    while start < context.end:
        hour = start.astimezone(context.zone).hour
        hours.append({"start": iso(start), "cloud": 10 if hour == 12 else 70,
                      "precipitation": 0})
        start += timedelta(hours=1)
    return {"state": "available", "sunrise": iso(local(context.date, 7 * 60, context.zone)),
            "sunset": iso(local(context.date, 18 * 60, context.zone)), "hours": hours}
