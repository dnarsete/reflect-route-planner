# Route Planner

A day-planner for field reps: load a list of accounts, get an ordered,
time-blocked route back, then drive it in Google Maps, Waze or Apple Maps.

## Running it

Double-click `serve.py`, or from Terminal:

    python3 "/Users/dannarsete/Desktop/The Reflect Co/route-planner/serve.py"

Then open <http://localhost:5176> in any browser. It also works on a phone on the
same wifi if you change `127.0.0.1` to `0.0.0.0` in `serve.py`.

To put it online, the folder can be pushed to GitHub Pages exactly as it is —
there is no build step.

## Files

| File | What it is |
|---|---|
| `index.html` | The screens: Stops, Route, Map, Help |
| `app.js` | Import, geocoding, optimizer, scheduler, exports |
| `styles.css` | Theme, matched to the Reflect CRM (navy / burnt sienna) |
| `serve.py` | Local test server on port 5176 |

## The spreadsheet

One row per stop. Headers can be named loosely — `Account Name`, `Street
Address` and `Phone Number` all get matched automatically, and anything the
app guesses wrong can be remapped before importing.

| Column | Required | Notes |
|---|---|---|
| Name | no | Falls back to the address |
| Address | **yes** | Street line; `City` / `State` / `Zip` are joined onto it if present |
| Phone | no | Becomes a tap-to-call button |
| Minutes | no | Time needed at that stop; otherwise the default from the Timing card |
| Time | no | A fixed appointment, e.g. `11:00` or `2:30 PM` |
| Notes | no | Shown on the stop card and in the export |

**Download template** on the Stops tab writes a correctly-shaped file.

## How the route is chosen

Every candidate ordering is scored as **driving minutes + waiting minutes**,
with a heavy penalty for missing a fixed appointment. Driving and waiting are
weighed the same because both are time off the clock — minimizing the two
together is the same as finishing the day as early as possible. A
nearest-neighbour pass seeds the order and 2-opt improves it; stops with fixed
appointments are laid down first in clock order and the rest are slotted into
whichever gap costs least.

Buffer is padding added after each visit, on top of drive time. It starts at the
minimum you set. When the schedule runs early into a fixed appointment, the
idle time is rolled back into the preceding buffer up to the maximum; anything
past that is flagged as open time — room for another stop.

## Routing engines

**Without a Google Maps API key** (the default) addresses are located with
OpenStreetMap's Nominatim and drive times come from OSRM, which routes on real
roads at typical speeds. Live traffic then comes from Google Maps or Waze when
you actually navigate. These are free public services; Nominatim is rate-limited
to one lookup per second, so a 20-stop import takes about 25 seconds the first
time. Results are cached, so re-planning is instant.

**With a Google Maps API key** (Timing → Advanced) the planning itself becomes
traffic-aware: Google predicts what each leg will take at your departure time
and the day is sequenced against those numbers. Google's Directions service
handles 23 stops per route; past that the free engine sequences the day. A key
requires a Google Cloud account with billing enabled.

## Limits

- 60 stops per plan.
- Google Maps' share links carry 10 points each, so longer days open as
  numbered parts that chain end-to-start.
- Waze and Apple Maps take one destination at a time — those are the per-stop
  buttons on each card.
- Single day. Multi-day trip splitting is not built.

## Data

Stops, addresses and settings are saved in the browser's local storage on that
device only. Addresses go to the mapping service to be located; nothing else
leaves the app. Clearing the browser's site data clears the stop list.
