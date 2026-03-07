#!/bin/bash
# Extract WebP frame sequences from vid1.mp4 and vid2.mp4
# Usage: ./extract-frames.sh
# Requires: ffmpeg

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VIDS_DIR="$SCRIPT_DIR/vids"
FRAMES_DIR="$SCRIPT_DIR/frames"

# Target ~150 frames per video, output at 1920px width, quality 80
TARGET_FRAMES=150

mkdir -p "$FRAMES_DIR/vid1" "$FRAMES_DIR/vid2"

for VID in vid1 vid2; do
    echo "Processing $VID..."
    INPUT="$VIDS_DIR/$VID.mp4"
    OUTPUT_DIR="$FRAMES_DIR/$VID"

    # Get video duration
    DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$INPUT")
    echo "  Duration: ${DURATION}s"

    # Calculate FPS to get ~TARGET_FRAMES
    FPS=$(echo "$TARGET_FRAMES / $DURATION" | bc -l)
    echo "  Extracting at ${FPS} fps (~${TARGET_FRAMES} frames)"

    # Extract frames as WebP
    ffmpeg -i "$INPUT" \
        -vf "fps=$FPS,scale=1920:-2" \
        -c:v libwebp \
        -quality 80 \
        -y \
        "$OUTPUT_DIR/frame_%04d.webp"

    FRAME_COUNT=$(ls "$OUTPUT_DIR"/*.webp 2>/dev/null | wc -l | tr -d ' ')
    echo "  Extracted $FRAME_COUNT frames to $OUTPUT_DIR"
    echo ""
done

echo "Done! Update totalFrames in index.html:"
echo "  vid1: $(ls "$FRAMES_DIR/vid1"/*.webp 2>/dev/null | wc -l | tr -d ' ') frames"
echo "  vid2: $(ls "$FRAMES_DIR/vid2"/*.webp 2>/dev/null | wc -l | tr -d ' ') frames"
