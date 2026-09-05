#!/bin/sh
# Exits 0 only if the running Boomer server holds no non-loopback socket.
pid=$(lsof -nP -iTCP:8765 -sTCP:LISTEN -t 2>/dev/null | head -1)
[ -z "$pid" ] && { echo "boomer server not running"; exit 1; }
out=$(lsof -nP -p "$pid" -a -i 2>/dev/null | tail -n +2 | grep -v "127.0.0.1\|\[::1\]")
if [ -n "$out" ]; then echo "NON-LOOPBACK SOCKET FOUND:"; echo "$out"; exit 1; fi
echo "pid $pid: every socket is loopback"
