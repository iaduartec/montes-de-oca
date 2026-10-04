# Referencias fotográficas del usuario

El registro local es `assets/environment/real-structures/user-photos.json`. Guarda ruta y SHA-256, OSM IDs, posición geográfica, fachada, dirección de cámara en grados desde norte, fecha, autor y permiso. Los campos desconocidos permanecen `null`; el permiso de distribución nunca se deduce de la presencia de un archivo. Estas referencias no se copian a `public/` ni se usan como texturas.

La asociación inicial de `fotos/Iglesia_plaza.jpg` a la iglesia OSM 90614388 identifica el sujeto, sin atribuir orientación, fecha, autor ni licencia. Las ocho referencias adicionales quedan sin asociación a casas concretas. Son orientación local: las fotos aéreas apoyan contexto y silueta, no conteos de ventanas. El registro no demuestra corrección de edificios.

```bash
python3 scripts/environment/register_user_photo.py --check
python3 scripts/environment/register_user_photo.py --file fotos/Iglesia_plaza.jpg \
  --osm-way 90614388 --permission reference-only --replace
```

Para añadir datos confirmados se pueden proporcionar `--facade`, `--camera-bearing`, `--latitude`, `--longitude`, `--date` y `--author`. `--permission distribution-authorized` exige autor identificado. `--replace` es obligatorio para sobrescribir una asociación existente. El programa comprueba que los IDs pertenezcan al snapshot OSM y que la referencia permanezca dentro del repositorio. No cambia la huella, orientación ni altura de ningún edificio.

Inventario de 2026-10-04: nueve imágenes registradas. `fotos/Villafranca montes de oca (vistas aereas)/VI3E3610.jpg` no tiene cabecera JPEG/PNG válida y fue rechazado; se conserva el archivo original. EXIF de varias fotos indica 2005-08-02, pero no se ha confirmado esa fecha y no se registra como fecha verificada.
