#!/usr/bin/env bash
# Build the .vsix and (re)install it into the local VS Code / vscode-server.
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(python3 -c "import json; print(json.load(open('extension/package.json'))['version'])")
VSIX="scm-diff-stats-$VERSION.vsix"

python3 - "$VSIX" <<'EOF'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    z.write('extension.vsixmanifest')
    z.write('[Content_Types].xml')
    z.write('extension/package.json')
    z.write('extension/extension.js')
print(f'built {sys.argv[1]}')
EOF

# Prefer the remote-cli inside vscode-server (WSL/remote), fall back to plain `code`
CODE=$(ls -t "$HOME"/.vscode-server/bin/*/bin/remote-cli/code 2>/dev/null | head -1 || true)
CODE=${CODE:-$(command -v code || true)}
if [ -n "$CODE" ]; then
  "$CODE" --install-extension "$VSIX"
  echo "installed — reload the VS Code window to pick it up"
else
  echo "code CLI not found; install manually: code --install-extension $VSIX"
fi
