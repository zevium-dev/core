import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { ImageUpload } from "~/components/image-upload";

export const Route = createFileRoute("/$internal/image-upload-test")({
  component: ImageUploadTest,
});

function ImageUploadTest() {
  const [image, setImage] = useState("");
  const [aspectRatio, setAspectRatio] = useState(1);

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="mx-auto max-w-2xl space-y-8">
        <div>
          <h1 className="mb-2 text-3xl font-bold">ImageUpload Component Test</h1>
          <p className="text-muted-foreground">Test the image upload, crop, and compression functionality</p>
        </div>

        <div className="space-y-4 rounded-lg border border-border p-6">
          <div>
            <label className="block text-sm font-medium">Aspect Ratio</label>
            <select
              className="mt-2 w-full rounded-sm border border-border bg-background p-2"
              onChange={(e) => setAspectRatio(parseFloat(e.target.value))}
              value={aspectRatio}
            >
              <option value={1}>1:1 (Square)</option>
              <option value={16 / 9}>16:9 (Wide)</option>
              <option value={1.91}>1.91:1 (LinkedIn Cover)</option>
              <option value={3 / 4}>3:4 (Portrait)</option>
            </select>
          </div>

          <div data-testid="image-upload-container">
            <ImageUpload
              aspectRatio={aspectRatio}
              maxSizeKb={10240}
              onChangeValue={setImage}
              placeholder="Upload and crop your image"
              previewUrl={image}
            />
          </div>
        </div>

        {image && (
          <div className="space-y-2 rounded-lg border border-border p-6">
            <h2 className="text-lg font-semibold">Output Preview</h2>
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Base64 Length: {image.length} characters</p>
                <p className="text-sm text-muted-foreground">
                  Approx Size: {((image.length * 0.75) / 1024).toFixed(2)} KB
                </p>
              </div>
            </div>
            <img
              alt="Output"
              className="max-w-full rounded-sm border border-border"
              src={image}
              style={{ maxHeight: "300px", objectFit: "contain" }}
            />
          </div>
        )}

        <div className="space-y-2 rounded-lg border border-border p-6">
          <h2 className="text-lg font-semibold">Test Instructions</h2>
          <ul className="list-inside space-y-1 text-sm text-muted-foreground">
            <li>1. Click the upload area or drag an image</li>
            <li>2. A crop dialog should appear</li>
            <li>3. Drag to move the crop box</li>
            <li>4. Drag corners to resize while maintaining aspect ratio</li>
            <li>5. Click "Apply Crop" to confirm</li>
            <li>6. Image should appear above compressed and as base64</li>
            <li>7. Click X button to clear the image</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
