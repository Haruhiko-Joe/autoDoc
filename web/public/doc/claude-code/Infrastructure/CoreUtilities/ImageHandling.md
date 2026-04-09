# Image Handling

## Overview & Responsibilities

The Image Handling module is a collection of utilities within the **Infrastructure → CoreUtilities** layer that manages the complete image lifecycle in Claude Code. It covers six concerns:

1. **Clipboard image paste detection and extraction** (`imagePaste.ts`) — reads images from the OS clipboard on macOS, Linux, and Windows
2. **Image resizing and compression** (`imageResizer.ts`) — enforces API dimension and size limits using the Sharp image processing library
3. **In-memory image store** (`imageStore.ts`) — persists conversation image attachments to disk, scoped by session
4. **Image format validation** (`imageValidation.ts`) — validates image sizes at the API boundary before sending messages
5. **ANSI terminal output to PNG** (`ansiToPng.ts`) — renders colored terminal text to a PNG using a bundled bitmap font, no external dependencies
6. **ANSI to SVG rendering** (`ansiToSvg.ts`) — converts ANSI-escaped text to SVG with color and style support

These utilities serve the TerminalUI (clipboard paste handling, screenshot capture), the QueryEngine (image blocks in messages), and tool implementations (FileReadTool image processing).

## Key Processes

### Clipboard Image Paste Flow

When a user pastes an image, the system follows a two-tier strategy with a fast native path and a slower shell fallback:

1. **`hasImageInClipboard()`** checks whether the clipboard contains an image. On macOS with the native module available, it calls `NSPasteboard` directly (~0.03ms). Otherwise it falls back to `osascript` (`src/utils/imagePaste.ts:96-122`).

2. **`getImageFromClipboard()`** extracts the actual image data (`src/utils/imagePaste.ts:124-242`):
   - **Native path** (macOS only, feature-gated via `NATIVE_CLIPBOARD_IMAGE` + GrowthBook `tengu_collage_kaleidoscope`): Reads PNG bytes in-process via `image-processor-napi`, passing `IMAGE_MAX_WIDTH` and `IMAGE_MAX_HEIGHT` (both 2000px) to cap dimensions. If the raw buffer still exceeds `IMAGE_TARGET_RAW_SIZE` (3.75MB), it runs through `maybeResizeAndDownsampleImageBuffer`. Performance: ~5ms cold, sub-ms warm.
   - **Shell fallback**: Uses platform-specific clipboard commands — `osascript` on macOS, `xclip`/`wl-paste` on Linux, `PowerShell` on Windows. Saves to a temp file, reads it back, converts BMP to PNG if needed (for WSL2 compatibility), then resizes.

3. **`tryReadImageFromPath()`** handles drag-and-drop file paths. It normalizes shell escapes and quotes, reads the file from disk (or matches the filename against the clipboard path for VSCode Terminal compatibility), then resizes (`src/utils/imagePaste.ts:351-416`).

### Image Resize and Compression Pipeline

`maybeResizeAndDownsampleImageBuffer()` is the core resizing function (`src/utils/imageResizer.ts:169-433`). It enforces two constraints: **dimension limits** (2000×2000px) and **size limits** (3.75MB raw / 5MB base64).

The strategy is progressive:

1. If the image already fits both dimension and size limits, return as-is
2. If dimensions are OK but size exceeds the limit:
   - For PNG: try palette-based compression (level 9) first to preserve transparency
   - Try JPEG at progressively lower quality (80 → 60 → 40 → 20)
3. If dimensions exceed limits, resize maintaining aspect ratio, then repeat compression if still too large
4. Last resort: resize to max 1000px wide with JPEG quality 20

On failure (e.g., Sharp unavailable), the function falls back gracefully:
- If the raw base64 size is under 5MB and dimensions are within limits, pass through uncompressed
- Otherwise, throw `ImageResizeError` with a user-friendly message

**`compressImageBuffer()`** (`src/utils/imageResizer.ts:498-577`) provides a separate compression pipeline used by FileReadTool. It tries four strategies in order:
1. Progressive resizing at 100% → 75% → 50% → 25% with format-specific optimizations
2. Palette PNG with 64 colors at 800×800
3. JPEG conversion at quality 50, resized to 600×600
4. Ultra-compressed JPEG at quality 20, resized to 400×400

### Image Format Detection

`detectImageFormatFromBuffer()` and `detectImageFormatFromBase64()` (`src/utils/imageResizer.ts:769-829`) identify image formats via magic bytes:

| Format | Magic Bytes |
|--------|-------------|
| PNG    | `89 50 4E 47` |
| JPEG   | `FF D8 FF` |
| GIF    | `47 49 46` (GIF) |
| WebP   | `52 49 46 46 ... 57 45 42 50` (RIFF...WEBP) |

Defaults to `image/png` for unrecognized formats.

### Image Storage

`imageStore.ts` manages a session-scoped disk cache under `~/.claude/image-cache/<sessionId>/` (`src/utils/imageStore.ts:1-167`):

- **`cacheImagePath()`**: Synchronously registers the path in an in-memory `Map<number, string>` (no I/O) for fast lookups
- **`storeImage()`**: Writes base64-decoded image data to disk with `0o600` permissions, using `datasync()` for durability
- **`storeImages()`**: Batch variant that processes all images in a `pastedContents` record
- **`getStoredImagePath()`**: Retrieves the cached file path by image ID
- **`cleanupOldImageCaches()`**: On startup, removes cache directories from previous sessions, and the parent directory if empty

The in-memory map caps at `MAX_STORED_IMAGE_PATHS` (200), evicting oldest entries when full.

### API-Boundary Validation

`validateImagesForAPI()` (`src/utils/imageValidation.ts:65-104`) is a safety net that scans all user messages for base64 image blocks exceeding `API_IMAGE_MAX_BASE64_SIZE` (5MB). It throws `ImageSizeError` listing all oversized images with their indices and sizes. This catches anything that slipped through upstream resizing.

### ANSI to PNG Rendering

`ansiToPng()` (`src/utils/ansiToPng.ts:91-153`) renders terminal output as a PNG image for screenshots. It replaces the previous SVG → resvg-wasm pipeline for significantly better performance (~5–15ms vs ~224ms) and zero external dependencies.

The rendering pipeline:
1. Parse ANSI escape sequences via `parseAnsi()` (shared with `ansiToSvg.ts`) into a grid of `(text, color, bold)` spans
2. Calculate canvas dimensions from column count × glyph size (24×48px per cell) + padding
3. Fill an RGBA buffer with the background color and apply rounded corners
4. Blit each character from a bundled Fira Code bitmap font (base64-encoded, decoded at module load)
5. Handle special characters: shade block characters (░▒▓█) are alpha-blended; unknown codepoints render as a dotted box
6. Bold is synthesized by boosting glyph alpha by 1.4×
7. Encode the RGBA buffer as PNG using a minimal built-in encoder (IHDR + deflate-compressed IDAT + IEND)

### ANSI to SVG Rendering

`ansiToSvg()` (`src/utils/ansiToSvg.ts:207-272`) converts ANSI text to SVG using `<text>` elements with `<tspan>` children for colored segments. It supports:
- Basic ANSI colors (30–37, 90–97)
- 256-color mode (`38;5;n`) with full palette: 16 standard, 216-color cube, 24 grayscale
- 24-bit true color (`38;2;r;g;b`)
- Bold text via CSS class

## Function Signatures

### imagePaste.ts

#### `hasImageInClipboard(): Promise<boolean>`
Checks if the clipboard contains an image. macOS only (returns `false` on other platforms).

#### `getImageFromClipboard(): Promise<ImageWithDimensions | null>`
Extracts clipboard image data as base64 with media type and dimension info. Returns `null` if no image found.

#### `tryReadImageFromPath(text: string): Promise<(ImageWithDimensions & { path: string }) | null>`
Reads an image from a file path (absolute or clipboard-relative). Returns `null` if not a valid image path.

#### `isImageFilePath(text: string): boolean`
Tests whether a string looks like an image file path (matches `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`).

#### `asImageFilePath(text: string): string | null`
Cleans and normalizes an image file path (strips quotes and shell escapes). Returns `null` if not an image path.

### imageResizer.ts

#### `maybeResizeAndDownsampleImageBuffer(imageBuffer: Buffer, originalSize: number, ext: string): Promise<ResizeResult>`
Resizes and compresses an image buffer to fit within API limits. Throws `ImageResizeError` on empty input or unrecoverable failures.

#### `maybeResizeAndDownsampleImageBlock(imageBlock: ImageBlockParam): Promise<ImageBlockWithDimensions>`
Wrapper that takes an Anthropic SDK `ImageBlockParam` and returns a resized version with dimension metadata.

#### `compressImageBuffer(imageBuffer: Buffer, maxBytes?: number, originalMediaType?: string): Promise<CompressedImageResult>`
Compresses an image to fit within a byte budget (default: 3.75MB). Uses progressive strategies.

#### `compressImageBufferWithTokenLimit(imageBuffer: Buffer, maxTokens: number, originalMediaType?: string): Promise<CompressedImageResult>`
Compresses to fit a token budget. Converts tokens → bytes via `maxBytes = (maxTokens / 0.125) * 0.75`.

#### `detectImageFormatFromBuffer(buffer: Buffer): ImageMediaType`
Detects image format from magic bytes. Returns one of `image/png`, `image/jpeg`, `image/gif`, `image/webp`.

#### `createImageMetadataText(dims: ImageDimensions, sourcePath?: string): string | null`
Generates a human-readable metadata string like `[Image: source: foo.png, original 4000x3000, displayed at 2000x1500. Multiply coordinates by 2.00 to map to original image.]`.

### imageStore.ts

#### `storeImage(content: PastedContent): Promise<string | null>`
Writes an image to the session cache directory. Returns the file path or `null` on failure.

#### `getStoredImagePath(imageId: number): string | null`
Retrieves a cached image file path by ID.

#### `cleanupOldImageCaches(): Promise<void>`
Removes image cache directories from previous sessions.

### imageValidation.ts

#### `validateImagesForAPI(messages: unknown[]): void`
Scans messages for oversized base64 images. Throws `ImageSizeError` if any exceed 5MB.

### ansiToPng.ts

#### `ansiToPng(ansiText: string, options?: AnsiToPngOptions): Buffer`
Renders ANSI text to a PNG buffer. Options: `scale` (integer zoom, default 1), `paddingX`/`paddingY` (default 48px), `borderRadius` (default 16px), `background` (default dark gray).

### ansiToSvg.ts

#### `parseAnsi(text: string): ParsedLine[]`
Parses ANSI escape sequences into structured spans with color and bold info. Used by both SVG and PNG renderers.

#### `ansiToSvg(ansiText: string, options?: AnsiToSvgOptions): string`
Converts ANSI text to an SVG string. Options: `fontFamily`, `fontSize`, `lineHeight`, `paddingX`, `paddingY`, `backgroundColor`, `borderRadius`.

## Interface/Type Definitions

### `ImageWithDimensions`
```typescript
type ImageWithDimensions = {
  base64: string
  mediaType: string
  dimensions?: ImageDimensions
}
```

### `ImageDimensions`
```typescript
type ImageDimensions = {
  originalWidth?: number
  originalHeight?: number
  displayWidth?: number
  displayHeight?: number
}
```

### `ResizeResult`
```typescript
interface ResizeResult {
  buffer: Buffer
  mediaType: string
  dimensions?: ImageDimensions
}
```

### `AnsiToPngOptions`
```typescript
type AnsiToPngOptions = {
  scale?: number        // Integer zoom factor (default 1)
  paddingX?: number     // Horizontal padding in pixels (default 48)
  paddingY?: number     // Vertical padding in pixels (default 48)
  borderRadius?: number // Corner radius in pixels (default 16)
  background?: AnsiColor
}
```

## Configuration & Defaults

| Constant | Value | Source |
|----------|-------|--------|
| `IMAGE_MAX_WIDTH` | 2000 px | `src/constants/apiLimits.ts` |
| `IMAGE_MAX_HEIGHT` | 2000 px | `src/constants/apiLimits.ts` |
| `API_IMAGE_MAX_BASE64_SIZE` | 5 MB | `src/constants/apiLimits.ts` |
| `IMAGE_TARGET_RAW_SIZE` | 3.75 MB (5MB × 3/4) | `src/constants/apiLimits.ts` |
| `PASTE_THRESHOLD` | 800 characters | `src/utils/imagePaste.ts` |
| `MAX_STORED_IMAGE_PATHS` | 200 | `src/utils/imageStore.ts` |
| `CLAUDE_CODE_TMPDIR` | env var | Overrides temp directory for clipboard image files |

Feature gate `tengu_collage_kaleidoscope` (default: on) acts as a kill switch for the native clipboard reader. When disabled, falls back to `osascript`.

## Edge Cases & Caveats

- **BMP conversion**: Windows/WSL2 copies images as BMP by default. Both `getImageFromClipboard()` and `tryReadImageFromPath()` detect BMP magic bytes (`0x42 0x4D`) and convert to PNG via Sharp before processing.
- **Sharp instance reuse bug**: The native `image-processor-napi` module doesn't properly apply format conversions when reusing a Sharp instance after `toBuffer()`. The code always creates fresh `sharp(imageBuffer)` instances for each operation (`src/utils/imageResizer.ts:288-291`).
- **VSCode Terminal path quirk**: VSCode Terminal pastes only the filename (not the full path) when using Cmd+V. `tryReadImageFromPath()` handles this by matching against the clipboard's full path (`src/utils/imagePaste.ts:371-374`).
- **Shell escape handling**: Dragged file paths may contain backslash escapes. `stripBackslashEscapes()` uses a random salt placeholder to safely handle double-backslashes vs. single escape backslashes, but only on macOS/Linux — Windows backslashes are preserved.
- **Native clipboard returns null authoritatively**: A `null` from the native `readClipboardImage()` means the clipboard definitely has no image. Only exceptions cause fallthrough to osascript.
- **Error analytics**: Image resize/compress failures are classified into 8 error types (module load, processing, pixel limit, memory, timeout, vips, permission, unknown) and logged via `logEvent` with hashed error messages for privacy.
- **PNG dimension check in fallback**: When Sharp fails and the raw image is under 5MB base64, the code still checks PNG header bytes (offset 16–24) for oversized dimensions before allowing passthrough (`src/utils/imageResizer.ts:401-411`).
- **Image store eviction**: The in-memory path cache uses FIFO eviction — oldest entries (by insertion order) are removed when the 200-entry cap is reached.