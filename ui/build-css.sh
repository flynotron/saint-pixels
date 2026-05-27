#!/bin/bash
# Run this once (and whenever you change styles.css, index.html, or app.js)
# to compile Tailwind into public/styles.css

npx @tailwindcss/cli -i styles.source.css -o public/styles.css --content "index.html,app.js"
echo "Done — public/styles.css is ready."

# 1. Install Tailwind CLI (one time)
# npm install -D tailwindcss @tailwindcss/cli

# 2. Compile CSS (re-run whenever you edit styles.css, index.html, or app.js)
# npx @tailwindcss/cli -i ui/styles.source.css -o public/styles.css --content "index.html,app.js"
