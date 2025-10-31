"use client";

import { Crop, Upload, X } from "lucide-react";
import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { cn } from "~/lib/utils";

/**
 * Props for the ImageUpload component
 */
interface ImageUploadProps {
  /**
   * Aspect ratio for the cropped image (e.g., 1 for 1:1, 16/9 for 16:9, 1.91/1 for LinkedIn cover)
   * @default 1
   */
  aspectRatio?: number;
  /**
   * Additional CSS classes to apply to the container
   */
  className?: string;
  /**
   * Whether the upload input is disabled
   * @default false
   */
  disabled?: boolean;
  /**
   * Maximum file size in KB (default 100)
   * @default 100
   */
  maxSizeKb?: number;
  /**
   * Callback function that receives the compressed base64 image data
   * Called after the image is successfully cropped and compressed
   */
  onChangeValue?: (base64: string) => void;
  /**
   * Placeholder text shown in the upload area
   * @default "Click to upload or drag and drop"
   */
  placeholder?: string;
  /**
   * Initial preview image URL (data URL or external URL)
   */
  previewUrl?: string;
}

/**
 * ImageUpload Component
 *
 * A fully-featured image upload component with built-in cropping and compression capabilities.
 * Users can:
 * - Upload images via click or drag-and-drop
 * - Crop images to a specified aspect ratio with interactive controls
 * - Automatically compress images to meet size constraints
 * - Receive base64-encoded compressed images
 *
 * @component
 * @example
 * ```tsx
 * const [imageData, setImageData] = useState("");
 *
 * return (
 *   <ImageUpload
 *     aspectRatio={1.91}
 *     maxSizeKb={100}
 *     onChangeValue={setImageData}
 *     placeholder="Upload profile picture"
 *   />
 * );
 * ```
 *
 * @param props - Component props
 * @returns The rendered component
 */
function ImageUpload({
  aspectRatio = 1,
  className,
  disabled,
  maxSizeKb = 10240,
  onChangeValue,
  placeholder = "Click to upload or drag and drop",
  previewUrl,
}: ImageUploadProps) {
  const [isDragActive, setIsDragActive] = useState(false);
  const [preview, setPreview] = useState<string>(previewUrl ?? "");
  const [showCropDialog, setShowCropDialog] = useState(false);
  const [cropImage, setCropImage] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Crop state
  const [cropBox, setCropBox] = useState({ height: 0, width: 0, x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [imageData, setImageData] = useState({
    height: 0,
    naturalHeight: 0,
    naturalWidth: 0,
    width: 0,
  });

  /**
   * Handles drag events to toggle active state
   */
  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setIsDragActive(true);
    } else if (e.type === "dragleave") {
      setIsDragActive(false);
    }
  }, []);

  /**
   * Handles drop events to upload the dropped image
   */
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragActive(false);

      const files = e.dataTransfer.files;
      const file = Array.from(files).at(0);
      if (file) {
        // Inline handleFileSelect to avoid circular dependency
        if (!file.type.startsWith("image/")) {
          alert("Please select an image file");
          return;
        }

        if (file.size > maxSizeKb * 1024) {
          alert(`File size must be less than ${maxSizeKb}KB. Please compress or choose a smaller image.`);
          return;
        }

        const reader = new FileReader();
        reader.onload = (evt) => {
          const imageData = evt.target?.result as string;
          setCropImage(imageData);
          setShowCropDialog(true);
        };
        reader.readAsDataURL(file);
      }
    },
    [maxSizeKb],
  );

  /**
   * Validates and processes the selected image file
   * @param file - The image file to process
   */
  const handleFileSelect = useCallback(
    (file: File) => {
      if (!file.type.startsWith("image/")) {
        alert("Please select an image file");
        return;
      }

      if (file.size > maxSizeKb * 1024) {
        alert(`File size must be less than ${maxSizeKb}KB. Please compress or choose a smaller image.`);
        return;
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        const data = e.target?.result as string;
        setCropImage(data);
        setShowCropDialog(true);
      };
      reader.readAsDataURL(file);
    },
    [maxSizeKb],
  );

  /**
   * Handles file input change event
   */
  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.currentTarget.files;
      if (files) {
        const file = Array.from(files).at(0);
        if (file) {
          handleFileSelect(file);
        }
      }
    },
    [handleFileSelect],
  );

  /**
   * Initialize crop box when image loads
   * Calculates the initial crop dimensions based on aspect ratio
   */
  /**
   * Initialize crop box when image loads
   * Calculates the initial crop dimensions based on aspect ratio
   */
  const initializeCropBox = useCallback(
    (img: HTMLImageElement, container: HTMLDivElement) => {
      const containerWidth = container.offsetWidth;
      const containerHeight = container.offsetHeight;
      const imgWidth = img.offsetWidth;
      const imgHeight = img.offsetHeight;

      let cropHeight, cropWidth;

      if (aspectRatio > 1) {
        cropWidth = Math.min(containerWidth * 0.8, imgWidth);
        cropHeight = cropWidth / aspectRatio;
      } else {
        cropHeight = Math.min(containerHeight * 0.8, imgHeight);
        cropWidth = cropHeight * aspectRatio;
      }

      const x = (imgWidth - cropWidth) / 2;
      const y = (imgHeight - cropHeight) / 2;

      return {
        cropBox: {
          height: Math.min(cropHeight, imgHeight),
          width: Math.min(cropWidth, imgWidth),
          x: Math.max(0, x),
          y: Math.max(0, y),
        },
        imageData: {
          height: imgHeight,
          naturalHeight: img.naturalHeight,
          naturalWidth: img.naturalWidth,
          width: imgWidth,
        },
      };
    },
    [aspectRatio],
  );

  const handleImageLoad = useCallback(() => {
    if (!imageRef.current || !containerRef.current) return;

    const { cropBox: newCropBox, imageData: newImageData } = initializeCropBox(imageRef.current, containerRef.current);

    // Image load is async - we need to update state when image dimensions become available
    // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect
    setCropBox(newCropBox);
    // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect
    setImageData(newImageData);
  }, [initializeCropBox]);

  useEffect(() => {
    if (!imageRef.current) return;

    const img = imageRef.current;

    // Check if image is already cached and loaded
    if (img.complete && img.naturalHeight > 0) {
      handleImageLoad();
    } else {
      img.addEventListener("load", handleImageLoad);
    }

    return () => img.removeEventListener("load", handleImageLoad);
  }, [cropImage, handleImageLoad]);

  /**
   * Force re-measure image dimensions when dialog opens
   * This ensures crop box is properly initialized even if load event already fired
   */
  useEffect(() => {
    if (!showCropDialog) return;

    // Use setTimeout to ensure the dialog is fully rendered
    const timer = setTimeout(() => {
      handleImageLoad();
    }, 100);

    return () => clearTimeout(timer);
  }, [showCropDialog, handleImageLoad]);

  /**
   * Handles crop box movement via mouse drag
   */
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!imageRef.current) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  /**
   * Effect to handle crop box dragging across the image
   */
  useEffect(() => {
    if (!isDragging || !imageRef.current) return;

    const handleMouseMove = (e: MouseEvent) => {
      const img = imageRef.current;
      if (!img) return;

      const deltaX = e.clientX - dragStart.x;
      const deltaY = e.clientY - dragStart.y;

      setCropBox((prev) => ({
        ...prev,
        x: Math.max(0, Math.min(prev.x + deltaX, imageData.width - prev.width)),
        y: Math.max(0, Math.min(prev.y + deltaY, imageData.height - prev.height)),
      }));

      setDragStart({ x: e.clientX, y: e.clientY });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragStart, imageData, isDragging]);

  /**
   * Handles crop box resizing from corners
   * Maintains aspect ratio while resizing
   * @param corner - The corner being resized (e.g., "nw", "ne", "sw", "se")
   */
  const handleCornerResize = (corner: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startBox = { ...cropBox };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;

      const newBox = { ...startBox };

      if (corner.includes("nw")) {
        newBox.x = Math.max(0, startBox.x + deltaX);
        newBox.y = Math.max(0, startBox.y + deltaY);
        newBox.width = startBox.width - deltaX;
        newBox.height = newBox.width / aspectRatio;
      } else if (corner.includes("ne")) {
        newBox.y = Math.max(0, startBox.y + deltaY);
        newBox.width = Math.max(50, startBox.width + deltaX);
        newBox.height = newBox.width / aspectRatio;
      } else if (corner.includes("sw")) {
        newBox.x = Math.max(0, startBox.x + deltaX);
        newBox.width = Math.max(50, startBox.width - deltaX);
        newBox.height = newBox.width / aspectRatio;
      } else if (corner.includes("se")) {
        newBox.width = Math.max(50, startBox.width + deltaX);
        newBox.height = newBox.width / aspectRatio;
      }

      // Constrain to image bounds
      newBox.x = Math.max(0, Math.min(newBox.x, imageData.width - newBox.width));
      newBox.y = Math.max(0, Math.min(newBox.y, imageData.height - newBox.height));
      newBox.width = Math.min(newBox.width, imageData.width - newBox.x);
      newBox.height = Math.min(newBox.height, imageData.height - newBox.y);

      setCropBox(newBox);
    };

    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  /**
   * Compresses an image using canvas toDataURL with progressive quality reduction
   * @param canvas - The canvas element containing the image to compress
   * @returns Promise resolving to base64 encoded compressed image
   */
  const compressImage = useCallback(
    async (canvas: HTMLCanvasElement): Promise<string> => {
      return new Promise((resolve) => {
        let quality = 0.95;
        let compressed = canvas.toDataURL("image/jpeg", quality);

        // Return early if the canvas is empty
        if (!compressed || compressed.length < 50) {
          // Canvas might be too small, try PNG
          compressed = canvas.toDataURL("image/png");
          resolve(compressed);
          return;
        }

        // Reduce quality until size is under maxSizeKb
        while (compressed.length > maxSizeKb * 1024 * (4 / 3) && quality > 0.1) {
          quality -= 0.05;
          compressed = canvas.toDataURL("image/jpeg", quality);
        }

        resolve(compressed);
      });
    },
    [maxSizeKb],
  );

  /**
   * Applies the crop to the image and triggers compression
   * Draws the cropped region onto canvas and compresses the result
   */
  const handleCrop = useCallback(async () => {
    if (!imageRef.current || !canvasRef.current) return;

    const img = imageRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    if (!ctx) return;

    // Ensure image dimensions are available
    if (!imageData.naturalWidth || !imageData.naturalHeight || !imageData.width || !imageData.height) {
      console.error("Image data not properly initialized", imageData);
      alert("Image failed to load properly. Please try again.");
      return;
    }

    const scaleX = imageData.naturalWidth / imageData.width;
    const scaleY = imageData.naturalHeight / imageData.height;

    const sx = cropBox.x * scaleX;
    const sy = cropBox.y * scaleY;
    const sWidth = cropBox.width * scaleX;
    const sHeight = cropBox.height * scaleY;

    // Validate crop dimensions
    if (sWidth <= 0 || sHeight <= 0) {
      console.error("Invalid crop dimensions", { sHeight, sWidth });
      alert("Invalid crop area. Please adjust and try again.");
      return;
    }

    canvas.width = sWidth;
    canvas.height = sHeight;

    try {
      ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, sWidth, sHeight);
      const compressed = await compressImage(canvas);

      if (!compressed || compressed.length < 50) {
        console.error("Compression failed, result too small");
        alert("Failed to process image. Please try again.");
        return;
      }

      setPreview(compressed);
      onChangeValue?.(compressed);
    } catch (error) {
      console.error("Error during crop or compression:", error);
      alert("Error processing image. Please try again.");
    }

    setShowCropDialog(false);
    setCropImage("");
  }, [compressImage, cropBox, imageData, onChangeValue]);

  return (
    <>
      <div className={cn("relative", className)}>
        {preview ? (
          <div className="relative inline-block">
            <img
              alt="Preview"
              className="border-border max-w-full rounded-lg border"
              src={preview}
              style={{ aspectRatio: aspectRatio }}
            />
            <button
              className="bg-background/80 hover:bg-background absolute top-2 right-2 rounded-lg p-2"
              disabled={disabled}
              onClick={() => {
                setPreview("");
                onChangeValue?.("");
                if (fileInputRef.current) {
                  fileInputRef.current.value = "";
                }
              }}
              type="button"
            >
              <X className="size-4" />
            </button>
          </div>
        ) : (
          <div
            className={cn(
              "border-border relative cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition-colors",
              isDragActive && "border-primary bg-primary/5",
              disabled && "cursor-not-allowed opacity-50",
            )}
            onClick={() => !disabled && fileInputRef.current?.click()}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && !disabled) {
                fileInputRef.current?.click();
              }
            }}
            role="button"
            tabIndex={0}
          >
            <div>
              <Upload className="text-muted-foreground mx-auto mb-2 size-8" />
              <p className="text-foreground text-sm font-medium">{placeholder}</p>
              <p className="text-muted-foreground text-xs">Image should be less than {maxSizeKb}KB</p>
            </div>

            <input
              accept="image/*"
              className="hidden"
              disabled={disabled}
              onChange={handleFileInput}
              ref={fileInputRef}
              type="file"
            />
          </div>
        )}
      </div>

      <Dialog onOpenChange={setShowCropDialog} open={showCropDialog}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Crop Image</DialogTitle>
            <DialogDescription>
              Drag to move, use corners to resize. Aspect ratio: {aspectRatio.toFixed(2)}:1
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div
              className="border-border bg-muted relative mx-auto max-h-96 max-w-2xl overflow-hidden rounded-lg border"
              ref={containerRef}
            >
              <img alt="Crop" className="mx-auto h-full max-w-full object-contain" ref={imageRef} src={cropImage} />

              {/* Crop overlay and handles */}
              <svg className="pointer-events-none absolute inset-0" height="100%" width="100%">
                {/* Darkened areas outside crop box */}
                <defs>
                  <mask id="crop-mask">
                    <rect fill="white" height="100%" width="100%" />
                    <rect fill="black" height={cropBox.height} width={cropBox.width} x={cropBox.x} y={cropBox.y} />
                  </mask>
                </defs>

                <rect fill="black" height="100%" mask="url(#crop-mask)" opacity="0.5" width="100%" />

                {/* Crop box border */}
                <rect
                  fill="none"
                  height={cropBox.height}
                  pointerEvents="auto"
                  stroke="hsl(var(--destructive))"
                  strokeWidth="2"
                  width={cropBox.width}
                  x={cropBox.x}
                  y={cropBox.y}
                />

                {/* Center guide lines */}
                <line
                  pointerEvents="none"
                  stroke="hsl(var(--destructive) / 0.3)"
                  strokeWidth="1"
                  x1={cropBox.x + cropBox.width / 3}
                  x2={cropBox.x + cropBox.width / 3}
                  y1={cropBox.y}
                  y2={cropBox.y + cropBox.height}
                />
                <line
                  pointerEvents="none"
                  stroke="hsl(var(--destructive) / 0.3)"
                  strokeWidth="1"
                  x1={cropBox.x + (cropBox.width * 2) / 3}
                  x2={cropBox.x + (cropBox.width * 2) / 3}
                  y1={cropBox.y}
                  y2={cropBox.y + cropBox.height}
                />
                <line
                  pointerEvents="none"
                  stroke="hsl(var(--destructive) / 0.3)"
                  strokeWidth="1"
                  x1={cropBox.x}
                  x2={cropBox.x + cropBox.width}
                  y1={cropBox.y + cropBox.height / 3}
                  y2={cropBox.y + cropBox.height / 3}
                />
                <line
                  pointerEvents="none"
                  stroke="hsl(var(--destructive) / 0.3)"
                  strokeWidth="1"
                  x1={cropBox.x}
                  x2={cropBox.x + cropBox.width}
                  y1={cropBox.y + (cropBox.height * 2) / 3}
                  y2={cropBox.y + (cropBox.height * 2) / 3}
                />
              </svg>

              {/* Draggable crop box and resize handles */}
              <div
                className="absolute cursor-move"
                onMouseDown={handleMouseDown}
                style={{
                  height: `${cropBox.height}px`,
                  left: `${cropBox.x}px`,
                  top: `${cropBox.y}px`,
                  width: `${cropBox.width}px`,
                }}
              >
                {/* Resize handles */}
                {["nw", "ne", "sw", "se"].map((corner) => (
                  <div
                    className="bg-destructive absolute size-3 cursor-nwse-resize rounded-full"
                    key={corner}
                    onMouseDown={handleCornerResize(corner)}
                    style={{
                      ...(corner.includes("w") ? { left: "-6px" } : { right: "-6px" }),
                      ...(corner.includes("n") ? { top: "-6px" } : { bottom: "-6px" }),
                    }}
                  />
                ))}
              </div>
            </div>

            <canvas className="hidden" ref={canvasRef} />

            <div className="flex justify-end gap-2">
              <Button onClick={() => setShowCropDialog(false)} variant="outline">
                Cancel
              </Button>
              <Button onClick={handleCrop}>
                <Crop className="mr-2 size-4" />
                Apply Crop
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export { ImageUpload };
