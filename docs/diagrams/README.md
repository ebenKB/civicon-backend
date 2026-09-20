# Diagrams

`how-it-works.svg` — the CiviCon loop on one 16:9 slide (1920×1080): report,
safety check, claim, fix, AI check, confirm, points, with the two lanes where a
person decides instead.
`how-it-works.png` — the same, rendered, for decks that won't take SVG.

Keynote and PowerPoint import the SVG and keep it sharp at any size; Google
Slides does not, so use the PNG there. Edit the SVG in any text editor or in
Figma — the labels are real text, not outlines.

Re-render the PNG after editing:

```bash
npx sharp-cli -i docs/diagrams/how-it-works.svg \
  -o docs/diagrams/how-it-works.png --format png resize 1920 1080
```

Headless Chrome also works and was the original route, but it hangs often
enough on this machine that sharp is the one to reach for first:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --window-size=1920,1080 \
  --screenshot=docs/diagrams/how-it-works.png \
  "file://$PWD/docs/diagrams/how-it-works.svg"
```
