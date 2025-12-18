#!/bin/bash

# Test script to check schedule API data
echo "=== Testing Schedule API ==="
echo ""

# Test 1: Get all schedules for Palatine
echo "1. Testing /api/schedule?station=PALATINE&terminal=OTC"
curl -s "http://localhost:8080/api/schedule?station=PALATINE&terminal=OTC" | jq '.weekday.inbound[0:10] | .[] | {departure_time, arrival_time, trip_id}' 2>/dev/null || echo "Failed or jq not installed"
echo ""

# Test 2: Get weekday schedule
echo "2. Testing /api/schedule/weekday?station=PALATINE"
curl -s "http://localhost:8080/api/schedule/weekday?station=PALATINE" | jq '.inbound[0:10] | .[] | {departure_time, arrival_time, trip_id}' 2>/dev/null || echo "Failed or jq not installed"
echo ""

# Test 3: Check what times are in the early morning
echo "3. Early morning trains (00:00 - 04:00) for Palatine weekday inbound:"
curl -s "http://localhost:8080/api/schedule/weekday?station=PALATINE" | jq '.inbound | map(select(.departure_time | startswith("00:") or startswith("01:") or startswith("02:") or startswith("03:") or startswith("04:"))) | .[0:10] | .[] | {departure_time, arrival_time, trip_id}' 2>/dev/null || echo "Failed or jq not installed"
echo ""

# Test 4: Check Schaumburg
echo "4. Testing Schaumburg weekday inbound (first 10):"
curl -s "http://localhost:8080/api/schedule/weekday?station=SCHAUMBURG" | jq '.inbound[0:10] | .[] | {departure_time, arrival_time, trip_id}' 2>/dev/null || echo "Failed or jq not installed"
echo ""

echo "=== Done ==="

