"""Validated, times-only calendar and numeric weather boundary."""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
import math
import re
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


UTC = timezone.utc


class DataError(ValueError):
    """Messages are fixed strings, never provider payloads or private fields."""


def instant(value):
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)", value
    ):
        raise DataError("Expected an explicit-offset ISO timestamp with seconds.")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)
    except ValueError:
        raise DataError("Invalid timestamp.") from None


def iso(value):
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def number(value, minimum, maximum):
    if type(value) not in (int, float) or not minimum <= value <= maximum or not math.isfinite(value):
        raise DataError("Numeric data is invalid or outside its supported range.")
    return value


def local(day, minutes, zone):
    naive = datetime.combine(day, time()) + timedelta(minutes=minutes)
    candidates = {
        naive.replace(tzinfo=zone, fold=fold).astimezone(UTC)
        for fold in (0, 1)
        if naive.replace(tzinfo=zone, fold=fold).astimezone(UTC).astimezone(zone).replace(tzinfo=None) == naive
    }
    if len(candidates) != 1:
        raise DataError("A configured local boundary is nonexistent or ambiguous in this timezone.")
    return candidates.pop()


def clock_minutes(value):
    if not isinstance(value, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
        raise DataError("Configuration clock must be HH:MM.")
    return int(value[:2]) * 60 + int(value[3:])


@dataclass(frozen=True)
class Config:
    location: str
    latitude: float
    longitude: float
    timezone: str
    work_start: int
    work_end: int
    lunch_start: int
    lunch_end: int

    @staticmethod
    def parse(raw):
        fields = {"location", "latitude", "longitude", "timezone", "work_start", "work_end", "lunch_start", "lunch_end"}
        if not isinstance(raw, dict) or set(raw) != fields:
            raise DataError("Configuration requires exactly the documented fields.")
        if not isinstance(raw["location"], str) or not 1 <= len(raw["location"]) <= 80 or any(
            ord(c) < 32 for c in raw["location"]
        ):
            raise DataError("Location must be a short single-line template label.")
        try:
            if not isinstance(raw["timezone"], str):
                raise ValueError()
            ZoneInfo(raw["timezone"])
        except (ZoneInfoNotFoundError, ValueError):
            raise DataError("Unknown IANA timezone.") from None
        times = [clock_minutes(raw[key]) for key in ("work_start", "work_end", "lunch_start", "lunch_end")]
        start, end, lunch_start, lunch_end = times
        if not 360 <= start < lunch_start < lunch_end <= end <= 1200:
            raise DataError("Work/lunch times must be ordered within 06:00-20:00.")
        return Config(raw["location"], number(raw["latitude"], -90, 90),
                      number(raw["longitude"], -180, 180), raw["timezone"], *times)


@dataclass(frozen=True)
class Day:
    date: date
    zone: ZoneInfo
    now: datetime
    start: datetime
    end: datetime

    @staticmethod
    def create(day, zone, now):
        try:
            if not isinstance(day, str) or not re.fullmatch(r"\d{4}-\d\d-\d\d", day):
                raise ValueError()
            parsed = date.fromisoformat(day)
            tz = ZoneInfo(zone)
        except (ValueError, ZoneInfoNotFoundError, TypeError):
            raise DataError("Invalid date or IANA timezone.") from None
        try:
            return Day(parsed, tz, instant(now), local(parsed, 0, tz), local(parsed + timedelta(days=1), 0, tz))
        except OverflowError:
            raise DataError("Requested day is outside supported datetime bounds.") from None


@dataclass(frozen=True, order=True)
class Interval:
    start: datetime
    end: datetime


@dataclass(frozen=True)
class CalendarData:
    state: str
    meetings: tuple = ()
    busy: tuple = ()


def normalize_calendar(raw, day):
    if not isinstance(raw, dict) or raw.get("state") not in ("available", "unavailable"):
        raise DataError("Calendar requires an explicit availability state.")
    if raw["state"] == "unavailable":
        if raw.get("events"):
            raise DataError("Unavailable calendar cannot contain events.")
        return CalendarData("unavailable")
    events = raw.get("events")
    if not isinstance(events, list) or len(events) > 500:
        raise DataError("Available calendar requires a bounded events array.")
    meetings, busy = set(), set()
    for event in events:
        if not isinstance(event, dict):
            raise DataError("Calendar event must be an object.")
        # Projection, not deletion: no raw dictionary is retained or copied.
        start, end = instant(event.get("start")), instant(event.get("end"))
        if not timedelta() < end - start <= timedelta(days=31):
            raise DataError("Calendar interval must be positive and at most 31 days.")
        cancelled, all_day = event.get("is_cancelled", False), event.get("is_all_day", False)
        show_as = event.get("show_as", "busy")
        if type(cancelled) is not bool or type(all_day) is not bool or show_as not in (
            "free", "busy", "tentative", "oof", "workingElsewhere", "unknown"
        ):
            raise DataError("Invalid calendar availability flags.")
        if cancelled or show_as == "free" or end <= day.start or start >= day.end:
            continue
        if all_day and (start.astimezone(day.zone).time() != time() or end.astimezone(day.zone).time() != time()):
            raise DataError("All-day busy events must use local midnight boundaries.")
        if not all_day:
            meetings.add(Interval(start, end))
        busy.add(Interval(max(start, day.start), min(end, day.end)))
    merged = []
    for interval in sorted(busy):
        if merged and interval.start <= merged[-1].end:
            merged[-1] = Interval(merged[-1].start, max(merged[-1].end, interval.end))
        else:
            merged.append(interval)
    return CalendarData("available", tuple(sorted(meetings)), tuple(merged))


@dataclass(frozen=True)
class Hour:
    start: datetime
    cloud: float
    rain: float


@dataclass(frozen=True)
class WeatherData:
    state: str
    sunrise: object = None
    sunset: object = None
    hours: tuple = ()


def normalize_weather(raw, day):
    if not isinstance(raw, dict) or raw.get("state") not in ("available", "unavailable"):
        raise DataError("Weather requires an explicit availability state.")
    if raw["state"] == "unavailable":
        if set(raw) != {"state"}:
            raise DataError("Unavailable weather cannot contain measurements.")
        return WeatherData("unavailable")
    if set(raw) != {"state", "sunrise", "sunset", "hours"}:
        raise DataError("Weather accepts only sun times and numeric hourly observations.")
    sunrise, sunset = instant(raw["sunrise"]), instant(raw["sunset"])
    if not day.start <= sunrise < sunset < day.end:
        raise DataError("Sunrise and sunset must be ordered within the requested local date.")
    if not isinstance(raw["hours"], list) or len(raw["hours"]) > 26:
        raise DataError("Weather hours must be a bounded array.")
    hours = []
    for hour in raw["hours"]:
        if not isinstance(hour, dict) or set(hour) != {"start", "cloud", "precipitation"}:
            raise DataError("Weather hour accepts only time, cloud and precipitation.")
        start = instant(hour["start"])
        if not day.start - timedelta(hours=1) < start < day.end:
            raise DataError("Weather hour is outside the requested day.")
        hours.append(Hour(start, number(hour["cloud"], 0, 100), number(hour["precipitation"], 0, 500)))
    hours.sort(key=lambda hour: hour.start)
    if any(b.start - a.start < timedelta(hours=1) for a, b in zip(hours, hours[1:])):
        raise DataError("Weather hours overlap or repeat.")
    return WeatherData("available", sunrise, sunset, tuple(hours))


@dataclass(frozen=True)
class Walk:
    state: str
    slot: object = None
    start: object = None
    end: object = None
    cloud: object = None
    rain: object = None


def choose_walk(config, day, calendar, weather):
    if weather.state != "available":
        return Walk("weather_unavailable")
    if day.now >= min(weather.sunset, day.end):
        return Walk("daylight_finished")
    morning_end = local(day.date, config.work_start, day.zone)
    evening_start = local(day.date, config.work_end, day.zone)
    midday_start = local(day.date, config.lunch_start - 30, day.zone)
    midday_end = local(day.date, config.lunch_end + 30, day.zone)
    if calendar.meetings:
        morning_end = min(calendar.meetings[0].start, midday_start)
        evening_start = max(max(meeting.end for meeting in calendar.meetings), midday_end)
    windows = [
        ("Before work", local(day.date, 360, day.zone), morning_end),
        ("Lunch", midday_start, midday_end),
        ("After work", evening_start, local(day.date, 1200, day.zone)),
    ]
    candidates, uncovered = [], False
    for slot, start, end in windows:
        start, end = max(start, weather.sunrise, day.now), min(end, weather.sunset)
        # Absolute-time arithmetic keeps 30-minute walks honest across offset changes.
        timestamp = math.ceil(start.timestamp() / 900) * 900
        while timestamp + 1800 <= end.timestamp():
            a, b = datetime.fromtimestamp(timestamp, UTC), datetime.fromtimestamp(timestamp + 1800, UTC)
            timestamp += 900
            if any(a < busy.end and b > busy.start for busy in calendar.busy):
                continue
            coverage, cloud, rain = 0.0, 0.0, 0.0
            for hour in weather.hours:
                overlap = max(0, (min(b, hour.start + timedelta(hours=1)) - max(a, hour.start)).total_seconds())
                coverage += overlap
                cloud += hour.cloud * overlap / 1800
                rain += hour.rain * overlap / 3600
            if coverage != 1800:
                uncovered = True
                continue
            candidates.append(Walk("chosen", slot, a, b, cloud, rain))
    if not candidates:
        return Walk("incomplete_weather" if uncovered else "no_free_slot")
    # Any predicted rain loses to a dry slot. Among wet fallbacks minimize rain
    # first, then cloud. Earliest time breaks exact ties, independent of input order.
    winner = min(candidates, key=lambda walk: (walk.rain > 0, walk.rain, walk.cloud, walk.start))
    if uncovered:
        return Walk("chosen_partial", winner.slot, winner.start, winner.end, winner.cloud, winner.rain)
    return winner
