# @medrush/config

Shared tooling presets for the MedRush monorepo: tsconfig bases (`tsconfig/{base,library,node}.json`), ESLint 9 flat preset (`eslint/index.js`), Prettier config (`prettier/index.json`), and the §20.2 Tailwind design-token preset (`tailwind/preset.js`).

Note: this package deliberately has **no `exports` field** so the JSON tsconfig bases remain importable via `"extends": "@medrush/config/tsconfig/library.json"` (see `docs/phase-briefs/phase-0-conventions.md`).
