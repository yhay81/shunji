#!/usr/bin/env python3
"""Build a compact, reproducible SQLite/Cloudflare D1 edition of JMdict English."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sqlite3
import sys
import time
import xml.etree.ElementTree as ET
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Any


EXPECTED_MINIMUM_ENTRIES = 200_000
MAXIMUM_SQL_STATEMENT_BYTES = 88_000


def child_texts(parent: ET.Element, name: str) -> list[str]:
    return [child.text or "" for child in parent.findall(name)]


def priority_score(tags: Iterable[str]) -> int:
    best = 9
    for tag in tags:
        if tag in {"ichi1", "news1", "spec1"}:
            best = min(best, 0)
        elif tag == "gai1":
            best = min(best, 1)
        elif tag in {"ichi2", "news2", "spec2", "gai2"}:
            best = min(best, 2)
        elif tag.startswith("nf") and tag[2:].isdigit():
            best = min(best, 3 + min(int(tag[2:]) // 10, 4))
    return best


def optional(item: dict[str, Any], key: str, values: list[str]) -> None:
    if values:
        item[key] = values


def parse_entry(entry: ET.Element) -> tuple[int, str, int, str, list[tuple[str, int, int]], str]:
    entry_id = int(entry.findtext("ent_seq") or "0")
    writings: list[dict[str, Any]] = []
    readings: list[dict[str, Any]] = []
    terms: list[tuple[str, int, int]] = []
    scores: list[int] = []

    for element in entry.findall("k_ele"):
        value = element.findtext("keb") or ""
        priorities = child_texts(element, "ke_pri")
        score = priority_score(priorities)
        item: dict[str, Any] = {"t": value}
        optional(item, "p", priorities)
        optional(item, "i", child_texts(element, "ke_inf"))
        writings.append(item)
        terms.append((value, score, 0))
        scores.append(score)

    for element in entry.findall("r_ele"):
        value = element.findtext("reb") or ""
        priorities = child_texts(element, "re_pri")
        score = priority_score(priorities)
        item = {"t": value}
        optional(item, "p", priorities)
        optional(item, "i", child_texts(element, "re_inf"))
        optional(item, "k", child_texts(element, "re_restr"))
        if element.find("re_nokanji") is not None:
            item["n"] = 1
        readings.append(item)
        terms.append((value, score, 1))
        scores.append(score)

    senses: list[dict[str, Any]] = []
    glosses: list[str] = []
    mappings = (
        ("p", "pos"),
        ("f", "field"),
        ("m", "misc"),
        ("d", "dial"),
        ("i", "s_inf"),
        ("x", "xref"),
        ("a", "ant"),
        ("k", "stagk"),
        ("r", "stagr"),
    )
    for element in entry.findall("sense"):
        sense_glosses = child_texts(element, "gloss")
        glosses.extend(sense_glosses)
        item = {"g": sense_glosses}
        for key, tag in mappings:
            optional(item, key, child_texts(element, tag))
        senses.append(item)

    if not readings or not senses:
        raise ValueError(f"JMdict entry {entry_id} is missing a reading or sense")
    headword = writings[0]["t"] if writings else readings[0]["t"]
    score = min(scores or [9])
    unique_terms: dict[str, tuple[int, int]] = {}
    for term, term_score, kind in terms:
        current = unique_terms.get(term)
        if current is None or term_score < current[0]:
            unique_terms[term] = (term_score, kind)
    payload = json.dumps(
        {"w": writings, "r": readings, "s": senses},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return (
        entry_id,
        headword,
        score,
        payload,
        [(term, values[0], values[1]) for term, values in unique_terms.items()],
        " | ".join(glosses),
    )


def source_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sql_literal(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def write_batched_insert(
    output: Any,
    table: str,
    columns: tuple[str, ...],
    rows: Iterable[tuple[object, ...]],
) -> int:
    prefix = f"INSERT INTO {table} ({','.join(columns)}) VALUES\n"
    batch: list[str] = []
    size = len(prefix.encode("utf-8")) + 2
    count = 0
    for row in rows:
        encoded = "(" + ",".join(sql_literal(value) for value in row) + ")"
        encoded_size = len(encoded.encode("utf-8")) + 2
        if batch and size + encoded_size > MAXIMUM_SQL_STATEMENT_BYTES:
            output.write(prefix + ",\n".join(batch) + ";\n")
            batch = []
            size = len(prefix.encode("utf-8")) + 2
        batch.append(encoded)
        size += encoded_size
        count += 1
    if batch:
        output.write(prefix + ",\n".join(batch) + ";\n")
    return count


def entry_rows(database: sqlite3.Connection) -> Iterator[tuple[object, ...]]:
    yield from database.execute("SELECT id,headword,score,payload FROM entries ORDER BY id")


def term_rows(database: sqlite3.Connection) -> Iterator[tuple[object, ...]]:
    yield from database.execute("SELECT term,entry_id,score,kind FROM terms ORDER BY term,entry_id")


def fts_rows(database: sqlite3.Connection) -> Iterator[tuple[object, ...]]:
    for entry_id, payload in database.execute("SELECT id,payload FROM entries ORDER BY id"):
        parsed = json.loads(payload)
        glosses = " | ".join(
            gloss
            for sense in parsed["s"]
            for gloss in sense.get("g", [])
        )
        yield entry_id, glosses


def export_sql(database: sqlite3.Connection, directory: Path, metadata: dict[str, str]) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    files = {
        "00-clear.sql": (
            "PRAGMA defer_foreign_keys = true;\n"
            "DELETE FROM terms;\n"
            "DELETE FROM entries;\n"
            "INSERT INTO entry_fts(entry_fts) VALUES('delete-all');\n"
            "DELETE FROM dictionary_meta;\n"
        ),
    }
    for name, content in files.items():
        (directory / name).write_text(content, encoding="utf-8", newline="\n")

    exports = (
        ("10-entries.sql", "entries", ("id", "headword", "score", "payload"), entry_rows(database)),
        ("20-terms.sql", "terms", ("term", "entry_id", "score", "kind"), term_rows(database)),
        ("30-fts.sql", "entry_fts", ("rowid", "glosses"), fts_rows(database)),
        (
            "40-meta.sql",
            "dictionary_meta",
            ("key", "value"),
            iter(sorted(metadata.items())),
        ),
    )
    for name, table, columns, rows in exports:
        with (directory / name).open("w", encoding="utf-8", newline="\n") as output:
            output.write("PRAGMA defer_foreign_keys = true;\n")
            count = write_batched_insert(output, table, columns, rows)
        print(f"exported {name}: {count:,} rows", flush=True)


def build(source: Path, database_path: Path, sql_directory: Path, source_date: str) -> None:
    if database_path.exists():
        database_path.unlink()
    schema_path = Path(__file__).resolve().parents[1] / "migrations" / "0001_dictionary.sql"
    database = sqlite3.connect(database_path)
    database.executescript("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY;")
    database.executescript(schema_path.read_text(encoding="utf-8"))
    started = time.perf_counter()
    entries = 0
    terms = 0
    with gzip.open(source, "rb") as stream:
        for _, element in ET.iterparse(stream, events=("end",)):
            if element.tag != "entry":
                continue
            entry_id, headword, score, payload, entry_terms, glosses = parse_entry(element)
            database.execute(
                "INSERT INTO entries(id,headword,score,payload) VALUES(?,?,?,?)",
                (entry_id, headword, score, payload),
            )
            database.executemany(
                "INSERT INTO terms(term,entry_id,score,kind) VALUES(?,?,?,?)",
                ((term, entry_id, term_score, kind) for term, term_score, kind in entry_terms),
            )
            database.execute(
                "INSERT INTO entry_fts(rowid,glosses) VALUES(?,?)",
                (entry_id, glosses),
            )
            entries += 1
            terms += len(entry_terms)
            if entries % 5_000 == 0:
                database.commit()
                print(f"parsed {entries:,} entries", flush=True)
            element.clear()
    if entries < EXPECTED_MINIMUM_ENTRIES:
        raise RuntimeError(f"Only {entries:,} entries parsed; refusing an incomplete dictionary")

    digest = source_sha256(source)
    metadata = {
        "entry_count": str(entries),
        "generated_at": source_date,
        "license": "CC BY-SA 4.0",
        "source": "JMdict English (EDRDG)",
        "source_sha256": digest,
        "term_count": str(terms),
    }
    database.executemany(
        "INSERT INTO dictionary_meta(key,value) VALUES(?,?)",
        sorted(metadata.items()),
    )
    database.execute("ANALYZE")
    database.commit()
    integrity = database.execute("PRAGMA integrity_check").fetchone()
    if not integrity or integrity[0] != "ok":
        raise RuntimeError(f"SQLite integrity check failed: {integrity}")
    export_sql(database, sql_directory, metadata)
    database.close()
    elapsed = time.perf_counter() - started
    print(
        json.dumps(
            {
                "database_bytes": database_path.stat().st_size,
                "entries": entries,
                "seconds": round(elapsed, 2),
                "sha256": digest,
                "terms": terms,
            },
            ensure_ascii=False,
        )
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--sql-directory", required=True, type=Path)
    parser.add_argument("--source-date", required=True)
    arguments = parser.parse_args()
    arguments.database.parent.mkdir(parents=True, exist_ok=True)
    build(arguments.source, arguments.database, arguments.sql_directory, arguments.source_date)
    return 0


if __name__ == "__main__":
    sys.exit(main())
