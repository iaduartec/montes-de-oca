#!/usr/bin/env python3
"""Recorta la hoja MDT02 del CNIG al bbox jugable y deja constancia verificable.

Uso:
  .venv/bin/python scripts/geo/crop_mdt02.py <hoja_origen.tif> <salida.tif>

El script imprime la ventana usada y compara píxel a píxel el recorte con la
ventana leída de la hoja original, para que la afirmación
"mdt02_bbox_2m.tif es un recorte exacto de la hoja descargada del CNIG"
sea verificable en el momento.
"""
from __future__ import annotations

import hashlib
import sys

import numpy as np
import rasterio
from rasterio.windows import from_bounds

BBOX = (471109.0, 4688771.0, 477139.0, 4694733.0)  # left, bottom, right, top (EPSG:25830)


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    src, dst = sys.argv[1], sys.argv[2]

    with rasterio.open(src) as a:
        win = from_bounds(*BBOX, transform=a.transform)
        ref = a.read(1, window=win)
        profile = a.profile.copy()
        profile.update(
            height=ref.shape[0],
            width=ref.shape[1],
            transform=a.window_transform(win),
        )
        print(f"origen      : {src}")
        print(f"  size={a.width}x{a.height} crs={a.crs} res={a.res} bounds={tuple(a.bounds)}")
        print(f"  sha256={sha256(src)}")
        print(f"ventana     : col_off={win.col_off} row_off={win.row_off} "
              f"w={win.width} h={win.height}")

    # Si la salida ya existe NO se reescribe (reascribir cambiaría el SHA-256
    # reportado en GEO_PLAN.md sin cambiar los píxeles). Sólo se verifica.
    import os

    if os.path.exists(dst):
        print(f"salida      : {dst} ya existe -> modo verificación (no se reescribe)")
    else:
        with rasterio.open(dst, "w", **profile) as b:
            b.write(ref, 1)
        print(f"salida      : {dst} (recién escrita)")

    with rasterio.open(src) as a, rasterio.open(dst) as b:
        got = b.read(1)
        win2 = from_bounds(*b.bounds, transform=a.transform)
        again = a.read(1, window=win2)
        print(f"  size={b.width}x{b.height} crs={b.crs} res={b.res} bounds={tuple(b.bounds)}")
        print(f"  sha256={sha256(dst)}")
        ok = again.shape == got.shape and np.array_equal(again, got)
        print(f"verificacion: pixeles identicos a la ventana de la hoja = {ok}")
        print(f"  min={float(np.nanmin(got)):.2f} max={float(np.nanmax(got)):.2f} "
              f"mean={float(np.nanmean(got)):.2f}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
