import { ChevronDown, FileUp, Link2, FileCode2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { humanError } from "#/lib/human-error";
import { fetchSpecFromUrl, parseImportSpecUrl } from "#/lib/spec-import";
import { convertSpecInputToJson } from "#/lib/spec-yaml";

import { OPENAPI_TEMPLATE } from "./template";

export type EditorToolbarProps = {
  onApplyText: (text: string) => void;
  disabled?: boolean;
};

export function EditorToolbar({ onApplyText, disabled }: EditorToolbarProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [urlOpen, setUrlOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [urlPending, setUrlPending] = useState(false);

  async function applyImportedRaw(raw: string) {
    const converted = await convertSpecInputToJson(raw);
    if (!converted.ok) {
      toast.error(converted.error);
      return;
    }
    onApplyText(converted.json);
    if (converted.convertedFromYaml) {
      toast.success("Converted YAML to JSON");
    } else {
      toast.success("Spec imported");
    }
  }

  async function onFileChange(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file) return;
    try {
      const raw = await file.text();
      await applyImportedRaw(raw);
    } catch (err) {
      toast.error(humanError(err, "Could not read file"));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function onImportUrl() {
    const parsed = parseImportSpecUrl({ url });
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    setUrlPending(true);
    try {
      const result = await fetchSpecFromUrl({ data: parsed.data });
      await applyImportedRaw(result.text);
      setUrlOpen(false);
      setUrl("");
    } catch (err) {
      toast.error(humanError(err, "Could not import from URL"));
    } finally {
      setUrlPending(false);
    }
  }

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml,text/x-yaml"
        className="hidden"
        onChange={(e) => void onFileChange(e.target.files)}
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={disabled}>
            Import
            <ChevronDown className="size-3.5 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            onSelect={() => fileRef.current?.click()}
            disabled={disabled}
          >
            <FileUp className="size-3.5" />
            Upload .json / .yaml
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setUrlOpen(true)}
            disabled={disabled}
          >
            <Link2 className="size-3.5" />
            Import from URL
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              onApplyText(OPENAPI_TEMPLATE);
              toast.success("Template loaded");
            }}
            disabled={disabled}
          >
            <FileCode2 className="size-3.5" />
            Start from template
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={urlOpen} onOpenChange={setUrlOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import from URL</DialogTitle>
            <DialogDescription>
              Fetch an OpenAPI document server-side. Max 2MB. YAML converts to
              JSON.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="spec-import-url">URL</Label>
            <Input
              id="spec-import-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/openapi.yaml"
              className="font-mono text-xs"
              disabled={urlPending}
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setUrlOpen(false)}
              disabled={urlPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void onImportUrl()}
              disabled={urlPending || url.trim() === ""}
            >
              {urlPending ? "Fetching…" : "Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
