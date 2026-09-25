# Repository Guidelines

## Project Structure & Modules

- `src/` contains the browser game in strict TypeScript, grouped by gameplay, player, vehicle, terrain, and environment.
- `scripts/` contains builders, data utilities, capture tools, and validators, organized by domain (`terrain/`, `roads/`, `gameplay/`, `environment/`, `geo/`, `vehicle/`, `player/`).
- `data/` stores source and raw geographic inputs with query files and manifests. `public/` holds processed assets loaded by the game, including terrain, roads, vegetation, and village data.
- `docs/` holds project notes and audits. Generated source or assets should be changed through their builder scripts where available; check generated-file headers first.

## Build, Test, and Development

- `npm ci` installs the locked dependencies.
- `npm run dev` starts the Vite server at `http://127.0.0.1:5173`.
- `npm run build` runs strict TypeScript checks and creates the production bundle in `dist/`.
- `npm test` runs type checking and the repository's terrain, road, mission, atmosphere, and village validators.
- For focused checks, use `npm run test:terrain`, `npm run test:roads`, or `npm run test:mission`. Run `npm run preview` to serve a built bundle locally.

## Code Style & Naming

Use two spaces, single quotes, and semicolons in TypeScript, matching the existing files. Keep TypeScript strict: avoid unused values, unchecked assumptions, and implicit returns. Use descriptive kebab-case filenames (for example, `road-draping.ts`) and camelCase for variables and functions. Python scripts use standard four-space indentation. No formatter or linter is configured; keep changes consistent with nearby code.

## Testing

There is no separate unit-test framework. Validation is provided by `npm test` and focused scripts in `scripts/`; add or update a domain validator when changing generated data or gameplay rules. For visual changes, run the app and include a screenshot or concise visual verification in the pull request.

## Commits and Pull Requests

Recent commits use conventional prefixes with a scope, such as `feat(gameplay): ...`, `fix(environment): ...`, and `test(terrain): ...`. Keep each commit focused. Pull requests should describe behavior and affected data, list validation commands and results, link related issues when available, and include screenshots for visual changes.

## Data and Configuration

Do not commit secrets; `.env` is ignored. Preserve source manifests and attribution when updating OSM or terrain-derived assets. Regenerate derived files with the relevant script and run its `--check` or validator mode before submitting.
