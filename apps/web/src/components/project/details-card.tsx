import { useConvexMutation } from "@convex-dev/react-query";
import { useMutation } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { api } from "#/lib/convex-api";
import type { Doc } from "#/lib/convex-data-model";
import { humanError } from "#/lib/human-error";
import { parseTagsInput } from "#/lib/project-helpers";
export function DetailsCard({ project }: { project: Doc<"projects"> }) {
  const [nameEdit, setName] = useState<string | undefined>();
  const name = nameEdit ?? project.name;
  const [descriptionEdit, setDescription] = useState<string | undefined>();
  const description = descriptionEdit ?? project.description ?? "";
  const [tagsTextEdit, setTagsText] = useState<string | undefined>();
  const tagsText = tagsTextEdit ?? project.tags.join(", ");
  const [detailsSubmitted, setDetailsSubmitted] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const tagsInputRef = useRef<HTMLInputElement>(null);
  const updateProject = useConvexMutation(api.projects.update);
  const { mutate: saveDetails, isPending: savePending } = useMutation({
    mutationFn: (patch: {
      name: string;
      description: string | null;
      tags: string[];
    }) => updateProject({ projectId: project._id, patch }),
    onSuccess: () => {
      setDetailsSubmitted(false);
      setDetailsError(null);
      setName(undefined);
      setDescription(undefined);
      setTagsText(undefined);
    },
    onError: (error: unknown) =>
      setDetailsError(humanError(error, "Could not update project")),
  });
  const tagsPreview = parseTagsInput(tagsText);
  const nameError = name.trim() === "" ? "Enter a project name." : null;
  const tagsError =
    tagsPreview.length > 32 ? "Use at most 32 unique tags." : null;

  function onSaveDetails(e: FormEvent) {
    e.preventDefault();
    if (savePending) return;
    setDetailsSubmitted(true);
    setDetailsError(null);

    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      nameInputRef.current?.focus();
      return;
    }
    if (tagsPreview.length > 32) {
      tagsInputRef.current?.focus();
      return;
    }

    const trimmedDescription = description.trim();
    saveDetails({
      name: trimmedName,
      description: trimmedDescription === "" ? null : trimmedDescription,
      tags: tagsPreview,
    });
  }

  return (
    <Card>
      <form onSubmit={onSaveDetails} noValidate>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            Project details
          </CardTitle>
          <CardDescription>
            Name, description, and catalogue tags. Slug is permanent.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {detailsError ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {detailsError}
            </p>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="settings-name">Name</Label>
            <Input
              ref={nameInputRef}
              id="settings-name"
              name="project-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setDetailsError(null);
              }}
              maxLength={120}
              disabled={savePending}
              autoComplete="off"
              aria-invalid={detailsSubmitted && nameError !== null}
              aria-describedby="settings-name-help"
            />
            <p
              id="settings-name-help"
              className={`min-h-5 text-xs ${detailsSubmitted && nameError ? "text-destructive" : "text-muted-foreground"}`}
            >
              {detailsSubmitted && nameError
                ? nameError
                : "Shown in the dashboard and public catalogue."}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="settings-slug">Slug</Label>
            <Input
              id="settings-slug"
              name="project-slug"
              value={project.slug}
              disabled
              readOnly
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Slug cannot be changed after creation.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="settings-description">Description</Label>
            <Textarea
              id="settings-description"
              name="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              disabled={savePending}
              rows={4}
              className="min-h-24"
              aria-describedby="settings-description-help"
            />
            <p
              id="settings-description-help"
              className="min-h-5 text-xs text-muted-foreground"
            >
              Explain inputs, outputs, and ideal use cases.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="settings-tags">Tags</Label>
            <Input
              ref={tagsInputRef}
              id="settings-tags"
              name="project-tags"
              value={tagsText}
              onChange={(e) => {
                setTagsText(e.target.value);
                setDetailsError(null);
              }}
              placeholder="ai, llm, tools"
              disabled={savePending}
              autoComplete="off"
              aria-invalid={detailsSubmitted && tagsError !== null}
              aria-describedby="settings-tags-help"
            />
            <p
              id="settings-tags-help"
              className={`min-h-5 text-xs ${detailsSubmitted && tagsError ? "text-destructive" : "text-muted-foreground"}`}
            >
              {detailsSubmitted && tagsError
                ? tagsError
                : "Comma-separated. Lowercased and de-duplicated on save (max 32)."}
            </p>
            {tagsPreview.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {tagsPreview.map((tag) => (
                  <Badge key={tag} variant="outline">
                    {tag}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        </CardContent>
        <CardFooter className="justify-end border-t pt-6">
          <Button type="submit" disabled={savePending}>
            {savePending ? "Saving…" : "Save changes"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
