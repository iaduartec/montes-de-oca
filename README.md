# Montes de Oca Offroad

Videojuego 3D off-road ambientado en Villafranca Montes de Oca (Burgos). El objetivo es construir una experiencia jugable basada en el terreno y los elementos reales de la zona.

## Stack y mundo

- Babylon.js 8, TypeScript y Vite.
- Datos geográficos de MDT/IGN, ortofoto PNOA y OpenStreetMap (OSM), integrados en EPSG:25830.
- Sistemas existentes: terreno, carreteras y pistas, pueblo, vegetación, agua, vehículos, personajes y NPC, minimapa y misión.

## Empezar

```bash
npm install
npm run dev
```

`npm run build` compila y genera la versión de producción. `npm test` ejecuta las comprobaciones del proyecto.

## Estructura

- `src/`: runtime y sistemas del juego.
- `public/`: datos y recursos servidos por Vite.
- `data/`: datos geográficos y manifiestos de origen.
- `assets/`: recursos fuente.
- `scripts/`: construcción, validación y utilidades.
- `docs/`: documentación del proyecto.

## Agentes y objetivo

`AGENTS.md` contiene las reglas de desarrollo; `.agents/skills/` reúne las guías especializadas; `OBJECTIVE.md` describe el objetivo operativo del proyecto.

## Fuentes y licencias

Los manifiestos de `data/**/raw/` registran las fuentes y licencias de los datos. Los avisos `public/**/ATTRIBUTION.md` contienen atribuciones por capa: los datos IGN/PNOA indican CC BY 4.0 y los datos OSM, ODbL. Los recursos de `assets/` pueden tener licencias propias; consulta sus archivos de licencia antes de reutilizarlos. Estas condiciones se aplican por recurso y no implican una licencia única para todo el contenido del juego.

## Estado

Proyecto en desarrollo con sistemas de mundo, vehículos, personajes, minimapa y una primera misión ya implementados.
