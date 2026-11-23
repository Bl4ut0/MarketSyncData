"""Add Forever item classifications from same-build Item and ItemSparse CSV exports."""

import argparse
import csv
import json
from pathlib import Path
import re
import time
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


def observed_ids(directory):
    items = set()
    for path in sorted(directory.glob("*/*-00.json")):
        snapshot = json.loads(path.read_text(encoding="utf-8-sig"))
        if snapshot.get("stats", {}).get("status") != "live":
            continue
        for faction_maps in snapshot.get("rulesets", {}).values():
            for market in faction_maps.values():
                items.update(key.split(":", 1)[0] for key in market)
    return items


def read_rows(path, wanted):
    with path.open(encoding="utf-8-sig", newline="") as source:
        return {row["ID"]: row for row in csv.DictReader(source) if row["ID"] in wanted}


def read_cached_items(path):
    """Read only item metadata from WoW's text serialization without running Lua."""
    entries = {}
    with path.open(encoding="utf-8-sig") as source:
        for line in source:
            if line.strip() == '["ItemInfoCache"] = {':
                break
        else:
            return entries
        item_id = None
        for line in source:
            value = line.strip()
            if value == "},":
                if item_id is None:
                    break
                item_id = None
                continue
            item = re.fullmatch(r"\[(\d+)] = \{", value)
            if item:
                item_id = item[1]
                entries[item_id] = {}
                continue
            field = re.fullmatch(r'\["([nrcsi])"] = (.+),', value)
            if item_id and field:
                try:
                    entries[item_id][field[1]] = json.loads(field[2])
                except json.JSONDecodeError:
                    continue
    return entries


def resolve_missing_names(items, wanted):
    pending = sorted((key for key in wanted if key in items and not items[key].get("name")), key=int)
    for key in pending:
        try:
            with urlopen(f"https://nether.wowhead.com/forever/tooltip/item/{int(key)}", timeout=5) as response:
                metadata = json.load(response)
            name = metadata.get("name")
            if isinstance(name, str) and name.strip():
                items[key]["name"] = name
        except HTTPError as error:
            if error.code != 404:
                print(f"Stopped Wowhead lookups at item {key} (HTTP {error.code})")
                break
        except (URLError, TimeoutError, ValueError) as error:
            print(f"Stopped Wowhead lookups at item {key} ({type(error).__name__})")
            break
        time.sleep(0.25)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("build", help="Build identifier shared by both CSV exports")
    parser.add_argument("item", type=Path)
    parser.add_argument("item_sparse", type=Path)
    parser.add_argument("--item-cache", type=Path, help="Optional Forever MarketSync.lua SavedVariables")
    parser.add_argument("--resolve-missing-names", action="store_true", help="Query only missing names from Forever Wowhead")
    parser.add_argument("--directory", type=Path, default=Path("datasets/forever"))
    args = parser.parse_args()

    wanted = observed_ids(args.directory)
    if not wanted:
        parser.error("No live Forever auction captures found")
    output = args.directory / "catalog.json"
    catalog = json.loads(output.read_text(encoding="utf-8-sig")) if output.exists() else {}
    items = catalog.setdefault("items", {})
    if catalog.get("flavor", "forever") != "forever":
        parser.error("Expected a Forever catalog")

    classified_before = len(wanted & items.keys())
    named_before = sum(bool(items.get(key, {}).get("name")) for key in wanted)
    rows = read_rows(args.item, wanted)
    sparse = read_rows(args.item_sparse, wanted)
    cached = read_cached_items(args.item_cache) if args.item_cache else {}
    for key, row in rows.items():
        entry = items.setdefault(key, {
            "itemClass": int(row["ClassID"]),
            "itemSubclass": int(row["SubclassID"]),
        })
        detail = sparse.get(key, {})
        name = detail.get("Display_lang", "").strip()
        if name:
            entry.setdefault("name", name)
        for field, column in (("quality", "OverallQualityID"), ("itemLevel", "ItemLevel"),
                              ("reqLevel", "RequiredLevel")):
            value = detail.get(column, "")
            if value.isdecimal():
                entry.setdefault(field, int(value))
        client = cached.get(key, {})
        if client.get("c") == entry["itemClass"] and client.get("s") == entry["itemSubclass"]:
            name = client.get("n")
            if isinstance(name, str) and name.strip():
                entry.setdefault("name", name)
            for field, column in (("quality", "r"), ("itemLevel", "i")):
                value = client.get(column)
                if isinstance(value, int) and value >= 0:
                    entry.setdefault(field, value)

    if args.resolve_missing_names:
        resolve_missing_names(items, wanted)

    catalog.update(version=1, flavor="forever", db2Build=args.build)
    temporary = output.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    temporary.replace(output)
    print(f"{len(wanted & items.keys()):,}/{len(wanted):,} observed IDs classified ({classified_before:,} before)")
    named = sum(bool(items.get(key, {}).get("name")) for key in wanted)
    print(f"{named:,}/{len(wanted):,} observed IDs named ({named_before:,} before)")


if __name__ == "__main__":
    main()
