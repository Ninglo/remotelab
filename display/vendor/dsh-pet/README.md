# dsh-pet selection logic

Source: PC2005-cloud/dsh-pet, commit `c6f96350d9307bd6c23bc6ea31974e76a719a8b6`.

`pickers.mjs` is `src/shared/pickers.ts` with TypeScript types erased by Node and trailing whitespace removed. `animation-config.json` contains only `animations` and `animationWeights` from the same revision of `assets/config.jsonc`. Both retain the upstream MIT license. Animation media are not included here.

The display adapter uses the original fixed-position setting, left-facing orientation and ended-driven random chain from `runtime/electron-helper/sprite.js` (`playIdle`). Interaction/event pools are not mixed into the ambient chain.
