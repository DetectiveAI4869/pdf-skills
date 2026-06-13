#!/bin/bash
# setup.sh - Downloads pdf.js library files required by the extension
# Run this once before loading the extension into Chrome.

set -e

LIB_DIR="$(dirname "$0")/lib"
mkdir -p "$LIB_DIR"

PDFJS_VERSION="3.11.174"
BASE_URL="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}"

echo "⬇️  Downloading pdf.js v${PDFJS_VERSION}..."

curl -fL "${BASE_URL}/pdf.min.js"        -o "${LIB_DIR}/pdf.min.js"
curl -fL "${BASE_URL}/pdf.worker.min.js" -o "${LIB_DIR}/pdf.worker.min.js"

echo ""
echo "✅ Done! Files saved to ./lib/"
ls -lh "$LIB_DIR"
echo ""
echo "👉 Now load the extension in Chrome:"
echo "   1. Open chrome://extensions"
echo "   2. Enable 'Developer mode'"
echo "   3. Click 'Load unpacked' and select this folder"
