#!/usr/bin/env bash
# ============================================================
# Stream Deck — webOS IPK Builder  (Linux / macOS)
# ============================================================
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "============================================"
echo " Stream Deck — webOS IPK Builder"
echo "============================================"
echo ""

# ── Step 1: Generate icons ───────────────────────────────────────────────────
echo "[1/3] Generating PNG icons..."
if command -v node &>/dev/null; then
    node generate_icons.js . && echo "      icon.png and largeIcon.png created."
else
    echo "      Node.js not found, using Python fallback..."
    python3 - <<'EOF'
import base64, os
# Minimal 80x80 placeholder PNG (dark background)
data = base64.b64decode(
  "iVBORw0KGgoAAAANSUhEUgAAAFAAAACQCAYAAAC/tRS0AAAABmJLR0QA/wD/AP+g"
  "vaeTAAAAC0lEQVR42mNk+A8AAQQBAScAAAAAElFTkSuQmCC"
)
for name in ('icon.png','largeIcon.png'):
    with open(name,'wb') as f:
        f.write(data)
print("      Placeholder icons created.")
EOF
fi

# ── Step 2: HLS.js ───────────────────────────────────────────────────────────
echo ""
echo "[2/3] Checking for hls.min.js..."
if [ -f hls.min.js ]; then
    echo "      hls.min.js already present."
elif command -v curl &>/dev/null; then
    echo "      Downloading HLS.js 1.6.16 (ES5 build)..."
    curl -L -o hls.min.js "https://cdn.jsdelivr.net/npm/hls.js@1.6.16/dist/hls.min.js" \
      && echo "      hls.min.js downloaded." \
      || { echo "      Download failed — creating CDN stub."; cat >hls.min.js <<'JS'
/* HLS.js CDN fallback */
(function(){var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/hls.js@1.6.16/dist/hls.min.js';document.head.appendChild(s);})();
JS
}
else
    cat >hls.min.js <<'JS'
/* HLS.js CDN fallback */
(function(){var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/hls.js@1.6.16/dist/hls.min.js';document.head.appendChild(s);})();
JS
    echo "      Created CDN stub (curl not available)."
fi

# ── Step 3: Build IPK ────────────────────────────────────────────────────────
echo ""
echo "[3/3] Building IPK package..."

mkdir -p build

if command -v ares-package &>/dev/null; then
    echo "      Using ares-package (webOS SDK)..."
    ares-package . -o build
elif command -v python3 &>/dev/null; then
    echo "      Using Python 3 IPK builder..."
    python3 create_ipk.py . build
elif command -v python &>/dev/null; then
    echo "      Using Python IPK builder..."
    python create_ipk.py . build
else
    echo ""
    echo " ERROR: No packaging tool found."
    echo " Install one of:"
    echo "   npm install -g @webos-tools/cli"
    echo "   apt install python3  /  brew install python3"
    exit 1
fi

echo ""
echo "============================================"
echo " Build complete!"
echo "============================================"
echo ""
echo " INSTALLATION:"
echo " 1. Enable Developer Mode on LG TV:"
echo "      Settings > General > TV Management > Developer Mode"
echo " 2. Note the TV IP address shown on the Developer Mode screen."
echo " 3. Install via ares-cli:"
echo "      ares-setup-device"
echo "      ares-install --device tv build/*.ipk"
echo " 4. Or sideload via the LG Developer Mode app (iOS/Android)."
echo ""
