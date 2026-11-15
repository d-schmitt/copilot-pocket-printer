from dataclasses import asdict
from datetime import timedelta
from contextlib import redirect_stderr, redirect_stdout
import copy
from http.client import HTTPResponse
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from daily_card.model import (
    CalendarData, DataError, WeatherData, choose_walk, instant, normalize_calendar, normalize_weather,
)
from daily_card.providers import graph_calendar, open_meteo
from daily_card.template import clock, template
from fixtures import ROOT, calendar, config, day, event, weather


class CalendarTests(unittest.TestCase):
    def test_metadata_is_absent_from_normalized_data_and_render_input(self):
        secret = "SENTINEL_PRIVATE_TITLE_ATTENDEE_COMPANY"
        raw = calendar()
        for item in raw["events"]:
            item.update({"subject": secret, "attendees": [{"name": secret}], "company": secret,
                         "body": secret, "location": secret, "unexpected": {"nested": secret}})
        normalized = normalize_calendar(raw, day())
        self.assertNotIn(secret, repr(asdict(normalized)))
        self.assertEqual(set(asdict(normalized)), {"state", "meetings", "busy"})
        self.assertEqual(set(asdict(normalized)["meetings"][0]), {"start", "end"})
        result = template(config(), day(), normalized, normalize_weather(weather(), day()), "joke")
        self.assertNotIn(secret, json.dumps(result))
        self.assertIn("First 09:00-10:00", json.dumps(result))
        self.assertNotIn("subject", json.dumps(result))

    def test_graph_projection_and_incomplete_pagination(self):
        raw = {"value": [{"start": {"dateTime": "2026-11-15T08:00:00.0000000", "timeZone": "UTC"},
                          "end": {"dateTime": "2026-11-15T09:00:00.0000000", "timeZone": "UTC"},
                          "subject": "SENTINEL", "attendees": ["SENTINEL"], "showAs": "busy"}]}
        normalized = graph_calendar(raw, day())
        self.assertEqual(clock(normalized.meetings[0].start, day()), "09:00")
        self.assertNotIn("SENTINEL", repr(asdict(normalized)))
        self.assertNotIn("SENTINEL", json.dumps(template(config(), day(), normalized, WeatherData("unavailable"))))
        with self.assertRaises(DataError):
            graph_calendar({**raw, "@odata.nextLink": "unfollowed"}, day())
        raw["value"][0]["start"]["timeZone"] = "W. Europe Standard Time"
        with self.assertRaises(DataError):
            graph_calendar(raw, day())

    def test_empty_unavailable_cancelled_free_and_all_day(self):
        empty = normalize_calendar({"state": "available", "events": []}, day())
        unknown = normalize_calendar({"state": "unavailable"}, day())
        self.assertNotEqual(empty.state, unknown.state)
        raw = {"state": "available", "events": [
            event("09:00", "10:00", is_cancelled=True),
            event("11:00", "12:00", show_as="free"),
            {"start": "2026-11-15T00:00:00+01:00", "end": "2026-11-16T00:00:00+01:00", "is_all_day": True}
        ]}
        actual = normalize_calendar(raw, day())
        self.assertFalse(actual.meetings)
        self.assertEqual(len(actual.busy), 1)
        self.assertEqual(choose_walk(config(), day(), actual, normalize_weather(weather(), day())).state, "no_free_slot")
        self.assertIn("No timed meetings today", json.dumps(template(config(), day(), empty, WeatherData("unavailable"))))
        self.assertNotIn("No timed meetings", json.dumps(template(config(), day(), unknown, WeatherData("unavailable"))))

    def test_date_overlap_dedup_and_temporal_sorting(self):
        raw = {"state": "available", "events": [
            event("10:00", "12:00"), event("09:00", "11:00"), event("10:00", "12:00"),
            {"start": "2026-11-14T23:00:00+01:00", "end": "2026-11-15T01:00:00+01:00"},
            {"start": "2026-11-14T22:00:00+01:00", "end": "2026-11-15T00:00:00+01:00"},
            {"start": "2026-11-16T00:00:00+01:00", "end": "2026-11-16T01:00:00+01:00"},
        ]}
        data = normalize_calendar(raw, day())
        self.assertEqual(len(data.meetings), 3)
        self.assertEqual(len(data.busy), 2)
        self.assertEqual(data.busy[0].start, day().start)
        self.assertEqual(clock(data.meetings[0].start, day()), "14 Nov 23:00")
        self.assertEqual(clock(data.busy[1].end, day()), "12:00")

    def test_strict_timestamps_and_flags(self):
        for stamp in ("2026-11-15T09:00:00", "2026-02-30T09:00:00Z", "2026-11-15T25:00:00Z",
                      "2026-11-15T09:00:00+01:60", "SENTINEL"):
            with self.assertRaises(DataError) as failure:
                instant(stamp)
            self.assertNotIn(stamp, str(failure.exception))
        for item in (event("10:00", "09:00"), event("10:00", "10:00"),
                     event("09:00", "10:00", is_cancelled="false"),
                     event("09:00", "10:00", show_as="SENTINEL"),
                     event("09:00", "10:00", is_all_day=True)):
            with self.assertRaises(DataError):
                normalize_calendar({"state": "available", "events": [item]}, day())

    def test_dst_days_repeated_hours_and_offset_labels(self):
        spring = day("2026-03-29", "2026-03-29T06:00:00+02:00")
        fall = day("2026-10-25", "2026-10-25T06:00:00+01:00")
        self.assertEqual((spring.end - spring.start).total_seconds(), 23 * 3600)
        self.assertEqual((fall.end - fall.start).total_seconds(), 25 * 3600)
        repeated = {"state": "available", "events": [
            {"start": "2026-10-25T02:15:00+02:00", "end": "2026-10-25T02:45:00+02:00"},
            {"start": "2026-10-25T02:15:00+01:00", "end": "2026-10-25T02:45:00+01:00"}
        ]}
        normalized = normalize_calendar(repeated, fall)
        self.assertEqual(len(normalized.meetings), 2)
        self.assertEqual(clock(normalized.meetings[0].start, fall), "02:15 +02:00")
        self.assertEqual(clock(normalized.meetings[1].start, fall), "02:15 +01:00")
        for context in (spring, fall):
            actual = normalize_weather(weather(context), context)
            self.assertEqual(len(actual.hours), int((context.end - context.start).total_seconds() / 3600))
            choice = choose_walk(config(), context, CalendarData("available"), actual)
            self.assertEqual(choice.end - choice.start, timedelta(minutes=30))


class WalkTests(unittest.TestCase):
    def choose(self, raw_weather=None, raw_calendar=None, context=None):
        context = context or day()
        return choose_walk(config(), context, normalize_calendar(raw_calendar or calendar(), context),
                           normalize_weather(raw_weather or weather(context), context))

    def test_sunniest_lunch_gap_and_calendar_refinements(self):
        choice = self.choose()
        self.assertEqual(choice.slot, "Lunch")
        self.assertEqual(clock(choice.start, day()), "12:30")
        self.assertEqual(choice.cloud, 10)
        raw = weather()
        for hour in raw["hours"]:
            hour["cloud"] = 0 if clock(instant(hour["start"]), day()) == "08:00" else 80
        self.assertEqual(clock(self.choose(raw).start, day()), "08:00")
        for hour in raw["hours"]:
            hour["cloud"] = 0 if clock(instant(hour["start"]), day()) == "16:00" else 80
        self.assertEqual(clock(self.choose(raw).start, day()), "16:00")

    def test_dry_beats_sunny_rain_and_wet_fallback_minimizes_rain(self):
        raw = weather()
        for hour in raw["hours"]:
            hour["precipitation"] = 1 if hour["cloud"] == 10 else 0
        self.assertNotEqual(self.choose(raw).slot, "Lunch")
        for hour in raw["hours"]:
            hour["precipitation"] = 0.02 if hour["cloud"] == 10 else 3
        chosen = self.choose(raw)
        self.assertEqual(chosen.slot, "Lunch")
        self.assertAlmostEqual(chosen.rain, 0.01)
        self.assertIn("Rain likely", json.dumps(template(config(), day(), normalize_calendar(calendar(), day()),
                                                      normalize_weather(raw, day()), "joke")))

    def test_ties_earliest_future_not_elapsed_and_whole_day_meetings(self):
        raw = weather()
        for hour in raw["hours"]:
            hour["cloud"] = 30
        self.assertEqual(clock(self.choose(raw).start, day()), "07:00")
        late = day(now="2026-11-15T12:35:00+01:00")
        self.assertEqual(clock(self.choose(raw, context=late).start, late), "12:45")
        after_dark = day(now="2026-11-15T18:50:00+01:00")
        self.assertEqual(self.choose(context=after_dark).state, "daylight_finished")
        card = template(config(), after_dark, normalize_calendar(calendar(), after_dark),
                        normalize_weather(weather(), after_dark))
        self.assertIn("First 09:00-10:00", json.dumps(card))
        self.assertIn("No daylight slots left today", json.dumps(card))

    def test_missing_hour_does_not_become_clear_or_dry(self):
        raw = weather()
        raw["hours"] = [h for h in raw["hours"] if clock(instant(h["start"]), day()) != "12:00"]
        choice = self.choose(raw)
        self.assertEqual(choice.state, "chosen_partial")
        self.assertNotEqual(clock(choice.start, day()), "12:30")
        self.assertEqual(self.choose({**raw, "hours": []}).state, "incomplete_weather")
        # A 12:45 walk needs both the 12:00 and 13:00 intervals.
        raw = weather()
        raw["hours"] = [h for h in raw["hours"] if clock(instant(h["start"]), day()) == "12:00"]
        late = day(now="2026-11-15T12:45:00+01:00")
        self.assertEqual(self.choose(raw, context=late).state, "incomplete_weather")

    def test_overlap_blocks_lunch_and_long_meeting_end_bounds_evening(self):
        raw = {"state": "available", "events": [
            event("09:00", "17:30"), event("15:00", "16:00")
        ]}
        raw_weather = weather()
        for hour in raw_weather["hours"]:
            hour["cloud"] = 0 if clock(instant(hour["start"]), day()) >= "16:00" else 80
        choice = self.choose(raw_weather, raw)
        self.assertEqual(clock(choice.start, day()), "17:30")
        self.assertEqual(choice.end - choice.start, timedelta(minutes=30))

    def test_normalized_weather_rejects_free_prose_units_duplicates_and_nans(self):
        for change in (
            lambda raw: raw.update({"reason": "SENTINEL"}),
            lambda raw: raw["hours"].append(copy.deepcopy(raw["hours"][0])),
            lambda raw: raw["hours"][0].update(cloud=float("nan")),
            lambda raw: raw["hours"][0].update(precipitation=-1),
            lambda raw: raw["hours"][0].update(cloud=True),
            lambda raw: raw.update(sunset="2026-11-16T18:00:00+01:00"),
        ):
            raw = weather()
            change(raw)
            with self.assertRaises(DataError):
                normalize_weather(raw, day())

    def test_open_meteo_null_hours_and_units(self):
        normalized = weather()
        raw = {
            "hourly_units": {"time": "unixtime", "cloud_cover": "%", "precipitation": "mm"},
            "daily_units": {"time": "unixtime", "sunrise": "unixtime", "sunset": "unixtime"},
            "daily": {"time": [day().start.timestamp()], "sunrise": [instant(normalized["sunrise"]).timestamp()],
                      "sunset": [instant(normalized["sunset"]).timestamp()]},
            "hourly": {"time": [instant(h["start"]).timestamp() for h in normalized["hours"]],
                       "cloud_cover": [h["cloud"] for h in normalized["hours"]],
                       "precipitation": [h["precipitation"] for h in normalized["hours"]]}
        }
        raw["hourly"]["cloud_cover"][12] = None
        raw["hourly"]["precipitation"][12] = 4
        actual = open_meteo(raw, day())
        self.assertEqual(len(actual.hours), 22)
        at_eleven = next(h for h in actual.hours if clock(h.start, day()) == "11:00")
        self.assertEqual(at_eleven.rain, 4)
        self.assertEqual(at_eleven.cloud, 70)
        raw["hourly_units"]["precipitation"] = "inch"
        with self.assertRaises(DataError):
            open_meteo(raw, day())


class RenderIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.renderer = os.environ.get("CARD_RENDERER_BIN")
        if not cls.renderer or not Path(cls.renderer).is_file():
            raise AssertionError("Set CARD_RENDERER_BIN to the built offline card-renderer.")

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="daily-card-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def test_all_variants_actual_png_and_no_overwrite(self):
        for bottom in ("joke", "sudoku-easy", "sudoku-medium", "art"):
            value = template(config(), day(), normalize_calendar(calendar(), day()),
                             normalize_weather(weather(), day()), bottom, seed=17, synthetic=True)
            path = self.root / (bottom + ".png")
            result = subprocess.run([self.renderer, "-", str(path)], input=json.dumps(value),
                                    text=True, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            png = path.read_bytes()
            self.assertEqual(struct.unpack(">II", png[16:24]), (384, report["height"]))
            self.assertLessEqual(report["height"], 4096)
            self.assertLessEqual(len(png), 1024 * 1024)
            self.assertEqual(report["pngBytes"], len(png))
            self.assertTrue(all(e["y"] + e["height"] <= report["height"] - 16 for e in report["elements"]))
            headings = ["DAILY CARD", "DAYLIGHT", "WALK / remaining daylight", "MEETINGS / whole day",
                        {"joke": "A SMALL SMILE", "sudoku-easy": "SUDOKU / easy",
                         "sudoku-medium": "SUDOKU / medium", "art": "MAKE IT YOUR GARDEN"}[bottom]]
            positions = [next(e["y"] for e in report["elements"] if e.get("text") == label) for label in headings]
            self.assertEqual(positions, sorted(positions), "Accepted date/daylight, walk, meetings, bottom order")
            self.assertIn("SYNTHETIC DATA", result.stdout)
            labels = [e.get("text") for e in report["elements"]]
            self.assertIn("07:00 - 18:00", labels)
            self.assertIn("First 09:00-10:00 / Last 15:00-16:00", labels)
            self.assertEqual(labels.count("06:00"), 1)
            self.assertEqual(report["elements"][0]["y"], report["elements"][1]["y"])
            self.assertLessEqual(report["elements"][0]["x"] + report["elements"][0]["width"], report["elements"][1]["x"])
            self.assertEqual(report["elements"][1]["x"] + report["elements"][1]["width"], 368)
            for removed in ("Weather:", "Calendar:", "One solution", "Fill 1-9", "As of", "Sunrise", "Sunset", "Europe/Berlin"):
                self.assertNotIn(removed, json.dumps(value))
            if bottom.startswith("sudoku-"):
                puzzle = next(b for b in value["blocks"] if b["kind"] == "sudoku")
                self.assertEqual(puzzle, {"kind": "sudoku", "difficulty": bottom.split("-")[1], "seed": 17})
            repeated = subprocess.run([self.renderer, "-", str(path)], input=json.dumps(value),
                                      text=True, capture_output=True, timeout=30)
            self.assertEqual(repeated.returncode, 2)
            self.assertEqual(path.read_bytes(), png)

    def run_assembler(self, *args):
        return subprocess.run([sys.executable, "-m", "daily_card", "--config", str(ROOT / "examples/daily-card-config.json"),
                               "--date", "2026-11-15", "--now", "2026-11-15T06:00:00+01:00",
                               *map(str, args)], cwd=ROOT, text=True, capture_output=True, timeout=30)

    def test_cli_projection_end_to_end_and_partial_failure(self):
        raw = calendar()
        raw["events"][0]["subject"] = "SENTINEL_PRIVATE"
        calendar_path, weather_path = self.root / "calendar.json", self.root / "weather.json"
        calendar_path.write_text(json.dumps(raw))
        weather_path.write_text(json.dumps(weather()))
        output, png = self.root / "template.json", self.root / "card.png"
        result = self.run_assembler("--calendar", calendar_path, "--weather", weather_path, "--output", output,
                                    "--renderer", self.renderer, "--png", png)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("SENTINEL", output.read_text() + result.stdout + result.stderr)
        self.assertIn("First 09:00-10:00", result.stdout)
        report = json.loads(result.stdout)
        self.assertEqual(report["status"], "complete")
        self.assertEqual(report["warnings"], [])
        self.assertEqual(report["timezone"], "Europe/Berlin")
        self.assertEqual(report["as_of"], "2026-11-15T05:00:00Z")
        original = output.read_bytes()
        self.assertEqual(self.run_assembler("--output", output).returncode, 2)
        self.assertEqual(output.read_bytes(), original)
        partial = self.root / "partial.json"
        result = self.run_assembler("--output", partial)
        self.assertEqual(result.returncode, 3)
        self.assertIn("Calendar unavailable", partial.read_text())
        self.assertIn("weather_unavailable", result.stderr)
        self.assertNotIn("No timed meetings", partial.read_text())
        report = json.loads(result.stdout)
        self.assertEqual(report["status"], "partial")
        self.assertEqual({w["source"] for w in report["warnings"]}, {"calendar", "weather"})
        self.assertEqual({w["code"] for w in report["warnings"]}, {"calendar_unavailable", "weather_unavailable"})
        rendered = self.run_assembler("--output", self.root / "partial-rendered.json",
                                      "--renderer", self.renderer, "--png", self.root / "partial.png")
        self.assertEqual(rendered.returncode, 3)
        self.assertEqual(json.loads(rendered.stdout)["warnings"], report["warnings"])
        self.assertEqual(json.loads(rendered.stdout)["width"], 384)

    def test_malformed_provider_diagnostics_do_not_echo_secrets(self):
        raw = self.root / "invalid.json"
        raw.write_text('{"state":"available","events":[{"start":"SENTINEL_PRIVATE","end":"SENTINEL"}]}')
        output = self.root / "template.json"
        result = self.run_assembler("--calendar", raw, "--output", output)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("SENTINEL", result.stdout + result.stderr)
        self.assertFalse(output.exists())
        self.assertEqual(json.loads(result.stdout)["status"], "error")
        self.assertEqual(json.loads(result.stdout)["error"]["source"], "calendar")

    def test_network_failure_is_explicit_partial_output(self):
        # Exercise the actual CLI entry point without making any network call.
        from daily_card.__main__ import main
        output = self.root / "partial.json"
        args = ["daily_card", "--config", str(ROOT / "examples/daily-card-config.json"),
                "--date", "2026-11-15", "--now", "2026-11-15T18:50:00+01:00",
                "--fetch-weather", "--output", str(output)]
        errors = io.StringIO()
        with patch.object(sys, "argv", args), patch("daily_card.__main__.fetch_weather", side_effect=OSError("SENTINEL")), \
                redirect_stderr(errors), redirect_stdout(io.StringIO()):
            self.assertEqual(main(), 3)
        self.assertIn("Sun times unavailable", output.read_text())
        self.assertNotIn("SENTINEL", output.read_text() + errors.getvalue())

    def test_single_meeting_and_dst_compact_fallback(self):
        for name, context, events, expected in [
            ("single", day(), [event("09:00", "10:00")], ["Meeting 09:00-10:00"]),
            ("dst", day("2026-10-25", "2026-10-25T06:00:00+01:00"), [
                {"start": "2026-10-25T02:15:00+02:00", "end": "2026-10-25T02:45:00+02:00"},
                {"start": "2026-10-25T02:15:00+01:00", "end": "2026-10-25T02:45:00+01:00"},
            ], ["First 02:15 +02:00-02:45 +02:00", "Last 02:15 +01:00-02:45 +01:00"]),
        ]:
            normalized = normalize_calendar({"state": "available", "events": events}, context)
            value = template(config(), context, normalized, normalize_weather(weather(context), context), "joke")
            result = subprocess.run([self.renderer, "-", str(self.root / (name + ".png"))],
                                    input=json.dumps(value), text=True, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            labels = [e.get("text", "") for e in json.loads(result.stdout)["elements"]]
            meeting_lines = [label for label in labels if label.startswith(("Meeting ", "First ", "Last "))]
            self.assertEqual(meeting_lines, expected)
            self.assertEqual(len(normalized.meetings), len(events))
            self.assertNotIn("Europe/Berlin", json.dumps(value))

    def test_truncated_http_response_is_explicit_partial_output(self):
        from daily_card.__main__ import main

        class InertSocket:
            def makefile(self, *args):
                return io.BytesIO(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10\r\n{}")

        response = HTTPResponse(InertSocket())
        response.begin()
        output = self.root / "truncated.json"
        args = ["daily_card", "--config", str(ROOT / "examples/daily-card-config.json"),
                "--date", "2026-11-15", "--fetch-weather", "--output", str(output)]
        errors = io.StringIO()
        with patch.object(sys, "argv", args), patch("daily_card.providers.urlopen", return_value=response), \
                redirect_stderr(errors), redirect_stdout(io.StringIO()):
            self.assertEqual(main(), 3)
        self.assertIn("weather_unavailable", errors.getvalue())
        self.assertNotIn("Traceback", errors.getvalue())
        self.assertIn("Sun times unavailable", output.read_text())

    def test_renderer_waits_for_complete_stream(self):
        data = json.dumps({"version": 1, "blocks": [{"kind": "text", "text": "Complete streamed input", "style": "body"}]})
        process = subprocess.Popen([self.renderer, "-", str(self.root / "streamed.png")],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            process.stdin.write(data[:20])
            process.stdin.flush()
            time.sleep(0.03)
            self.assertIsNone(process.poll())
            process.stdin.write(data[20:])
            process.stdin.close()
            process.stdin = None
            stdout, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertIn("Complete streamed input", stdout)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
