#!/bin/bash
# Kill any process using port 3000 or 3001

echo "Clearing ports 3000 and 3001..."

# Kill port 3000 (try multiple times)
for i in {1..3}; do
  PORT_3000=$(lsof -ti:3000 2>/dev/null)
  if [ ! -z "$PORT_3000" ]; then
    echo "Killing process on port 3000 (PID: $PORT_3000) - attempt $i"
    kill -9 $PORT_3000 2>/dev/null || true
    sleep 0.5
  else
    break
  fi
done

# Kill port 3001 (try multiple times)
for i in {1..3}; do
  PORT_3001=$(lsof -ti:3001 2>/dev/null)
  if [ ! -z "$PORT_3001" ]; then
    echo "Killing process on port 3001 (PID: $PORT_3001) - attempt $i"
    kill -9 $PORT_3001 2>/dev/null || true
    sleep 0.5
  else
    break
  fi
done

# Final check
FINAL_3000=$(lsof -ti:3000 2>/dev/null)
FINAL_3001=$(lsof -ti:3001 2>/dev/null)

if [ -z "$FINAL_3000" ] && [ -z "$FINAL_3001" ]; then
  echo "✅ Ports cleared successfully"
else
  echo "⚠️  Some ports may still be in use:"
  [ ! -z "$FINAL_3000" ] && echo "   Port 3000: PID $FINAL_3000"
  [ ! -z "$FINAL_3001" ] && echo "   Port 3001: PID $FINAL_3001"
fi

sleep 1

