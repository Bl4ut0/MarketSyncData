"""Compile a versioned recipe catalog from Wago's exports of a specific WoW build."""

import argparse
import csv
from collections import Counter, defaultdict
import json
from pathlib import Path
import re
import shutil
from urllib.request import Request, urlopen


BUILDS = {
    "forever": "1.60.1.71037",
    "classicEra": "1.15.9.70576",
    "anniversary": "2.5.6.70577",
    "classic": "5.5.4.71060",
    "retail": "12.1.5.70961",
}
PROFESSIONS = {40, 129, 164, 165, 171, 182, 185, 186, 197, 202, 333, 356, 393, 755, 773, 794}
# Common unlimited-stock reagents already priced by MarketSync. Use the
# build's unit buy price wherever the item still has this vendor price.
VENDOR_REAGENTS = {159, 1179, 2320, 2321, 2604, 2605, 2678, 2692, 2880, 3081, 3371, 3372,
                   3466, 3713, 3857, 4289, 4291, 4399, 4400, 8925, 14341, 38682, 39354}
CREATE_ITEM = {24, 157}
TABLES = ("SkillLine", "SkillLineAbility", "SpellName", "SpellReagents", "SpellEffect", "ItemSparse")


def download_tables(directory, build):
    directory.mkdir(parents=True, exist_ok=True)
    for table in TABLES:
        destination = directory / f"{table}.csv"
        if destination.is_file():
            continue
        temporary = destination.with_suffix(".csv.tmp")
        url = f"https://wago.tools/db2/{table}/csv?build={build}"
        request = Request(url, headers={"User-Agent": "MarketSyncData/1.0"})
        with urlopen(request, timeout=90) as response, temporary.open("wb") as stream:
            shutil.copyfileobj(response, stream)
        with temporary.open(encoding="utf-8-sig") as stream:
            if len(stream.readline().split(",")) < 2:
                raise ValueError(f"{table} {build} did not return CSV data")
        temporary.replace(destination)


def rows(directory, table):
    with (directory / f"{table}.csv").open(encoding="utf-8-sig", newline="") as stream:
        yield from csv.DictReader(stream)


def integer(row, field):
    return int(row.get(field) or "0")


def read_materials(row):
    materials = Counter()
    for reagent in sorted(key for key in row if re.fullmatch(r"Reagent_\d+", key)):
        item = integer(row, reagent)
        quantity = integer(row, reagent.replace("Reagent_", "ReagentCount_", 1))
        if quantity > 0:
            if item <= 0:
                return None
            materials[item] += quantity
    return [[item, quantity] for item, quantity in sorted(materials.items())]


def compile_catalog(directory, flavor, build):
    skills = {integer(row, "ID"): row for row in rows(directory, "SkillLine")}

    def root_skill(skill):
        seen = set()
        while skill and skill not in seen and skill in skills:
            if skill in PROFESSIONS:
                return skill
            seen.add(skill)
            skill = integer(skills[skill], "ParentSkillLineID")
        return None

    abilities = {}
    for row in rows(directory, "SkillLineAbility"):
        skill = root_skill(integer(row, "SkillLine"))
        if skill:
            abilities.setdefault(integer(row, "Spell"), skill)

    reagents = {}
    for row in rows(directory, "SpellReagents"):
        spell = integer(row, "SpellID")
        if spell in abilities:
            materials = read_materials(row)
            if materials or materials is None:
                if spell in reagents and reagents[spell] != materials:
                    reagents[spell] = None
                else:
                    reagents[spell] = materials

    spell_names = {
        integer(row, "ID"): row["Name_lang"]
        for row in rows(directory, "SpellName") if integer(row, "ID") in reagents
    }

    effects = defaultdict(dict)
    for row in rows(directory, "SpellEffect"):
        spell = integer(row, "SpellID")
        if spell not in reagents or integer(row, "DifficultyID") != 0:
            continue
        item = integer(row, "EffectItemType")
        if integer(row, "Effect") not in CREATE_ITEM:
            continue
        index = integer(row, "EffectIndex")
        if item > 0:
            amount = float(row.get("EffectBasePointsF") or "0") or float(row.get("EffectBasePoints") or "0")
            # Classic Era and TBC store their create-item magnitude as yield minus one.
            if flavor in {"classicEra", "anniversary"}:
                amount += 1
            variance = float(row.get("Variance") or "0")
            effects[spell][index] = (item, int(amount) if amount.is_integer() and amount > 0 and variance == 0 else 0)
        else:
            effects[spell][index] = (0, 0)

    recipes = []
    counts = Counter()
    unsupported = Counter()
    seen = set()
    item_ids = set()
    for spell, materials in sorted(reagents.items()):
        skill = abilities[spell]
        name = spell_names.get(spell, "").strip()
        if not name or re.search(r"\b(?:DNT|NYI|UNUSED|REUSE)\b|\(OLD\)", name, re.IGNORECASE):
            continue
        outputs = effects[spell]
        if not materials or len(outputs) != 1:
            unsupported[skill] += 1
            continue
        item, quantity = next(iter(outputs.values()))
        if not quantity or any(ingredient == item for ingredient, _ in materials):
            unsupported[skill] += 1
            continue
        signature = (skill, item, quantity, tuple(map(tuple, materials)))
        if signature in seen:
            continue
        seen.add(signature)
        recipes.append({"id": spell, "profession": skill, "name": name,
                        "itemId": item, "yield": quantity, "reagents": materials})
        item_ids.update([item, *(ingredient for ingredient, _ in materials)])

    items = {}
    vendor_prices = {}
    for row in rows(directory, "ItemSparse"):
        item = integer(row, "ID")
        if item not in item_ids:
            continue
        name = row["Display_lang"].strip()
        if name:
            items[item] = name
        price = integer(row, "BuyPrice")
        if item in VENDOR_REAGENTS and price > 0:
            vendor_prices[item] = price // max(1, integer(row, "BuyCount"))

    verified = []
    for recipe in recipes:
        skill = recipe["profession"]
        if recipe["itemId"] not in items or any(item not in items for item, _ in recipe["reagents"]):
            # Some build tables retain inactive recipes for items missing from that build.
            unsupported[skill] += 1
            continue
        verified.append(recipe)
        counts[skill] += 1
    published_items = {
        item for recipe in verified for item in [recipe["itemId"], *(item for item, _ in recipe["reagents"])]
    }
    professions = [
        {"id": skill, "name": skills[skill]["DisplayName_lang"], "recipeCount": counts[skill],
         "unsupportedCount": unsupported[skill]}
        for skill in PROFESSIONS if skill in skills
    ]
    return {"version": 1, "flavor": flavor, "build": build,
            "professions": sorted(professions, key=lambda record: record["name"]),
            "recipes": verified, "items": {item: name for item, name in items.items() if item in published_items},
            "vendorPrices": {item: price for item, price in vendor_prices.items() if item in published_items}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db2-root", type=Path, required=True,
                        help="Folder with one subdirectory per build containing the six DB2 CSV exports")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "datasets")
    parser.add_argument("--flavor", choices=BUILDS)
    parser.add_argument("--build", help="Override the pinned build for one flavor")
    parser.add_argument("--download", action="store_true", help="Download missing Wago CSV files for the selected builds")
    args = parser.parse_args()
    if args.build and (not args.flavor or not re.fullmatch(r"\d+\.\d+\.\d+\.\d+", args.build)):
        parser.error("--build requires --flavor and a four-part WoW build number")
    for flavor in [args.flavor] if args.flavor else BUILDS:
        build = args.build or BUILDS[flavor]
        directory = args.db2_root / build
        if args.download:
            download_tables(directory, build)
        catalog = compile_catalog(directory, flavor, build)
        if not catalog["recipes"]:
            raise ValueError(f"{flavor} {build} had no fixed-output recipes")
        destination = args.output / flavor / "recipes.json"
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
        temporary.replace(destination)
        print(f"{flavor} {build}: {len(catalog['recipes'])} recipes across "
              f"{sum(p['recipeCount'] > 0 for p in catalog['professions'])} professions")


if __name__ == "__main__":
    main()
