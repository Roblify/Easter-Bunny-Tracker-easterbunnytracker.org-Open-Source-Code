# compiler.py
# Create route.json by re-dating Pretty Arrival times to start on whichever test day (E.g: 1/1/2026) (EDT),
# preserving time-of-day and original per-stop offsets between:
#   "Unix Arrival Arrival" -> "Unix Arrival" -> "Unix Arrival Departure"
#
# IMPORTANT RULE (per your request):
# - Ignore any stop where DR == 0 (skip base-date detection + skip conversion).
#
# Default:
#   input  = (outdated) route.json   (resolved to data/route.json)
#   output = (new) route.json        (resolved to data/route.json)
#
#  Before creating the new route.json, the existing route.json is renamed to 'DELETETHIS.json'.
#
# Run:
#   python tools/compiler.py
#   python tools/compiler.py route.json
#   python tools/compiler.py data/route.json

import json
import argparse
from datetime import datetime, date, timedelta
from zoneinfo import ZoneInfo
from typing import Any, Dict, List, Tuple
from pathlib import Path

SCHEDULE_TZ = ZoneInfo("America/New_York")

DEFAULT_PRETTY_FIELD = "Pretty Arrival EDT 2026"

FIELD_AA = "Unix Arrival Arrival"
FIELD_A  = "Unix Arrival"
FIELD_AD = "Unix Arrival Departure"

DEFAULT_INFILE = "route.json"
DEFAULT_OUTFILE = "route.json"


def resolve_route_path(user_path: str, default_dir: Path) -> Path:
    """
    If user_path is absolute, use it.
    If it's a relative path that already includes folders, use it as-is.
    If it's just a filename (e.g. route.json), resolve it inside default_dir.
    """
    p = Path(user_path)

    # Absolute path? Use it directly.
    if p.is_absolute():
        return p

    # If they provided a folder (like data/route.json), keep it relative to CWD.
    if len(p.parts) > 1:
        return p

    # Just a filename -> assume it's in default_dir
    return default_dir / p


def parse_pretty_dt(pretty: str) -> datetime:
    """
    Parses strings like:
      "4/4/2026 23:58:00"
      "4/5/2026 0:00:00"
    Robust to 1- or 2-digit month/day/hour. Returns tz-aware datetime in America/New_York.
    """
    pretty = (pretty or "").strip()
    if not pretty:
        raise ValueError("Empty Pretty field")

    parts = pretty.split()
    if len(parts) != 2:
        raise ValueError(f"Expected 'M/D/YYYY H:MM:SS', got: {pretty!r}")

    date_part, time_part = parts

    try:
        m, d, y = date_part.split("/")
        hh, mm, ss = time_part.split(":")
        dt_naive = datetime(
            int(y), int(m), int(d),
            int(hh), int(mm), int(ss)
        )
    except Exception as e:
        raise ValueError(f"Bad Pretty datetime format: {pretty!r}") from e

    return dt_naive.replace(tzinfo=SCHEDULE_TZ)


def format_pretty_dt(dt: datetime) -> str:
    """
    Writes in your style: M/D/YYYY H:MM:SS (month/day/hour not forced to 2 digits).
    """
    return f"{dt.month}/{dt.day}/{dt.year} {dt.hour}:{dt.minute:02d}:{dt.second:02d}"


def extract_stops(data: Any) -> Tuple[List[Dict[str, Any]], str]:
    """
    Returns (stops_list, shape), where shape indicates how to write it back:
      - "list"
      - "dict_stops"
      - "dict_route"
      - "dict_single"
    """
    if isinstance(data, list):
        return data, "list"
    if isinstance(data, dict):
        if isinstance(data.get("stops"), list):
            return data["stops"], "dict_stops"
        if isinstance(data.get("route"), list):
            return data["route"], "dict_route"
        return [data], "dict_single"
    raise ValueError("Unsupported JSON structure. Expected a list or dict.")


def write_back(original: Any, shape: str, new_stops: List[Dict[str, Any]]) -> Any:
    if shape == "list":
        return new_stops
    if shape == "dict_stops":
        original["stops"] = new_stops
        return original
    if shape == "dict_route":
        original["route"] = new_stops
        return original
    if shape == "dict_single":
        return new_stops[0] if new_stops else original
    raise ValueError(f"Unknown shape: {shape}")


def compute_base_date(stops: List[Dict[str, Any]], pretty_field: str) -> date:
    """
    Find the earliest calendar date in pretty_field, ignoring any stop with DR == 0.
    """
    seen: List[date] = []

    for s in stops:
        # ✅ Ignore DR 0 completely
        if s.get("DR") == 0:
            continue

        pretty = s.get(pretty_field)
        if not pretty:
            continue

        try:
            dt = parse_pretty_dt(pretty)
            seen.append(dt.date())
        except Exception:
            continue

    if not seen:
        raise ValueError(f"No valid {pretty_field!r} values found after ignoring DR 0 entries.")

    return min(seen)


def convert_item_for_test(
    item: Dict[str, Any],
    pretty_field: str,
    orig_base: date,
    test_base: date
) -> Dict[str, Any]:
    """
    Re-date this stop's Pretty datetime to the test window, preserving time-of-day (EDT),
    and rebuild Unix timestamps, preserving original offsets when possible.
    Skips DR == 0.
    """
    # ✅ Ignore DR 0 completely
    if item.get("DR") == 0:
        return item

    pretty = item.get(pretty_field)
    if not pretty:
        return item

    # Parse original schedule dt (tz-aware)
    sched_dt = parse_pretty_dt(pretty)

    # Shift by day offset relative to original base date
    day_offset = (sched_dt.date() - orig_base).days
    new_date = test_base + timedelta(days=day_offset)

    # Keep time-of-day the same in EDT
    new_sched_dt = datetime(
        new_date.year, new_date.month, new_date.day,
        sched_dt.hour, sched_dt.minute, sched_dt.second,
        tzinfo=SCHEDULE_TZ
    )

    new_arrival = int(new_sched_dt.timestamp())

    # Update Pretty field so output reflects the testing date
    item[pretty_field] = format_pretty_dt(new_sched_dt)

    # Preserve original offsets if possible
    old_aa = item.get(FIELD_AA)
    old_a  = item.get(FIELD_A)
    old_ad = item.get(FIELD_AD)

    if old_aa is not None and old_a is not None and old_ad is not None:
        try:
            old_aa_i = int(old_aa)
            old_a_i  = int(old_a)
            old_ad_i = int(old_ad)

            offset_before = old_a_i - old_aa_i   # Arrival - ArrivalArrival
            offset_after  = old_ad_i - old_a_i   # ArrivalDeparture - Arrival

            item[FIELD_A]  = new_arrival
            item[FIELD_AA] = new_arrival - offset_before
            item[FIELD_AD] = new_arrival + offset_after
            return item
        except Exception:
            pass

    # Fallback: set all three to the same instant
    item[FIELD_AA] = new_arrival
    item[FIELD_A]  = new_arrival
    item[FIELD_AD] = new_arrival
    return item


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Create route-testing.json by shifting Pretty Arrival times to a test base date (EDT), ignoring DR 0, and rebuilding Unix timestamps."
    )

    ap.add_argument(
        "input",
        nargs="?",
        default=DEFAULT_INFILE,
        help=f"Input route JSON (default: {DEFAULT_INFILE} in /data)"
    )

    ap.add_argument(
        "--pretty-field",
        default=DEFAULT_PRETTY_FIELD,
        help=f'Name of the schedule field (default: "{DEFAULT_PRETTY_FIELD}")'
    )
    ap.add_argument(
        "--test-base-date",
        default="2026-3-13",
        help="Test base date in YYYY-MM-DD (default: 2026-3-13)"
    )
    args = ap.parse_args()

    # Parse test base date
    try:
        y, m, d = (int(x) for x in args.test_base_date.split("-"))
        test_base = date(y, m, d)
    except Exception as e:
        raise ValueError("--test-base-date must be YYYY-MM-DD, e.g. 2026-3-13") from e

    # Default data folder (project root)
    data_dir = Path("data")

    input_path = resolve_route_path(args.input, data_dir)
    output_path = input_path  # always overwrite the same file

    with open(input_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    stops, shape = extract_stops(data)

    orig_base = compute_base_date(stops, args.pretty_field)

    converted_stops: List[Dict[str, Any]] = []
    converted_count = 0
    skipped_dr0 = 0

    for s in stops:
        if isinstance(s, dict) and s.get("DR") == 0:
            skipped_dr0 += 1
            converted_stops.append(s)
            continue

        if isinstance(s, dict):
            before = s.get(args.pretty_field)
            converted_stops.append(convert_item_for_test(s, args.pretty_field, orig_base, test_base))
            after = converted_stops[-1].get(args.pretty_field)
            if before != after:
                converted_count += 1
        else:
            converted_stops.append(s)

    out_data = write_back(data, shape, converted_stops)

    # Rename the existing file to DELETETHIS.json before writing the new one
    delete_path = output_path.parent / "DELETETHIS.json"
    if output_path.exists():
        output_path.rename(delete_path)
        print(f"Renamed existing {output_path.name} -> {delete_path.name}")

    # Ensure output folder exists
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(out_data, f, ensure_ascii=False, indent=2)

    print("Done.")
    print(f"Input:  {input_path}")
    print(f"Output: {output_path}")
    print(f"Pretty field: {args.pretty_field}")
    print(f"Original base date detected (ignoring DR 0): {orig_base.isoformat()}")
    print(f"Test base date: {test_base.isoformat()} (EDT via America/New_York)")
    print(f"Converted stops: {converted_count}")
    print(f"Skipped DR 0 stops: {skipped_dr0}")


if __name__ == "__main__":
    main()
