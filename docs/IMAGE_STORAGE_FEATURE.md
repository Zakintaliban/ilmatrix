# Image Storage & Visual Analysis Feature

## Overview

ILMATRIX now supports **intelligent image handling** that preserves visual content for later analysis. When an image contains no extractable text (or minimal text), the system automatically stores the image as base64 data, allowing the Vision API to analyze it when queried.

## Problem Solved

### Before (Issue)
1. Upload image → Extract text via Vision API
2. If no text → Error or "no text found" message
3. Original image discarded → **Cannot answer visual questions later**

### After (Solution)
1. Upload image → Try to extract text via Vision API
2. If no/minimal text → **Store image as base64** in material
3. Original image preserved → **Can answer visual questions anytime**

## How It Works

### 1. Image Upload Flow

```
Upload Image
    ↓
Vision API: Extract Text
    ↓
Has Text? ───YES──→ Store extracted text
    ↓ NO
Store as Base64
    ↓
Material File Contains:
- Image metadata
- Base64 encoded data
- Ready for visual analysis
```

### 2. Query Flow with Images

```
User Query: "What's in the triangle image?"
    ↓
Material Service: Read material file
    ↓
Groq Service: Detect embedded images
    ↓
Auto-switch to Vision Model
    ↓
Send query + image to Vision API
    ↓
Return: Visual analysis result
```

## Implementation Details

### Image Storage Format

When an image has no text, it's stored in this format:

```
===== FILE: web-symbols-020.png =====
[IMAGE: web-symbols-020.png]
Type: image/png
Size: 45KB
Encoding: base64
Note: This image has no extractable text. Image data is preserved for visual analysis.

Base64 Data:
data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...

Vision API can analyze this image when queried.
```

### Automatic Detection

Images are stored as base64 if:
- Vision API returns empty result
- Extracted text is < 50 characters
- Text contains phrases like "no text", "nothing", "empty"

### Vision API Integration

The `groqService` automatically:
1. **Extracts images** from material text using regex
2. **Detects presence** of base64 image data
3. **Switches to vision model** (`llama-4-scout-17b-16e-instruct`)
4. **Builds multimodal message** with text + images
5. **Returns visual analysis** from the model

## Usage Examples

### Example 1: Pure Visual Image

**Upload:**
```bash
curl -X POST http://localhost:8787/api/upload \
  -F "files=@triangle.png"
```

**Stored in material:**
```
[IMAGE: triangle.png]
Base64 Data: data:image/png;base64,iVBORw0...
```

**Query:**
```bash
curl -X POST http://localhost:8787/api/explain \
  -H "Content-Type: application/json" \
  -d '{
    "materialId": "uuid",
    "prompt": "What shape is in this image?"
  }'
```

**Response:**
```
"The image contains a triangle. It appears to be an equilateral 
triangle with three equal sides and angles..."
```

### Example 2: Mixed Content

**Material contains:**
- Text document about geometry
- Image of triangle diagram
- Text explaining properties

**Query:**
```bash
curl -X POST http://localhost:8787/api/explain \
  -H "Content-Type: application/json" \
  -d '{
    "materialId": "uuid",
    "prompt": "Explain the triangle in the diagram"
  }'
```

**Response:**
Vision API analyzes both the text content AND the visual diagram, providing comprehensive explanation.

## API Behavior

### Explain Endpoint
Automatically analyzes images when present in material.

### Quiz Endpoint
Can generate questions about visual content.

### Chat Endpoint
Supports visual Q&A in conversation.

### Flashcards Endpoint
Can create flashcards from visual diagrams.

## Size Limits

| Type | Limit | Notes |
|------|-------|-------|
| Raw image | 20MB | Before base64 encoding |
| Base64 image | 4MB | After encoding (Vision API limit) |
| Material total | 10MB | Including all text + images |

**Important:** Large images are automatically rejected if base64 > 4MB.

## Supported Image Types

- ✅ PNG (`.png`)
- ✅ JPEG/JPG (`.jpg`, `.jpeg`)

## Model Selection

The system automatically selects the appropriate model:

| Content Type | Model Used |
|-------------|------------|
| Text only | `llama-4-maverick-17b-128e-instruct` (default) |
| Text + Images | `llama-4-scout-17b-16e-instruct` (vision) |
| Images only | `llama-4-scout-17b-16e-instruct` (vision) |

## Use Cases

### 1. Diagrams & Charts
```
Upload: Process flowchart
Query: "Explain this workflow step by step"
```

### 2. Screenshots
```
Upload: Screenshot of code
Query: "What does this code do?"
```

### 3. Handwritten Notes
```
Upload: Photo of whiteboard
Query: "Summarize the key points"
```

### 4. Visual Learning
```
Upload: Biology diagram
Query: "Label the parts of this cell"
```

### 5. Math Problems
```
Upload: Geometry problem with diagram
Query: "Solve this problem"
```

## Technical Details

### Image Extraction (extractionService.ts)

```typescript
// If no text or minimal text
if (!content.trim() || content.length < 50) {
  const base64 = buffer.toString("base64");
  const imageType = this.detectImageType(buffer);
  const mimeType = imageType === "png" ? "image/png" : "image/jpeg";
  
  content = `[IMAGE: ${name}]
Type: ${mimeType}
Base64 Data:
data:${mimeType};base64,${base64}`;
}
```

### Image Detection (groqService.ts)

```typescript
private extractImagesFromMaterial(materialText: string): any[] {
  const imageMatches = materialText.matchAll(
    /\[IMAGE: ([^\]]+)\][\s\S]*?Base64 Data:\s*(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)/g
  );
  
  // Build content array with text and images interleaved
  return [
    { type: "text", text: "..." },
    { type: "image_url", image_url: { url: "data:image/..." } },
    // ...
  ];
}
```

### Model Auto-Selection

```typescript
private async makeRequest(params: any): Promise<string> {
  // Check if any message contains images
  const hasImages = params.messages?.some((msg: any) => 
    Array.isArray(msg.content) && 
    msg.content.some((c: any) => c.type === "image_url")
  );

  // Use vision model if images are present
  const model = hasImages 
    ? "meta-llama/llama-4-scout-17b-16e-instruct" 
    : config.groqModel;
  
  // ...
}
```

## Error Handling

### Image Too Large
```
Error: Image too large for processing: 5MB (max 4MB for base64 encoding)
```
**Solution:** Compress image before upload

### Invalid Image Format
```
Error: Unsupported file type for "image.bmp"
```
**Solution:** Convert to PNG or JPEG

### Vision API Timeout
```
Error: Groq Vision API request timed out
```
**Solution:** Retry or reduce image size

## Performance

| Operation | Time |
|-----------|------|
| Image upload + OCR attempt | ~1-2s |
| Store as base64 | <0.1s |
| Visual query (simple) | ~1-2s |
| Visual query (complex) | ~2-5s |

## Best Practices

### 1. Image Quality
- Use clear, high-resolution images
- Ensure good lighting for photos
- Crop unnecessary parts

### 2. File Size
- Compress large images before upload
- Target < 2MB for optimal performance
- Use PNG for diagrams, JPEG for photos

### 3. Naming
- Use descriptive filenames
- Include version/date if relevant
- Avoid special characters

### 4. Queries
- Be specific about what to analyze
- Reference the image by name if multiple
- Ask one question at a time for clarity

## Future Enhancements

Possible improvements:

1. **Multi-image comparison**
   - "Compare these 3 diagrams"
   - Side-by-side analysis

2. **Image annotations**
   - Draw on images
   - Add markers/labels

3. **Automatic image compression**
   - Client-side resize
   - Smart quality adjustment

4. **Image caching**
   - Avoid re-encoding
   - Faster repeated queries

5. **OCR + Visual hybrid**
   - Extract text AND analyze visuals
   - Best of both worlds

---

**Version**: 2.1.0  
**Last Updated**: October 7, 2025  
**Status**: ✅ Production Ready
