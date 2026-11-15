"""Optional adapters. Neither rendering nor tests require WorkIQ or a network."""

from datetime import datetime
import json
import re
from urllib.parse import urlencode
from urllib.request import urlopen

from .model import DataError, UTC, instant, iso, normalize_calendar, normalize_weather, number


MAX_BYTES = 256 * 1024


def graph_calendar(raw, day):
    """Graph calendarView requested with UTC times and a timing-only $select.

    Ignore all non-allowlisted provider fields without copying raw event objects.
    A nextLink means coverage is incomplete, never a successful partial day.
    """
    if not isinstance(raw, dict) or raw.get("@odata.nextLink") or not isinstance(raw.get("value"), list):
        raise DataError("Calendar response is unavailable or incomplete.")
    events = []
    for event in raw["value"]:
        if not isinstance(event, dict):
            raise DataError("Calendar event must be an object.")
        times = []
        for key in ("start", "end"):
            stamp = event.get(key)
            if not isinstance(stamp, dict) or stamp.get("timeZone") not in ("UTC", "Etc/UTC"):
                raise DataError("Calendar adapter requires explicitly requested UTC provider times.")
            text = stamp.get("dateTime")
            if not isinstance(text, str):
                raise DataError("Calendar adapter requires valid timing fields.")
            # Graph commonly returns seven fractional digits, with no offset.
            if not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?", text):
                raise DataError("Invalid UTC provider timestamp.")
            if "." in text:
                prefix, fraction = text.split(".")
                text = prefix + "." + fraction[:6]
            times.append(text + "Z")
        events.append({"start": times[0], "end": times[1],
                       "is_cancelled": event.get("isCancelled", False),
                       "is_all_day": event.get("isAllDay", False),
                       "show_as": event.get("showAs", "busy")})
    return normalize_calendar({"state": "available", "events": events}, day)


def open_meteo(raw, day):
    if not isinstance(raw, dict) or raw.get("error"):
        raise DataError("Weather provider failed.")
    hourly, daily = raw.get("hourly"), raw.get("daily")
    if not isinstance(hourly, dict) or not isinstance(daily, dict):
        raise DataError("Weather provider fields are missing.")
    if raw.get("hourly_units") != {"time": "unixtime", "cloud_cover": "%", "precipitation": "mm"}:
        raise DataError("Unexpected weather units.")
    if raw.get("daily_units") != {"time": "unixtime", "sunrise": "unixtime", "sunset": "unixtime"}:
        raise DataError("Unexpected sunrise/sunset units.")

    def stamp(value):
        number(value, 0, 253402300799)
        try:
            return iso(datetime.fromtimestamp(value, UTC))
        except (ValueError, OverflowError, OSError):
            raise DataError("Invalid weather timestamp.") from None

    keys = ("time", "cloud_cover", "precipitation")
    if any(not isinstance(hourly.get(key), list) for key in keys):
        raise DataError("Incomplete weather hour arrays.")
    if len({len(hourly[key]) for key in keys}) != 1 or len(hourly["time"]) > 26:
        raise DataError("Mismatched weather hour arrays.")
    if any(not isinstance(daily.get(key), list) or len(daily[key]) != 1 for key in ("time", "sunrise", "sunset")):
        raise DataError("Expected exactly one day of sun times.")
    times = [stamp(timestamp) for timestamp in hourly["time"]]
    if any(instant(b) <= instant(a) for a, b in zip(times, times[1:])):
        raise DataError("Weather provider timestamps must be strictly increasing.")
    hours = []
    # Open-Meteo precipitation is a PRECEDING-hour sum; cloud is instantaneous.
    # Pair cloud at t with rain at t+1h. Without that endpoint the interval is
    # unknown. A single-day request covers all windows (which finish by 20:00).
    for index in range(len(times) - 1):
        if (instant(times[index + 1]) - instant(times[index])).total_seconds() != 3600:
            continue
        start = times[index]
        cloud, rain = hourly["cloud_cover"][index], hourly["precipitation"][index + 1]
        if cloud is None or rain is None:
            continue  # Missing data is an uncovered hour, not clear or dry weather.
        hours.append({"start": start, "cloud": cloud, "precipitation": rain})
    return normalize_weather({"state": "available", "sunrise": stamp(daily["sunrise"][0]),
                              "sunset": stamp(daily["sunset"][0]), "hours": hours}, day)


def fetch_weather(config, day):
    query = urlencode({
        "latitude": config.latitude, "longitude": config.longitude, "timezone": config.timezone,
        "start_date": day.date.isoformat(), "end_date": day.date.isoformat(),
        "hourly": "cloud_cover,precipitation", "daily": "sunrise,sunset", "timeformat": "unixtime",
    })
    # Fixed public host, bounded response and timeout; no credentials or calendar
    # content ever enter the URL. Network/HTTP errors propagate to the CLI.
    with urlopen("https://api.open-meteo.com/v1/forecast?" + query, timeout=20) as response:
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise DataError("Weather response exceeds its size limit.")
    return open_meteo(json.loads(data), day)
