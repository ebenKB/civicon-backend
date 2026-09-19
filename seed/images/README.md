# Demo photographs

`npm run seed` attaches each issue's **before** photo from this folder. The
**after** photos are props for the live demo: a volunteer uploads one as proof,
resolves the issue, and the AI compares the pair.

| Seeded issue | Before (seeded) | After (upload in the demo) |
|---|---|---|
| Blocked drain floods the junction | `blocked-drain-before.jpg` | `blocked-drain-after.jpg` |
| Streetlight out for two weeks | `streetlight-out-before.jpg` | `streetlight-out-after.jpg` |
| Pothole damaging vehicles | `pothole-before.jpg` | `pothole-after.jpg` |
| Refuse skip overflowing | `overflowing-skip-before.jpg` | `overflowing-skip-after.jpg` |

`.jpg`, `.jpeg`, `.png` and `.webp` all work — the seed finds whichever exists.
Each image must be **5 MB or smaller**; the upload refuses anything larger.

An image that hasn't been added yet is replaced by a 1×1 placeholder, so the
seed always runs. To swap placeholders for real photos, drop the files here and
run `npm run seed -- --fresh`.

The pothole is seeded already claimed by `citizen@civicon.test`, which makes it
the natural issue for the live demo: sign in as that citizen, upload
`pothole-after.jpg`, resolve it, and confirm it as `agency@civicon.test`.
