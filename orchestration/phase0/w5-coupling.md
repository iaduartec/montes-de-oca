# TASK PACKET W5 — Auditoría de acoplamiento a Shenzhen (mapa motor vs contenido)

## Estándares del proyecto (auto-resueltos)
- El repo de referencia `/home/kiri_/projects/montes-de-oca` es **READ-ONLY**. No lo modifiques.
- Build exitoso NO es validación. Citá `archivo:línea` en cada afirmación. Si no se sabe, `UNKNOWN`. NUNCA inventes.
- Escribí la salida en **español** técnico.
- Convenciones de coordenadas y procedencia de assets son críticas: la investigación temprana usó EPSG:32649 y el juego embarcado usa un origen local — nunca los mezcles.
- Si descubrís algo importante, guardalo en engram con `mem_save` y `project: "montes-de-oca"` antes de terminar.

## Contexto
- El repo de referencia es **GTA_SZ / 深城纪**, juego de ciudad en navegador (Babylon.js + TS + Vite) ambientado en **Shenzhen, China**. Es un Shenzhen *comprimido y curado* (no un gemelo 1:1) con hitos, distritos, contenido narrativo, cartelería china y toda una capa de vida urbana.
- Juego nuevo: **"Montes de Oca: Offroad Stories"** — rural off-road en **Villafranca Montes de Oca, Burgos, España**. Población ~250. Camino de Santiago, corredor N-120 / A-12, sierras de Montes de Oca, bosques, campos, casi sin edificios.
- Raíz del proyecto nuevo: `/home/kiri_/projects/montes-de-oca-offroad`
- Nuestra estrategia: **extraer un núcleo de motor reutilizable** y dejar atrás el contenido de Shenzhen. Tu trabajo es el mapa inverso: enumerar todo lo específico de Shenzhen, para saber exactamente qué cortar y qué debe volverse parámetro/data-driven.

## GOAL
Escribir `docs/audit/05-acoplamiento-shenzhen.md`: un inventario exhaustivo y con evidencia del acoplamiento a Shenzhen, más una propuesta de corte **núcleo de motor vs capa de contenido**.

## FILES / ESTRATEGIA DE BÚSQUEDA
NO leas 140 archivos. Usá `grep`/`rg` desde la raíz del repo de referencia para encontrar acoplamientos, y leé sólo los pocos archivos que importen. En particular:
- `grep -rn` para: `114.025`, `22.536`, `102850`, `111320`, `0.60`, `EPSG`, `32649`
- `grep -rln` para: `shenzhen`, `深圳`, `Shenzhen`, `深城纪`, `guangdong`, `china`
- Leé: src/city-types.ts, src/landmark-details.ts, src/city-story-content.ts, src/city-story-contract.ts, src/city-map.ts (skim buscando lugares hard-codeados), y módulos de landmark/emergency si existen
- Listá: data/landmarks/, data/locations/, data/materials/, config/, public/city/ (sólo nombres + tamaños, usá `ls -la`)
- Revisá las secciones de licencias/attribution y "asset split" del README.md

## PREGUNTAS (con evidencia `archivo:línea`)
1. **Acoplamiento de coordenadas/proyección**: dónde viven exactamente el origen local y los factores de escala (102850, 111320, 0.60). Listá CADA ocurrencia con `archivo:línea`. ¿Está centralizado en un módulo o disperso?
2. **Contenido con nombre**, agrupado y enumerado (no hace falta cada ítem — enumerá por *categoría* con conteos y 2-3 ejemplos): hitos/landmarks, distritos, nombres de calles, topónimos, historia/diálogo, cartelería, contenido de personajes, sistemas de carrera/vida, audio.
3. **Acoplamiento de idioma chino**: dónde hay texto chino incrustado en código o datos (strings de UI, cartelería, nombres). ¿Cómo se manejan los strings — hard-codeados o data-driven?
4. **Inventario de archivos de datos**: cada archivo bajo `public/city/` y `data/`, con tamaño, su script productor si es identificable, y un veredicto de una línea ("específico de Shenzhen" / "esquema genérico" / "tooling genérico").
5. **Split propuesto**: tabla de dos columnas — `NÚCLEO DE MOTOR (reutilizar)` vs `CONTENIDO SHENZHEN (descartar)`, listando módulo/archivo con granularidad de archivo individual donde sea posible. Sé decisivo; marcá los genuinamente ambiguos con `?`.
6. **Contrato de datos mínimo**: si el contenido se vuelve un "data pack" intercambiable, ¿cuál es el esquema JSON mínimo que el motor debe poder consumir para renderizar un mundo? Derivalo de lo que el motor realmente lee (no de lo que Shenzhen casualmente provee).
7. ¿Qué en el repo asume que **Shenzhen es una ciudad densa** (p. ej. supuestos sobre cantidad de edificios, densidad del grafo vial, población)? Marcá esto como trampas silenciosas para un mapa rural.

## CONSTRAINTS
- NO toques `/home/kiri_/projects/montes-de-oca`. Sólo leer y grepear.
- Escribí ÚNICAMENTE `docs/audit/05-acoplamiento-shenzhen.md`. Ningún otro archivo.
- Denso y escaneable: listas agrupadas, tablas, conteos. Sin relleno en prosa.

## DELIVERABLE
`/home/kiri_/projects/montes-de-oca-offroad/docs/audit/05-acoplamiento-shenzhen.md`, cerrando con `## Confianza`.

## VALIDATION
- El archivo existe y no está vacío.
- La sección de acoplamiento de coordenadas lista cada ocurrencia con ancla `archivo:línea` (verificá que el conteo esté completo con `grep -c`).
- La tabla MOTOR vs CONTENIDO cubre los archivos que efectivamente inspeccionaste, y declara cuántos archivos de `src/` NO inspeccionaste.
- En tu respuesta final: categorías de acoplamiento encontradas, tamaño aproximado del núcleo de motor propuesto (cantidad de archivos), la lista de trampas rurales, y confianza.
