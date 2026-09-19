# Diagrams

`how-it-works.svg` — the CiviCon loop on one 16:9 slide (1920×1080).
`how-it-works.png` — the same, rendered, for decks that won't take SVG.

Keynote and PowerPoint import the SVG and keep it sharp at any size; Google
Slides does not, so use the PNG there. Edit the SVG in any text editor or in
Figma — the labels are real text, not outlines.

Re-render the PNG after editing:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --window-size=1920,1080 \
  --screenshot=docs/diagrams/how-it-works.png \
  "file://$PWD/docs/diagrams/how-it-works.svg"
```
