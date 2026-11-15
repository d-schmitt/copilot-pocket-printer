"""Fixed generic prose; provider strings cannot flow into render blocks."""

from datetime import timedelta
import random

from .model import DataError, choose_walk


# Original short jokes, authored for this example, not copied from a joke API.
JOKES = (
    "My calendar took a walk. It needed a little space between dates.",
    "The pencil joined the garden club. It wanted to draw more flowers.",
    "I asked the cloud for a bright idea. It said it was still thinking.",
)


def clock(value, day):
    result = value.astimezone(day.zone)
    label = result.strftime("%H:%M")
    if result.date() != day.date:
        label = result.strftime("%d %b ") + label
    # Include offsets on transition days so repeated wall-clock times differ.
    if day.start.astimezone(day.zone).utcoffset() != (day.end - timedelta(seconds=1)).astimezone(day.zone).utcoffset():
        offset = result.strftime("%z")
        label += " " + offset[:3] + ":" + offset[3:]
    return label


def template(config, day, calendar, weather, bottom="random", seed=0, synthetic=False):
    if bottom not in ("random", "joke", "sudoku-easy", "sudoku-medium", "art"):
        raise DataError("Unknown bottom choice.")
    if type(seed) is not int or not 0 <= seed <= 2**32 - 1:
        raise DataError("Seed must be an unsigned 32-bit integer.")
    rng = random.Random(seed)
    if bottom == "random":
        bottom = rng.choice(("joke", "sudoku-easy", "sudoku-medium", "art"))
    blocks = []

    def text(value, style="body"):
        blocks.append({"kind": "text", "style": style, "text": value})

    def rule():
        blocks.append({"kind": "rule"})

    def compact(first, second, first_style="body", second_style="body", separator=" / "):
        blocks.append({"kind": "compact", "separator": separator, "items": [
            {"text": first, "style": first_style}, {"text": second, "style": second_style},
        ]})

    blocks.append({"kind": "header", "left": "DAILY CARD",
                   "right": day.now.astimezone(day.zone).strftime("%H:%M")})
    weekdays = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
    compact(weekdays[day.date.weekday()] + " " + day.date.isoformat(), config.location, "heading", "body", "  ")
    if synthetic:
        text("SYNTHETIC DATA / offline example", "small")
    rule()
    text("DAYLIGHT", "heading")
    if weather.state == "available":
        text(clock(weather.sunrise, day) + " - " + clock(weather.sunset, day))
    else:
        text("Sun times unavailable")
    rule()
    text("WALK / remaining daylight", "heading")
    walk = choose_walk(config, day, calendar, weather)
    if walk.state in ("chosen", "chosen_partial"):
        text(walk.slot + " / 30 min")
        text(clock(walk.start, day) + " - " + clock(walk.end, day))
        if walk.rain == 0:
            text("Dry forecast; %.0f%% cloud." % walk.cloud)
        else:
            # Do not round a trace of rain down to a misleading zero.
            amount = "<0.01" if walk.rain < 0.01 else "%.2f" % walk.rain
            text("Rain likely: " + amount + " mm.")
            text("Least rain; %.0f%% cloud." % walk.cloud)
        if walk.state == "chosen_partial":
            text("Some slots lack weather data.", "small")
    else:
        text({
            "weather_unavailable": "Weather unavailable",
            "daylight_finished": "No daylight slots left today",
            "incomplete_weather": "Hourly weather incomplete",
            "no_free_slot": "No free 30-min daylight slot",
        }[walk.state])
    if calendar.state != "available":
        text("Calendar unknown; default windows.", "small")
    rule()
    text("MEETINGS / whole day", "heading")
    if calendar.state != "available":
        text("Calendar unavailable")
    elif not calendar.meetings:
        text("No timed meetings today")
    elif calendar.meetings[0] == calendar.meetings[-1]:
        meeting = calendar.meetings[0]
        text("Meeting " + clock(meeting.start, day) + "-" + clock(meeting.end, day))
    else:
        entries = [label + " " + clock(meeting.start, day) + "-" + clock(meeting.end, day)
                   for label, meeting in (("First", calendar.meetings[0]), ("Last", calendar.meetings[-1]))]
        compact(*entries)
    if calendar.state == "available" and not calendar.meetings and calendar.busy:
        text("All-day busy time")
    rule()
    if bottom == "joke":
        text("A SMALL SMILE", "heading")
        text(rng.choice(JOKES))
    elif bottom.startswith("sudoku-"):
        difficulty = bottom.split("-")[1]
        text("SUDOKU / " + difficulty, "heading")
        blocks.append({"kind": "sudoku", "difficulty": difficulty, "seed": seed})
    else:
        text("MAKE IT YOUR GARDEN", "heading")
        text("Colour, add leaves, or draw a bee.", "small")
        blocks.append({"kind": "art", "name": "garden"})
    return {"version": 1, "blocks": blocks}
