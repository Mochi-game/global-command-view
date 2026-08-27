#!/bin/sh
# Launcher for macOS and Linux. The .cmd files beside this one are the Windows
# equivalent; this does the same three things: find a Python new enough, run the
# server from the folder this file sits in, and say something useful if Python
# is missing rather than closing instantly.
#
# On macOS a .command file opens in Terminal when double-clicked. It has to be
# executable to do that, and a zip download does not always preserve that bit,
# so the README says to run `chmod +x` once if double-clicking does nothing.

cd "$(dirname "$0")" || exit 1

PY=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 &&
     "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3,9) else 1)' >/dev/null 2>&1
  then
    PY="$candidate"
    break
  fi
done

if [ -z "$PY" ]; then
  cat <<'MSG'

  ---------------------------------------------------------------
   This needs Python 3.9 or newer, and it is not here yet.
  ---------------------------------------------------------------

   On macOS the quickest way is Apple's own developer tools:

       xcode-select --install

   That installs python3 and takes a few minutes. Alternatively
   get it from https://www.python.org/downloads/

   On Linux, your package manager has it: python3 on Debian and
   Ubuntu, python on Arch, python3 on Fedora.

   Then close this window and open this file again.

  ---------------------------------------------------------------

MSG
  printf 'Press return to close. '
  read -r _
  exit 1
fi

echo
echo "  Global Command View"
echo "  ---------------------------------------------"
echo "  The browser opens by itself in a moment."
echo "  Press Ctrl+C, or close this window, to shut down."
echo

"$PY" "$(pwd)/server.py" --port 8820

echo
echo "  Server stopped."
sleep 2
