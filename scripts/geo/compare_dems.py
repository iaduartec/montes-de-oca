#!/usr/bin/env python3
"""Comparación cuantitativa de los tres DEM candidatos sobre el mismo bbox.

Fuentes (todas descargadas y verificadas en FASE 1, ver GEO_PLAN.md):
  - MDT02  IGN/CNIG  2 m   data/geo/raw/mdt02_bbox_2m.tif      (float32, EPSG:25830)
  - MDT05  IGN WCS   5 m   data/geo/raw/mdt05_bbox_5m.tif      (int16,   EPSG:25830)
  - GLO-30 Copernicus 30 m data/geo/raw/copernicus_glo30_N42_W004.tif (float32, EPSG:4326)

Salida: data/geo/raw/dem_comparison.json

NOTA DE PROCEDENCIA: el MDT02 es el TERRENO DE REFERENCIA de este análisis, no una
verdad absoluta. Las diferencias contra Copernicus se calculan sobre la grilla de 2 m
del MDT02; la reproyección/interpolaración a 2 m NO le da resolución de 2 m a
Copernicus, sólo permite medir cuánto detalle de 2 m no puede contener.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.warp import reproject

RAW = Path(__file__).resolve().parents[2] / "data" / "geo" / "raw"
OUT = RAW / "dem_comparison.json"

M2 = RAW / "mdt02_bbox_2m.tif"
M5 = RAW / "mdt05_bbox_5m.tif"
COP = RAW / "copernicus_glo30_N42_W004.tif"

CELL = 30.0  # metros, celda común de comparación


def block_stats(a: np.ndarray, block: int) -> tuple[np.ndarray, np.ndarray]:
    """Media y desvío estándar por bloque block x block (reducción exacta, sin interpolar)."""
    h, w = a.shape
    h2, w2 = (h // block) * block, (w // block) * block
    a = a[:h2, :w2]
    m = a.reshape(h2 // block, block, w2 // block, block)
    return m.mean(axis=(1, 3)), m.std(axis=(1, 3))


def main() -> int:
    with rasterio.open(M2) as ds:
        ref = ds.read(1).astype("float64")
        ref[ref == ds.nodata] = np.nan
        prof = ds.profile
        transform = ds.transform
        crs = ds.crs
        shape = (ds.height, ds.width)

    # MDT05 -> grilla de 2 m (interpolar; declarado)
    m5 = np.full(shape, np.nan, dtype="float64")
    with rasterio.open(M5) as ds:
        reproject(
            source=rasterio.band(ds, 1), destination=m5,
            src_transform=ds.transform, src_crs=ds.crs,
            dst_transform=transform, dst_crs=crs,
            src_nodata=ds.nodata, dst_nodata=np.nan,
            resampling=Resampling.bilinear,
        )

    # Copernicus -> grilla de 2 m (interpolar; declarado)
    cop = np.full(shape, np.nan, dtype="float64")
    with rasterio.open(COP) as ds:
        reproject(
            source=rasterio.band(ds, 1), destination=cop,
            src_transform=ds.transform, src_crs=ds.crs,
            dst_transform=transform, dst_crs=crs,
            src_nodata=ds.nodata, dst_nodata=np.nan,
            resampling=Resampling.bilinear,
        )

    def diff_stats(a: np.ndarray, b: np.ndarray) -> dict:
        m = np.isfinite(a) & np.isfinite(b)
        d = a[m] - b[m]
        ad = np.abs(d)
        return {
            "n_px": int(m.sum()),
            "bias_m": round(float(d.mean()), 3),
            "rmse_m": round(float(np.sqrt((d ** 2).mean())), 3),
            "mae_m": round(float(ad.mean()), 3),
            "p50_abs_m": round(float(np.percentile(ad, 50)), 3),
            "p95_abs_m": round(float(np.percentile(ad, 95)), 3),
            "max_abs_m": round(float(ad.max()), 3),
        }

    # Reducción exacta a 30 m: media y relieve interno por celda
    # (MDT02 tiene 2 m -> 15 px por lado en una celda de 30 m)
    mean30, std30 = block_stats(np.nan_to_num(ref, nan=np.nan), 15)
    valid = np.isfinite(mean30)

    # Copernicus nativo sobre los centros de esas celdas (nearest, sin inventar datos)
    cop30 = np.full_like(mean30, np.nan)
    with rasterio.open(COP) as ds:
        rows, cols = np.mgrid[0:mean30.shape[0], 0:mean30.shape[1]]
        # centros de celda en CRS de 2 m -> lon/lat
        xs = transform.c + (cols * 15 + 7.5) * transform.a
        ys = transform.f + (rows * 15 + 7.5) * transform.e
        from pyproj import Transformer
        tr = Transformer.from_crs(crs, ds.crs, always_xy=True)
        lons, lats = tr.transform(xs, ys)
        coords = list(zip(lons.ravel().tolist(), lats.ravel().tolist()))
        vals = np.array([v[0] for v in ds.sample(coords)], dtype="float64")
        cop30 = vals.reshape(mean30.shape)

    m = valid & np.isfinite(cop30) & (cop30 > -1e30)
    d30 = mean30[m] - cop30[m]

    out = {
        "bbox_epsg25830": [471108.9, 4688769.4, 477138.2, 4694731.8],
        "grid_2m": {"width": int(shape[1]), "height": int(shape[0]),
                    "px": int(shape[0] * shape[1]), "cell_m": 2.0, "crs": str(crs)},
        "hypsometria_mdt02_m": {
            "min": round(float(np.nanmin(ref)), 2),
            "max": round(float(np.nanmax(ref)), 2),
            "mean": round(float(np.nanmean(ref)), 2),
            "std": round(float(np.nanstd(ref)), 2),
            "p05": round(float(np.nanpercentile(ref, 5)), 1),
            "p50": round(float(np.nanpercentile(ref, 50)), 1),
            "p95": round(float(np.nanpercentile(ref, 95)), 1),
        },
        "mdt02_vs_mdt05_interp_2m": diff_stats(ref, m5),
        "mdt02_vs_copernicus_interp_2m": diff_stats(ref, cop),
        "media_30m_mdt02_vs_copernicus_nativo": {
            "n_celdas": int(m.sum()),
            "bias_m": round(float(d30.mean()), 3),
            "rmse_m": round(float(np.sqrt((d30 ** 2).mean())), 3),
            "max_abs_m": round(float(np.abs(d30).max()), 3),
        },
        "relieve_interno_por_celda_30m_desde_mdt02_2m": {
            "descripcion": "desvío estándar de las 225 muestras de 2 m dentro de cada celda de 30 m; es el relieve que una grilla de 30 m NO puede representar",
            "celdas": int(valid.sum()),
            "std_medio_m": round(float(np.nanmean(std30[valid])), 3),
            "std_p95_m": round(float(np.nanpercentile(std30[valid], 95)), 3),
            "std_max_m": round(float(np.nanmax(std30[valid])), 3),
            "std_medio_donde_relieve_alto_m": round(
                float(np.nanmean(std30[valid & (std30 > np.nanpercentile(std30[valid], 75))])), 3),
        },
        "advertencia": "Reproyectar/interpolar a 2 m NO aumenta la resolución real de la fuente; sólo permite medir el detalle que la fuente gruesa no contiene.",
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"\n=> escrito {OUT}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
