#!/usr/bin/env bash
# Double-click in Finder to start J.A.R.V.I.S. in a Terminal window. Ctrl-C or close the window to stop.
"$(dirname "$0")/scripts/demo.sh" "$@"
status=$?
if (( status != 0 )); then
  echo; read -rp "Jarvis didn't start (see the message above). Press Enter to close… "
fi
exit $status
