import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Save, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import YAML from "yaml";

import { PageHeaderContent } from "~/components/sidebar";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { Typography } from "~/components/ui/typography";
import { useTRPC } from "~/lib/trpc";
import { formatDate } from "~/lib/utils";

export const Route = createFileRoute("/app/organizations/$organizationSlug/projects/$projectSlug/spec")({
  component: RouteComponent,
});

function RouteComponent() {
  const params = Route.useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [specContentOverride, setSpecContentOverride] = useState<null | string>(null);
  const [version, setVersion] = useState("");
  const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false);

  const draftQuery = useSuspenseQuery(trpc.openapiSchema.getDraft.queryOptions(params));
  const versionsQuery = useSuspenseQuery(trpc.openapiSchema.listVersions.queryOptions(params));
  const projectQuery = useSuspenseQuery(trpc.project.get.queryOptions(params));

  const latestDraftContent = useMemo(() => {
    const draft = draftQuery.data.draft;
    if (!draft) return "";
    try {
      const jsonObj = JSON.parse(draft);
      return YAML.stringify(jsonObj);
    } catch {
      return draft;
    }
  }, [draftQuery.data.draft]);

  const editorValue = specContentOverride ?? latestDraftContent;

  const saveDraftMutation = useMutation(
    trpc.openapiSchema.saveDraft.mutationOptions({
      onError: (error) => {
        toast.error(error.message);
      },
      onSuccess: () => {
        toast.success("Draft saved successfully");
        setSpecContentOverride(null);
        void queryClient.invalidateQueries(trpc.openapiSchema.getDraft.queryOptions(params));
      },
    }),
  );

  const handleSaveDraft = () => {
    let jsonContent = "";
    try {
      const parsed = YAML.parse(editorValue) as unknown;
      jsonContent = JSON.stringify(parsed);
    } catch {
      toast.error("Invalid YAML content");
      return;
    }
    saveDraftMutation.mutate({ draft: jsonContent, ...params });
  };

  const publishMutation = useMutation(
    trpc.openapiSchema.publish.mutationOptions({
      onError: (error) => {
        toast.error(error.message);
      },
      onSuccess: () => {
        toast.success("Version published successfully");
        setIsPublishDialogOpen(false);
        setVersion("");
        setSpecContentOverride(null);
        void queryClient.invalidateQueries(trpc.openapiSchema.listVersions.queryOptions(params));
      },
    }),
  );

  const handlePublish = () => {
    let jsonContent = "";
    try {
      const parsed = YAML.parse(editorValue) as unknown;
      jsonContent = JSON.stringify(parsed);
    } catch {
      toast.error("Invalid YAML content");
      return;
    }
    publishMutation.mutate({ draft: jsonContent, version, ...params });
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeaderContent>
        <Typography variant="large">{projectQuery.data.name} &gt; OpenAPI Spec</Typography>
      </PageHeaderContent>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card className="flex h-[calc(100vh-12rem)] flex-col">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div className="space-y-1">
                <CardTitle>Spec Editor</CardTitle>
                <CardDescription>
                  Edit your OpenAPI specification (YAML or JSON).
                  {draftQuery.data.updatedAt && (
                    <span className="ml-2">Last saved: {formatDate(draftQuery.data.updatedAt)}</span>
                  )}
                </CardDescription>
              </div>
              <div className="flex gap-2">
                <Button disabled={saveDraftMutation.isPending} onClick={handleSaveDraft} variant="outline">
                  <Save className="mr-2 h-4 w-4" />
                  {saveDraftMutation.isPending ? "Saving..." : "Save Draft"}
                </Button>
                <Dialog onOpenChange={setIsPublishDialogOpen} open={isPublishDialogOpen}>
                  <DialogTrigger asChild>
                    <Button>
                      <Upload className="mr-2 h-4 w-4" />
                      Publish
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Publish Version</DialogTitle>
                      <DialogDescription>Create a new immutable version of your API specification.</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                      <div className="grid grid-cols-4 items-center gap-4">
                        <Label className="text-right" htmlFor="version">
                          Version
                        </Label>
                        <Input
                          className="col-span-3"
                          id="version"
                          onChange={(e) => setVersion(e.target.value)}
                          placeholder="e.g. 1.0.0"
                          value={version}
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button disabled={publishMutation.isPending || !version} onClick={handlePublish}>
                        {publishMutation.isPending ? "Publishing..." : "Publish"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent className="flex-1 p-0">
              <Textarea
                className="h-full w-full resize-none rounded-none border-0 p-4 font-mono focus-visible:ring-0"
                onChange={(e) => setSpecContentOverride(e.target.value)}
                placeholder="Paste your OpenAPI spec here (YAML or JSON)..."
                spellCheck={false}
                value={editorValue}
              />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Version History</CardTitle>
              <CardDescription>Previously published versions.</CardDescription>
            </CardHeader>
            <CardContent>
              {versionsQuery.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">No versions published yet.</p>
              ) : (
                <div className="space-y-4">
                  {versionsQuery.data.map((v) => (
                    <div className="flex items-center justify-between border-b pb-2 last:border-0 last:pb-0" key={v.id}>
                      <div>
                        <p className="font-medium">{v.version}</p>
                        <p className="text-xs text-muted-foreground">{formatDate(v.createdAt)}</p>
                      </div>
                      <Button size="sm" variant="ghost">
                        View
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
