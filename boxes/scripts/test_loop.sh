#!/bin/bash
# Script to run boxes test in a loop to reproduce tmpfs flake
set -x

BOX=${1:-react}
BROWSER=${2:-chromium}
ITERATIONS=${3:-10}

echo "Running boxes test $BOX/$BROWSER for $ITERATIONS iterations"

for i in $(seq 1 $ITERATIONS); do
  echo ""
  echo "========================================="
  echo "ITERATION $i of $ITERATIONS"
  echo "========================================="
  echo ""

  # Run the test
  if ./run_test.sh "$BOX" "$BROWSER"; then
    echo "ITERATION $i: PASSED"
  else
    echo "ITERATION $i: FAILED"
    exit 1
  fi
done

echo ""
echo "All $ITERATIONS iterations passed!"
