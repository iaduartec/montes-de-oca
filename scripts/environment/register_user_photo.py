#!/usr/bin/env python3
"""Register a local reference without inventing provenance or distribution rights.

Example: --file fotos/Iglesia_plaza.jpg --osm-way 90614388 --facade south
Existing records are replaced only with --replace. Dates/author/permission remain
unknown unless explicitly supplied; EXIF dates are metadata, not verified dates.
"""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / 'assets/environment/real-structures/user-photos.json'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--file')
    parser.add_argument('--osm-way', type=int, action='append', default=[])
    parser.add_argument('--facade')
    parser.add_argument('--camera-bearing', type=float)
    parser.add_argument('--latitude', type=float)
    parser.add_argument('--longitude', type=float)
    parser.add_argument('--date')
    parser.add_argument('--author')
    parser.add_argument('--permission', choices=['reference-only', 'distribution-authorized', 'unknown'], default='unknown')
    parser.add_argument('--replace', action='store_true')
    parser.add_argument('--check', action='store_true', help='validate all records without writing')
    args = parser.parse_args()
    ledger = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {'schemaVersion': 1, 'photos': []}
    raw = json.loads((ROOT / 'data/gameplay/raw/osm_buildings_villafranca.json').read_text())
    building_ids = {element['id'] for element in raw['elements']}
    if args.check:
        for record in ledger['photos']:
            path = (ROOT / record['file']).resolve()
            if not path.is_relative_to(ROOT) or not path.is_file():
                parser.error(f"missing/outside repo: {record['file']}")
            if hashlib.sha256(path.read_bytes()).hexdigest() != record['sha256']:
                parser.error(f"changed photo: {record['file']}")
            if not set(record['osmWayIds']).issubset(building_ids):
                parser.error(f"unknown OSM ID: {record['file']}")
            if record['permission'] == 'distribution-authorized' and not record['author']:
                parser.error(f"distribution author unknown: {record['file']}")
        print(f"PASS {len(ledger['photos'])} local photo records; unknown permissions remain unknown")
        return
    if not args.file:
        parser.error('--file is required when registering a photo')
    path = (ROOT / args.file).resolve()
    if not path.is_relative_to(ROOT) or not path.is_file():
        parser.error('photo must exist inside the repository')
    header = path.read_bytes()[:8]
    if not (header.startswith(b'\xff\xd8\xff') or header == b'\x89PNG\r\n\x1a\n'):
        parser.error('reference must be a JPEG or PNG image, not a downloaded HTML page')
    if not set(args.osm_way).issubset(building_ids):
        parser.error('OSM way must exist in the versioned building snapshot')
    if args.camera_bearing is not None and not 0 <= args.camera_bearing < 360:
        parser.error('camera bearing must be in [0, 360)')
    if (args.latitude is None) != (args.longitude is None):
        parser.error('provide both latitude and longitude')
    if args.latitude is not None and not (-90 <= args.latitude <= 90 and -180 <= args.longitude <= 180):
        parser.error('invalid geographic position')
    if args.permission == 'distribution-authorized' and not args.author:
        parser.error('distribution permission requires an author')
    relative = path.relative_to(ROOT).as_posix()
    existing = next((p for p in ledger['photos'] if p['file'] == relative), None)
    if existing and not args.replace:
        parser.error('record exists; use --replace explicitly')
    record = {'file': relative, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
              'osmWayIds': args.osm_way, 'position': None if args.latitude is None else {'latitude': args.latitude, 'longitude': args.longitude},
              'facade': args.facade, 'cameraBearingDeg': args.camera_bearing,
              'date': args.date, 'author': args.author, 'permission': args.permission,
              'use': 'local visual reference; source pixels are not shipped',
              'confidence': 'unreviewed'}
    if existing:
        ledger['photos'].remove(existing)
    ledger['photos'].append(record)
    MANIFEST.write_text(json.dumps(ledger, indent=2, ensure_ascii=False) + '\n')
    print(f"REGISTERED {relative}; permission={args.permission}")


if __name__ == '__main__':
    main()
