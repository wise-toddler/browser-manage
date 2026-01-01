#!/bin/bash
# Install native messaging host for Tab Manager extension

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.tabmanager.host"
HOST_PATH="$SCRIPT_DIR/host.py"

# Make host executable
chmod +x "$HOST_PATH"

# Get extension ID (you need to update this after loading the extension)
read -p "Enter the extension ID (from chrome://extensions or edge://extensions): " EXT_ID

if [ -z "$EXT_ID" ]; then
    echo "Extension ID is required"
    exit 1
fi

# Create manifest with correct extension origin
MANIFEST=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Tab Manager Native Messaging Host",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF
)

# Chrome paths
CHROME_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

# Edge paths
EDGE_DIR="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"

install_for_browser() {
    local dir="$1"
    local name="$2"

    if [ -d "$(dirname "$dir")" ]; then
        mkdir -p "$dir"
        echo "$MANIFEST" > "$dir/$HOST_NAME.json"
        echo "Installed for $name at: $dir/$HOST_NAME.json"
    else
        echo "Skipping $name (not installed)"
    fi
}

echo ""
echo "Installing native messaging host..."
echo ""

install_for_browser "$CHROME_DIR" "Chrome"
install_for_browser "$EDGE_DIR" "Edge"

echo ""
echo "Done! The native messaging host has been registered."
echo ""
echo "Next steps:"
echo "1. Load the extension from: $SCRIPT_DIR/../extension"
echo "2. The extension should now be able to communicate with the native host"
