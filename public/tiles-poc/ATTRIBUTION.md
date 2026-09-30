# Prototipo de 3D Tiles de Villafranca

Contenido experimental creado por `scripts/terrain/build_3d_tiles_poc.py` a
partir de fuentes que ya utiliza el juego. No participa en la escena jugable.

- Terreno: Modelo Digital del Terreno MDT05, © Instituto Geográfico Nacional /
  CNIG, CC BY 4.0. Fuente y ventana en `public/terrain/ATTRIBUTION.md`.
- Imagen: obra derivada de la ortofoto PNOA de septiembre de 2023, © IGN/CNIG,
  CC BY 4.0. El recorte se conserva como `orthophoto.jpg` fuera del GLTF.
- Edificios: huellas de OpenStreetMap, © OpenStreetMap contributors, ODbL 1.0.
  Las huellas se extruyen con las alturas estimadas del juego.
- Resolución: una tesela de 3 × 3 km; malla del terreno remuestreada a 10 m y
  ortofoto a unos 2 m por píxel para mantener pequeño el artefacto de prueba.

Para regenerar el experimento: `python3 scripts/terrain/build_3d_tiles_poc.py`.
