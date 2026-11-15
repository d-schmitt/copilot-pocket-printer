# Daily-card example

The pipeline is intentionally small: optional data adapters -> validated
times/numbers -> daily template assembler -> JSON-to-PNG renderer. The Swift
renderer reuses the existing CoreText/CoreGraphics, ASCII and PNG utilities.
No helper process, MCP registration, Bluetooth initialization or paper is
needed. No Swift dependency pin or print-tool contract changes.
The daily layout orders date/daylight, walk recommendation, first/last meeting
times, then bottom content.

Python 3.9+ with `zoneinfo` and the system timezone database is required for
assembly. macOS 13+ and Swift 5.9+ are required for rendering. Only standard
libraries and existing dependencies are used.

## Call from any assistant or CLI

```sh
swift build
BIN_DIR="$(swift build --show-bin-path)"
"$BIN_DIR/card-renderer" examples/card-template.json /tmp/example-card.png

python3 -m daily_card --config examples/daily-card-config.json \
  --date 2026-11-15 --now 2026-11-15T06:00:00+01:00 \
  --calendar /path/to/times-only.json --fetch-weather \
  --bottom sudoku-easy --seed 17 \
  --output /tmp/daily-template.json \
  --renderer "$BIN_DIR/card-renderer" --png /tmp/daily-card.png
```

Use new output names: neither command overwrites an existing file. The
assembler can run alone by omitting both `--renderer` and `--png`. The renderer
accepts `-` for JSON on stdin and returns a layout report on stdout (PNG
dimensions/bytes and each element's bounds/ASCII text). These interfaces can be
called directly by Copilot, Claude Code or another client with command tools.
No extra MCP tool, native-process launcher in the bridge, or global
configuration is necessary. This deliberately preserves the verified bridge.

After argument parsing, the daily-card command returns a machine-readable generation result on
stdout, including `status` (`complete`, `partial`, `error`), `template_written`,
`calendar`/`weather` availability, and source-specific `warnings` with `source`,
`code` and a fixed safe `message`. When rendering, the same result also includes
the existing layout fields (`width`, `height`, `pngBytes`, `elements`).
It returns `date`, `timezone`, `as_of`, `synthetic` and `weather_source` as
off-paper metadata. A failure includes a source-specific `error` object.
These are returned to the calling assistant, not hidden in a separate file.
Clients must show/relay nonempty warnings or errors in their app; the CLI also
prints them to stderr. The generic renderer alone cannot know provider state.
This adds no native popup, canvas or global tool registration.

`--now` defaults to the actual current instant; the example injects an early
time solely for reproducibility. Do not backdate a live card to suggest elapsed
walks. `--date` is always explicit. `--bottom` accepts `random`, `joke`,
`sudoku-easy`, `sudoku-medium`, or `art`. The unsigned 32-bit `--seed` controls
bottom/joke choice and Sudoku digit relabeling/transposition. Add `--synthetic`
for demonstrations; do not label invented calendar/weather as live.

Assembler exit codes: **0** complete available inputs, **3** a usable card with
unavailable providers or incomplete candidate weather, **2** invalid input or local failure.
Malformed injected input is rejected, not silently replaced. Live weather
retrieval failure produces a clearly unavailable section and exit 3.
If optional rendering fails, exit 2 and retain the assembled JSON for inspection.
Renderer errors use `[invalid_card]`, exit 2, with no input content echoed.
No error is permission to retry a print.

## Paper-conscious layout

Generation/as-of time is right-aligned beside DAILY CARD; it is **not evidence
of physical print time**. Rendering or submission never modifies an already
reviewed PNG or its approval digest. The timezone remains in calculations and
generation metadata, not on paper.

Date and location share a row when measured widths fit, retaining the existing
18-dot date and 16-dot location styles, separated by two spaces. Otherwise each
keeps its original line. Daylight retains its heading and uses one
`HH:mm - HH:mm` range. First/last meetings use
`First HH:mm-HH:mm / Last HH:mm-HH:mm` when the 16-dot text fits, otherwise one
entry per line. Equal validated first/last intervals become one
`Meeting HH:mm-HH:mm` entry. Long dated/DST ranges can wrap further rather than
losing their dates/offsets or shrinking type.

The source footer and its separator are omitted. Provider failures remain
explicit in the generation result/stderr and concise unavailable sections,
never false zero-meeting or zero-rain claims. Sudoku retains its difficulty
heading and unchanged unsolved grid, without the explanatory instruction row.
All original text sizes, exterior margins and art/grid dimensions are retained.

## Privacy boundary

The renderer is a **generic** template renderer, not an OCR/redaction service.
Arbitrary text deliberately supplied in a generic template will be rendered.
Do not pass raw provider objects or meeting prose as templates.

The daily-card assembler projects each calendar record into immutable
`Interval(start, end)` values and an explicit availability state. It does not
copy, serialize or log raw calendar dictionaries. Titles, company/customer
names, attendees, bodies, locations, links and arbitrary nested metadata have
no route into generated render JSON. Only fixed generic meeting labels are
used. Weather prose is never accepted. The configured location is
template-owned, not populated from any calendar/provider label.

Portable times-only input:

```json
{
  "state": "available",
  "events": [
    {"start": "2026-11-15T09:00:00+01:00", "end": "2026-11-15T10:00:00+01:00"}
  ]
}
```

This is a **synthetic** shape example, not the user's calendar. Optional event
flags are `is_cancelled` (boolean), `is_all_day` (boolean), and `show_as` (one
of `free`, `busy`, `tentative`, `oof`, `workingElsewhere`, `unknown`).
An available `events: []` means a verified zero-event day.
`{"state":"unavailable"}` is different and never prints "no meetings".
Use only times-only inputs even though the normalizer defensively discards
extra fields. Keep actual calendar inputs, render JSON, previews and reports
outside the repository and public CI artifacts.

For WorkIQ, fetch only the requested local day's `calendarView`, using UTC
start/end query boundaries and
`$select=start,end,isAllDay,isCancelled,showAs&$top=100`. Graph defaults to UTC;
the adapter requires an explicit UTC `timeZone` in each timing value.
Pass only the timing response's `data` object to `--graph-calendar`, never the
whole tool transcript. An `@odata.nextLink` is incomplete coverage and is
rejected: the calling client must exhaust the same scoped range before passing
the combined timing-only records. No broader search is needed. If sign-in or
authorization fails, use unavailable state rather than an empty result.
The repository contains no WorkIQ credentials, client-specific query runtime
or automatic calendar acquisition.

## Time and walk policy

These are explicit example policies, not claims to infer personal preferences:

* Timestamps require seconds and an explicit `Z`/offset. Convert to UTC before
  sorting, overlap checks and duration arithmetic; display in the configured
  IANA zone. Nonexistent/ambiguous local configuration boundaries are rejected.
  Transition-day labels include offsets, distinguishing repeated wall times.
* Include events intersecting the half-open local day `[midnight, midnight)`,
  deduplicate, and merge overlapping/touching busy intervals. Preserve actual
  meeting start/end times, annotating cross-day dates. First/last use start-time
  ordering across the **whole day**, even when the card is rendered late.
* Cancelled/free events are omitted; tentative/unknown/out-of-office/
  working-elsewhere events conservatively block time. All-day busy records
  require local-midnight boundaries and block availability, but are not
  presented as timed meetings. Input is bounded to 500 events and 31-day spans.
* Default work hours are 08:00-17:00; lunch is 12:00-13:00.
  Morning runs from 06:00 to work start, extended/shortened to the first
  meeting when known but never beyond lunch-window start. Lunch allows
  30 minutes on either side. Afternoon starts at work end, or the latest
  meeting end when known, never before lunch-window end, and ends at 20:00.
  Days without timed meetings retain work defaults, including weekends.
* Consider 30-minute walks on absolute quarter-hour boundaries, subtract
  every busy overlap, constrain to sunrise/sunset and `start >= now`.
  No remaining daylight means no recommendation, not tomorrow's weather.
  An unavailable calendar uses visibly labeled default windows, never claims
  calendar-confirmed availability.
* Require full hourly coverage for every selected slot. Missing competing
  slots are excluded and visibly disclosed. Any predicted precipitation loses
  to a dry slot; among wet fallbacks, minimize precipitation before cloud.
  Otherwise lower duration-weighted cloud wins; exact ties use earliest time.
  Display a generic weather reason and never call a rainy fallback dry.

Open-Meteo's [hourly definitions](https://open-meteo.com/en/docs#hourly_parameter_definition)
specify precipitation as a **preceding-hour sum**, but cloud as instantaneous.
The adapter pairs cloud at `t` with precipitation at `t+1h`. Missing endpoints,
null values, mismatched units, overlapping records and provider errors do not
become zero rain or zero cloud. It requests epoch times, avoiding ambiguous DST
wall strings. One local day's samples cover the candidate windows, which end
by 20:00; the final unpaired 23:00 interval is not used.
The half-hour rain amount assumes a uniform hourly rate, and cloud is an hourly
estimate, not a guaranteed sunny interval. This is not a severe-weather safety
advisory. Polar days without ordinary ordered sun times are explicitly
unavailable, not invented sunrise/sunset values.

For offline/custom providers, `--weather` accepts only:

```json
{
  "state": "available",
  "sunrise": "2026-11-15T07:00:00+01:00",
  "sunset": "2026-11-15T18:00:00+01:00",
  "hours": [{"start":"2026-11-15T12:00:00+01:00","cloud":10,"precipitation":0}]
}
```

This **synthetic**, intentionally incomplete example has only one covered hour.
Normalized precipitation describes `[start, start + 1 hour)`, in millimeters;
cloud is percent. Generation metadata identifies injected data, rather than
falsely attributing it to Open-Meteo. Live API responses are bounded to 256 KiB with a 20-second timeout.
See [Open-Meteo terms](https://open-meteo.com/en/terms) for usage and attribution.

## JSON rendering, bottoms and limits

Version 1 templates contain only `version` and `blocks`. Blocks are:

| Kind | Required fields |
|---|---|
| `text` | `text`, `style`: `title`, `heading`, `body`, `small` |
| `header` | `left`, `right`: bounded single-line strings; title/small styles, right-aligned detail |
| `compact` | `items`: exactly two objects with `text` and `style`; optional bounded `separator`, default ` / ` |
| `rule` | None |
| `sudoku` | `difficulty`: `easy` or `medium`, unsigned 32-bit `seed` |
| `art` | `name`: `garden` |

Unknown fields/kinds are rejected, including supplied Sudoku grids/solutions.
Input is at most 64 KiB, 128 blocks, 4096 UTF-8 bytes per text block. All text
is transliterated with the existing ASCII utility **before** measured wrapping,
including umlauts and sharp s. An unbreakable word too wide is an error.
Headers reserve a measured gap and reject overlapping content. Compact rows
measure both styled runs before combining them; fallback lines retain their
individual styles. Neither path scales text down or silently clips.
Layout is computed before allocation/IO; overflow is an error, never clipping
or silent truncation. Output is opaque black/white, exactly **384 pixels**
wide, at most **4096 pixels** high and **1 MiB**, matching the helper limits.
Sixteen-dot exterior margins preserve text and descenders.

Jokes and garden vectors were authored for this example, not fetched from a
copyrighted collection or generated by an image service. The two original
Sudoku grids were reduced from a Latin pattern with uniqueness checks.
Easy is solvable with naked singles; medium additionally needs hidden singles,
not guessing. Tests independently grade both and all supported digit/transpose
transformations preserve their difficulty. The renderer verifies exactly one
solution with bounded search before drawing only the givens. No solution is
included in the template, PNG or layout report.

## Offline verification

```sh
swift build
BIN_DIR="$(swift build --show-bin-path)"
"$BIN_DIR/card-renderer-checks"
CARD_RENDERER_BIN="$BIN_DIR/card-renderer" python3 -m unittest discover -s Tests/DailyCardTests -v
swift test  # Full Xcode needed; includes the same Swift card assertions.
```

Tests exercise privacy sentinels in normalized and rendered input, actual
process IO, raster margins/bounds, exact height overflow, ASCII wrapping,
header glyph/alignment preservation, compact fit/fallback, removed footer and
instructions, app-visible provider diagnostics, single-meeting summaries,
bottom variants, blank Sudoku pixels/uniqueness/difficulty, weather alignment,
rain/ties/missing coverage, realistic meeting gaps, midnight/DST, and explicit
provider failure. They never query real calendars/weather or touch Bluetooth.
Image tests are structural, not fragile whole-image snapshots.
