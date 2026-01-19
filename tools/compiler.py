import json
import argparse
from datetime import datetime, date
from zoneinfo import ZoneInfo
from pathlib import Path

# The three unix fields to be updated
UNIX_FIELDS = ["Unix Arrival Arrival", "Unix Arrival", "Unix Arrival Departure"]

# The schedule field (source of truth)
DEFAULT_PRETTY_FIELD = "Pretty Arrival EDT 2026"

# Treat schedule as America/New_York
SCHEDULE_TZ = ZoneInfo("America/New_York")


def parse_pretty_naive(pretty: str) -> datetime:
    """
    Parse strings like:
      "4/4/2026 23:58:00"
      "4/5/2026 0:00:00"
    """
    return datetime.strptime(pretty, "%m/%d/%Y %H:%M:%S")


def extract_items(data):
    """
    Returns (items_list, setter_fn) where setter_fn(updated_items) puts them back.
    Supports:
      - list
      - dict with "stops" list
      - dict with "route" list
    """
    if isinstance(data, list):
        return data, None

    if isinstance(data, dict):
        if "stops" in data and isinstance(data["stops"], list):
            return data["stops"], ("stops", data)
        if "route" in data and isinstance(data["route"], list):
            return data["route"], ("route", data)

    raise ValueError("Unsupported JSON structure. Expected a list or dict with 'stops' or 'route' list.")


def build_date_map(items, pretty_field: str, target_day1: date, target_day2: date) -> dict:
    """
    Finds the unique original dates (in encounter order) from pretty_field,
    then maps:
      first unique date  -> target_day1
      second unique date -> target_day2

    If it doesn't find exactly 2 unique dates, it errors (because you asked for two specific days).
    """
    seen = []
    for item in items:
        pretty = item.get(pretty_field)
        if not pretty:
            continue
        d = parse_pretty_naive(pretty).date()
        if d not in seen:
            seen.append(d)

    if len(seen) != 2:
        raise ValueError(
            f"Expected exactly 2 unique dates in '{pretty_field}', but found {len(seen)}: {seen}"
        )

    return {
        seen[0]: target_day1,
        seen[1]: target_day2
    }


def parse_pretty_dt_with_map(pretty: str, date_map: dict) -> datetime:
    """
    Parse the pretty datetime, then replace its date based on date_map,
    keeping the original time-of-day. Returns timezone-aware datetime.
    """
    dt_naive = parse_pretty_naive(pretty)
    original_date = dt_naive.date()

    if original_date not in date_map:
        raise KeyError(f"Pretty date {original_date} not found in date_map keys: {list(date_map.keys())}")

    new_date = date_map[original_date]
    dt_naive = dt_naive.replace(year=new_date.year, month=new_date.month, day=new_date.day)

    return dt_naive.replace(tzinfo=SCHEDULE_TZ)


def convert_item(item: dict, pretty_field: str, date_map: dict) -> dict:
    """
    Compute Unix timestamps from the Pretty Arrival schedule time,
    remapped onto target dates, preserving original second offsets
    between Arrival Arrival / Arrival / Departure when possible.
    """
    pretty = item.get(pretty_field)
    if not pretty:
        return item

    sched_dt = parse_pretty_dt_with_map(pretty, date_map)
    new_arrival = int(sched_dt.timestamp())

    old_aa = item.get("Unix Arrival Arrival")
    old_a = item.get("Unix Arrival")
    old_ad = item.get("Unix Arrival Departure")

    if old_aa is not None and old_a is not None and old_ad is not None:
        try:
            old_aa = int(old_aa)
            old_a = int(old_a)
            old_ad = int(old_ad)

            offset_before = old_a - old_aa
            offset_after = old_ad - old_a

            item["Unix Arrival"] = new_arrival
            item["Unix Arrival Arrival"] = new_arrival - offset_before
            item["Unix Arrival Departure"] = new_arrival + offset_after
            return item
        except Exception:
            pass

    item["Unix Arrival Arrival"] = new_arrival
    item["Unix Arrival"] = new_arrival
    item["Unix Arrival Departure"] = new_arrival
    return item


def parse_yyyy_mm_dd(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def main():
    ap = argparse.ArgumentParser(
        description="Update Unix arrival fields in data/route.json using Pretty schedule times, remapped onto 2 target dates."
    )

    ap.add_argument(
        "--pretty-field",
        default=DEFAULT_PRETTY_FIELD,
        help='Name of the schedule field (default: "Pretty Arrival EDT 2026")'
    )

    ap.add_argument(
        "--day1",
        default="2027-03-27", # CHANGE TO DATE OF YOUR CHOICE (YYYY-MM-DD)
        help="Target date for day 1 (YYYY-MM-DD). Default: 2027-03-27" # CHANGE TO DATE OF YOUR CHOICE (YYYY-MM-DD)
    )
    ap.add_argument(
        "--day2",
        default="2027-03-28", # CHANGE TO DATE OF YOUR CHOICE (YYYY-MM-DD) DISCLAIMER: DAY 2 IS ALWAYS EASTER DAY
        help="Target date for day 2 (YYYY-MM-DD). Default: 2027-03-28" # CHANGE TO DATE OF YOUR CHOICE (YYYY-MM-DD)
    )

    args = ap.parse_args()
    target_day1 = parse_yyyy_mm_dd(args.day1)
    target_day2 = parse_yyyy_mm_dd(args.day2)

    route_path = Path("data") / "route.json"
    if not route_path.exists():
        raise FileNotFoundError(
            f"Could not find {route_path}. Run this from your project root (the folder that contains /data and /tools)."
        )

    with open(route_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    items, setter = extract_items(data)

    date_map = build_date_map(items, args.pretty_field, target_day1, target_day2)

    converted_items = [convert_item(item, args.pretty_field, date_map) for item in items]

    if setter is None:
        out_data = converted_items
    else:
        key, obj = setter
        obj[key] = converted_items
        out_data = obj

    route_path.parent.mkdir(parents=True, exist_ok=True)
    with open(route_path, "w", encoding="utf-8") as f:
        json.dump(out_data, f, ensure_ascii=False, indent=2)

    print("Done. Updated in-place:", route_path)
    print("Pretty field:", args.pretty_field)
    print("Mapped original dates -> target dates:")
    for k, v in date_map.items():
        print(f"  {k} -> {v}")


if __name__ == "__main__":
    main()