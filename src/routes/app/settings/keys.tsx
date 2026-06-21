import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy, Info, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { useCopy } from "~/hooks/use-copy";
import { useTRPC } from "~/lib/trpc";

// Types
interface ApiKeyRecord {
  createdAt: Date;
  enabled: boolean | null;
  id: string;
  key?: string; // full key value (only available on creation)
  lastRequest: Date | null;
  lastUsed: Date | null;
  name: null | string;
  prefix: null | string;
  remaining: number | null;
  requestCount: number;
  start: null | string;
}

interface OrgKeyData {
  createdAt: Date;
  enabled: boolean | null;
  expiresAt: Date | null;
  id: string;
  key?: string;
  lastRequest?: Date | null;
  lastUsed?: Date | null;
  metadata: null | Record<string, unknown>;
  name: null | string;
  permissions: null | Record<string, Array<string>>;
  prefix: null | string;
  rateLimitEnabled: boolean | null;
  rateLimitMax: number | null;
  rateLimitTimeWindow: number | null;
  remaining: number | null;
  requestCount: number;
  start: null | string;
  updatedAt: Date;
}

export const Route = createFileRoute("/app/settings/keys")({
  component: ApiKeysComponent,
  loader: ({ context }) => {
    void context.queryClient.ensureQueryData(context.trpc.organization.list.queryOptions());
  },
});

function ApiKeysComponent() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [, copy] = useCopy();

  // UI state
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<ApiKeyRecord | null>(null);
  const [newKeyName, setNewKeyName] = useState("");
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<null | string>(null);
  const [createdKeyCopied, setCreatedKeyCopied] = useState(false);
  const [snippetCopied, setSnippetCopied] = useState(false);

  // Get org for the keys context
  const orgListQuery = useSuspenseQuery(trpc.organization.list.queryOptions());
  const org = (orgListQuery.data ?? [])[0];

  // Queries
  const listQuery = useQuery(trpc.orgKey.list.queryOptions({ organizationId: org?.id ?? "" }, { enabled: !!org }));
  const apiKeys: Array<ApiKeyRecord> = (listQuery.data ?? []).map(formatApiKeyData as any);

  // Mutations
  const createMutation = useMutation(
    trpc.orgKey.create.mutationOptions({
      async onSuccess(data) {
        setNewlyCreatedKey(data.key);
        setNewKeyName("");
        setIsCreateDialogOpen(false);
        await queryClient.invalidateQueries(trpc.orgKey.list.queryOptions({ organizationId: org?.id ?? "" }));
      },
    }),
  );
  const updateMutation = useMutation(
    trpc.orgKey.update.mutationOptions({
      async onSuccess() {
        setIsEditDialogOpen(false);
        setEditingKey(null);
        setNewKeyName("");
        await queryClient.invalidateQueries(trpc.orgKey.list.queryOptions({ organizationId: org?.id ?? "" }));
      },
    }),
  );
  const deleteMutation = useMutation(
    trpc.orgKey.delete.mutationOptions({
      async onSettled() {
        await queryClient.invalidateQueries(trpc.orgKey.list.queryOptions({ organizationId: org?.id ?? "" }));
      },
    }),
  );

  const handleCreateKey = () => {
    if (!newKeyName.trim()) return;
    createMutation.mutate({ name: newKeyName.trim(), organizationId: org?.id ?? "" });
  };

  const handleDeleteKey = (keyId: string) => {
    deleteMutation.mutate({ keyId, organizationId: org?.id ?? "" });
  };

  const openEditDialog = (record: ApiKeyRecord) => {
    setEditingKey(record);
    setNewKeyName(record.name ?? "");
    setIsEditDialogOpen(true);
  };

  const handleSaveEdit = () => {
    if (!editingKey || !newKeyName.trim()) return;
    updateMutation.mutate({ keyId: editingKey.id, name: newKeyName.trim(), organizationId: org?.id ?? "" });
  };

  const formatKey = (key: string) => {
    const first = key.slice(0, 8);
    const last = key.slice(-4);
    return `${first}…${last}`;
  };

  const hasKeys = apiKeys.length > 0;
  const snippet = `curl -X POST https://zevium.dev/api/proxy/ \\
  -H 'Content-Type: application/json' \\
  -H 'x-zevium-key: YOUR_API_KEY' \\
  -H 'x-zevium-host: api.example.com' \\
  -d '{}'`;

  const handleCopySnippet = () => {
    copy(snippet);
    setSnippetCopied(true);
    window.setTimeout(() => setSnippetCopied(false), 2500);
  };

  return (
    <div className="mx-auto w-full max-w-3xl min-w-0 flex-1 space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-foreground">API Keys</h1>
          <div className="flex items-center gap-2">
            <p className="text-sm text-muted-foreground">
              Manage your organization's API keys to access all Zevium-integrated APIs
            </p>
            <Info className="size-4 text-muted-foreground" />
          </div>
        </div>

        {/* Create API Key Button */}
        <Dialog onOpenChange={setIsCreateDialogOpen} open={isCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="size-4" />
              Create API Key
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Create API Key</DialogTitle>
              <DialogDescription>
                Create a new API key to access Zevium APIs. Keep your key secure and never share it publicly.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="key-name">Key Name</Label>
                <Input
                  id="key-name"
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="Enter a name for your API key"
                  value={newKeyName}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                disabled={createMutation.isPending}
                onClick={() => setIsCreateDialogOpen(false)}
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={!newKeyName.trim() || createMutation.isPending} onClick={handleCreateKey}>
                {createMutation.isPending ? "Creating..." : "Create Key"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* One-time Key Reveal Dialog */}
        <Dialog
          onOpenChange={(open) => {
            if (!open) {
              setNewlyCreatedKey(null);
              setCreatedKeyCopied(false);
            }
          }}
          open={!!newlyCreatedKey}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Your new API key</DialogTitle>
              <DialogDescription>
                Copy and store this key now. For security, you won't be able to see it again.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Input readOnly value={newlyCreatedKey ?? ""} />
                <Button
                  aria-live="polite"
                  className="border border-border/40 bg-muted/30 px-3 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground data-copied:bg-chart-2/20 data-copied:text-chart-2 data-copied:hover:bg-chart-2/30 dark:hover:bg-muted/60"
                  data-copied={createdKeyCopied || undefined}
                  onClick={() => {
                    if (newlyCreatedKey) {
                      copy(newlyCreatedKey);
                      setCreatedKeyCopied(true);
                      window.setTimeout(() => setCreatedKeyCopied(false), 2500);
                    }
                  }}
                  size="sm"
                  title={createdKeyCopied ? "Copied" : "Copy key"}
                  variant="ghost"
                >
                  {createdKeyCopied ? <Check className="mr-1 size-3" /> : <Copy className="mr-1 size-3" />}{" "}
                  {createdKeyCopied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Never share your API key publicly. Treat it like a password.
              </p>
            </div>
            <DialogFooter>
              <Button onClick={() => setNewlyCreatedKey(null)} variant="default">
                Done
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* API Keys Table */}
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardContent className="p-0">
          <div className="overflow-hidden rounded-md border border-border/50">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30">
                  <TableHead className="text-xs font-medium">Key</TableHead>
                  <TableHead className="text-xs font-medium">Rate Limit</TableHead>
                  <TableHead className="text-xs font-medium">Remaining</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!hasKeys && (
                  <TableRow>
                    <TableCell className="py-10 text-center" colSpan={4}>
                      <div className="flex flex-col items-center gap-2">
                        <span className="text-sm text-muted-foreground">No API keys yet.</span>
                        <Button className="gap-2" onClick={() => setIsCreateDialogOpen(true)} size="sm">
                          <Plus className="size-4" /> Create your first key
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                {apiKeys.map((apiKey) => (
                  <TableRow className="hover:bg-muted/20" key={apiKey.id}>
                    <TableCell>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{apiKey.name}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <code className="rounded-sm bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                            {apiKey.key
                              ? formatKey(apiKey.key)
                              : `${apiKey.prefix ?? "zev"}...${apiKey.start ?? "xxxx"}`}
                          </code>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">60 req/min</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm font-medium">{apiKey.remaining ?? "∞"}</span>
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button className="size-8 p-0" size="sm" variant="ghost">
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40">
                          <DropdownMenuItem className="gap-2" onClick={() => openEditDialog(apiKey)}>
                            <Pencil className="size-4" /> Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="gap-2 text-destructive"
                            onClick={() => handleDeleteKey(apiKey.id)}
                          >
                            <Trash2 className="size-4" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Quick Start Snippet */}
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Quick Start (cURL)</CardTitle>
          <Button
            aria-live="polite"
            className="h-7 border border-border/40 bg-muted/30 px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground data-copied:bg-chart-2/20 data-copied:text-chart-2 data-copied:hover:bg-chart-2/30 dark:hover:bg-muted/60"
            data-copied={snippetCopied || undefined}
            onClick={handleCopySnippet}
            size="sm"
            title={snippetCopied ? "Copied" : "Copy snippet"}
            variant="ghost"
          >
            {snippetCopied ? <Check className="mr-1 size-3" /> : <Copy className="mr-1 size-3" />}{" "}
            {snippetCopied ? "Copied" : "Copy"}
          </Button>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="relative">
            <pre className="overflow-x-auto rounded-md border border-border/50 bg-muted/50 p-4 font-mono text-xs/relaxed whitespace-pre selection:bg-primary/30 selection:text-primary-foreground">
              {snippet}
            </pre>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Replace <code className="font-mono">YOUR_API_KEY</code> with one of the keys above.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog onOpenChange={setIsEditDialogOpen} open={isEditDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit API Key</DialogTitle>
            <DialogDescription>Update the display name for this key.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-key-name">Key Name</Label>
              <Input
                id="edit-key-name"
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="Key name"
                value={newKeyName}
              />
            </div>
          </div>
          <DialogFooter>
            <Button disabled={updateMutation.isPending} onClick={() => setIsEditDialogOpen(false)} variant="outline">
              Cancel
            </Button>
            <Button disabled={!newKeyName.trim() || updateMutation.isPending} onClick={handleSaveEdit}>
              {updateMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function formatApiKeyData(key: OrgKeyData): ApiKeyRecord {
  return {
    createdAt: key.createdAt,
    enabled: key.enabled ?? null,
    id: key.id,
    key: key.key,
    lastRequest: key.lastRequest ?? null,
    lastUsed: key.lastUsed ?? null,
    name: key.name,
    prefix: key.prefix,
    remaining: key.remaining ?? null,
    requestCount: key.requestCount,
    start: key.start,
  };
}
