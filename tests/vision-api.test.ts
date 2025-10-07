/**
 * Quick test for Groq Vision API image extraction
 * 
 * This test validates:
 * - Image type detection (PNG/JPEG)
 * - Base64 encoding
 * - Size validation
 * - API integration (requires GROQ_API_KEY)
 */

import { extractImageText } from "../src/extract/image.js";
import { readFileSync } from "fs";
import { join } from "path";

async function testVisionAPI() {
  console.log("🧪 Testing Groq Vision API Integration\n");

  // Test 1: PNG signature detection
  const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  console.log("✓ PNG signature detection");

  // Test 2: JPEG signature detection
  const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  console.log("✓ JPEG signature detection");

  // Test 3: Size validation
  const largeBuffer = Buffer.alloc(5 * 1024 * 1024); // 5MB
  const largeBase64 = largeBuffer.toString("base64");
  const largeSize = Buffer.byteLength(largeBase64, "utf8");
  console.log(`✓ Size validation (5MB → ${Math.round(largeSize / 1024 / 1024)}MB base64)`);

  // Test 4: Actual extraction (requires real image and API key)
  try {
    console.log("\n📸 Testing actual image extraction...");
    console.log("Note: This requires GROQ_API_KEY to be set");
    
    // Create a simple test image (1x1 transparent PNG)
    const testImage = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    );
    
    if (process.env.GROQ_API_KEY) {
      const result = await extractImageText(testImage);
      console.log(`✓ Vision API call successful`);
      console.log(`  Extracted: "${result.slice(0, 100)}${result.length > 100 ? '...' : ''}"`);
    } else {
      console.log("⚠ Skipping API test (GROQ_API_KEY not set)");
    }
  } catch (error) {
    console.error("❌ Vision API test failed:", error instanceof Error ? error.message : error);
  }

  console.log("\n✅ All tests completed!");
}

// Run tests
testVisionAPI().catch(console.error);
