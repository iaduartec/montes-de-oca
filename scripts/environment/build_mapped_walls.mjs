import fs from 'node:fs';
import assert from 'node:assert/strict';
import { wgs84ToWorld } from '../../src/config.ts';
const raw=JSON.parse(fs.readFileSync('data/village/raw/osm_mapped_walls.json'));
const config=JSON.parse(fs.readFileSync('public/terrain/config.json'));
const walls=raw.elements.map(way=>({id:way.id,kind:way.tags.barrier,points:way.geometry.map(p=>wgs84ToWorld(config,p.lon,p.lat)),heightM:Number(way.tags.height)|| (way.tags.barrier==='retaining_wall'?0.65:1.2),heightSource:way.tags.height?'OSM tag':'artistic estimate; not surveyed',widthM:0.3,timestamp:way.timestamp}));
assert.ok(walls.length>0);
for(const wall of walls){assert.ok(wall.points.length>=2);assert.ok(wall.points.every(p=>p.every(Number.isFinite)));assert.ok(wall.heightM>0&&wall.heightM<10);}
const output=JSON.stringify({schemaVersion:1,source:raw.source,fetchedAt:raw.fetched_at_utc,license:raw.license,geometry:'OSM surveyed-by-contributors alignment; untagged elevations estimated',walls},null,2)+'\n';
if(process.argv.includes('--check'))assert.equal(fs.readFileSync('public/village/mapped-walls.json','utf8'),output);else fs.writeFileSync('public/village/mapped-walls.json',output);
console.log(`mapped walls: ${walls.length} sourced ways, projection/build OK`);
