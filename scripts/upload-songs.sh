#!/bin/bash
# Upload songs to lofi-radio server via HTTP API
# Usage: ./scripts/upload-songs.sh [URL] [API_KEY] [SONGS_DIR]

set -e

# Configuration
SERVER_URL="${1:-http://localhost:5634}"
API_KEY="${2:-${RADIO_API_KEY}}"
SONGS_DIR="${3:-./songs}"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "========================================="
echo "  Lofi Radio - Bulk Song Upload"
echo "========================================="
echo ""

# Validate inputs
if [ -z "$API_KEY" ]; then
  echo -e "${RED}❌ Error: API key not provided${NC}"
  echo ""
  echo "Usage:"
  echo "  $0 <SERVER_URL> <API_KEY> [SONGS_DIR]"
  echo ""
  echo "Or set RADIO_API_KEY environment variable:"
  echo "  export RADIO_API_KEY=your-api-key-here"
  echo "  $0"
  exit 1
fi

if [ ! -d "$SONGS_DIR" ]; then
  echo -e "${RED}❌ Error: Songs directory not found: $SONGS_DIR${NC}"
  exit 1
fi

# Find MP3 files
MP3_FILES=($(find "$SONGS_DIR" -name "*.mp3" -type f))
TOTAL=${#MP3_FILES[@]}

if [ $TOTAL -eq 0 ]; then
  echo -e "${RED}❌ No MP3 files found in $SONGS_DIR${NC}"
  exit 1
fi

echo "Server:    $SERVER_URL"
echo "Songs dir: $SONGS_DIR"
echo "Found:     $TOTAL MP3 files"
echo ""

# Confirm
read -p "Upload all files? (y/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Cancelled."
  exit 0
fi

echo ""
echo "Starting upload..."
echo ""

# Upload statistics
UPLOADED=0
FAILED=0
START_TIME=$(date +%s)

# Upload each file
for i in "${!MP3_FILES[@]}"; do
  FILE="${MP3_FILES[$i]}"
  FILENAME=$(basename "$FILE")
  FILESIZE=$(stat -f%z "$FILE" 2>/dev/null || stat -c%s "$FILE")
  FILESIZE_MB=$(echo "scale=2; $FILESIZE / 1024 / 1024" | bc)

  printf "[%3d/%3d] Uploading: %-50s %6.2fMB ... " "$((i+1))" "$TOTAL" "$FILENAME" "$FILESIZE_MB"

  # Upload via curl
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "X-API-Key: $API_KEY" \
    -F "song=@$FILE" \
    "$SERVER_URL/admin/upload")

  if [ "$HTTP_CODE" -eq 200 ]; then
    echo -e "${GREEN}✓${NC}"
    UPLOADED=$((UPLOADED + 1))
  else
    echo -e "${RED}✗ (HTTP $HTTP_CODE)${NC}"
    FAILED=$((FAILED + 1))
  fi

  # Show progress every 10 files
  if [ $(((i + 1) % 10)) -eq 0 ]; then
    ELAPSED=$(($(date +%s) - START_TIME))
    RATE=$(echo "scale=2; (${i} + 1) / $ELAPSED" | bc)
    REMAINING=$(echo "scale=0; ($TOTAL - ${i} - 1) / $RATE" | bc 2>/dev/null || echo "?")
    echo -e "${YELLOW}  Progress: $((i+1))/$TOTAL | Elapsed: ${ELAPSED}s | ETA: ~${REMAINING}s${NC}"
    echo ""
  fi
done

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo "========================================="
echo "  Upload Complete"
echo "========================================="
echo -e "Total:    $TOTAL files"
echo -e "${GREEN}Uploaded: $UPLOADED${NC}"
if [ $FAILED -gt 0 ]; then
  echo -e "${RED}Failed:   $FAILED${NC}"
fi
echo "Time:     ${DURATION}s"
echo ""

if [ $UPLOADED -gt 0 ]; then
  echo "Playlist updated! Songs are now available on the server."
fi

exit 0
