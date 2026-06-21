import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy, Info, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

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
import { auth } from "~/lib/auth";

// Types
interface ApiKeyRecord {
  createdAt: Date;
  enabled: boolean | null;
  id: string;
  key?: string; // full key value (only available on creation)
  lastRequest: Date | null;
  lastUsed: Date | null;
  limit: string; // e.g. "Unlimited" or custom string like "1000 req/day"
  name: null | string;
  prefix: null | string;
  requestCount: number;
  start: null | string;
  usage: string; // formatted usage string
}

interface BetterAuthApiKey {
  createdAt: Date;
  enabled: boolean;
  expiresAt: Date | null;
  id: string;
  key?: string;
  lastRequest?: Date | null;
  lastUsed?: Date | null;
  metadata: null | Record<string, unknown>;
  name: null | string;
  permissions: null | Record<string, Array<string>>;
  prefix: null | string;
  refillAmount: null | number;
  refillInterval: null | number;
  requestCount?: number;
  start: null | string;
  updatedAt: Date;
  userId?: string;
}

export const Route = createFileRoute("/app/settings/keys")({
  component: ApiKeysComponent,
});

function ApiKeysComponent() {
  // State
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<ApiKeyRecord | null>(null);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyLimit, setNewKeyLimit] = useState(""); // user input for credit limit (money)
  const [, copy] = useCopy();
  const [isPending, setIsPending] = useState(false);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<null | string>(null);
  const [createdKeyCopied, setCreatedKeyCopied] = useState(false);

  // Queries using Better Auth client
  const { data: rawApiKeys = [], refetch } = useQuery({
    queryFn: async () => {
      const { data, error } = await auth.apiKey.list();
      if (error) throw new Error(error.message);
      return data.apiKeys;
    },
    queryKey: ["apiKeys"],
  });

  // Convert raw API keys to display format
  const apiKeys: Array<ApiKeyRecord> = rawApiKeys.map(formatApiKeyData);

  // Helpers
  const handleCreateKey = async () => {
    if (!newKeyName.trim()) return;

    setIsPending(true);
    try {
      const { data, error } = await auth.apiKey.create({
        expiresIn: undefined, // TODO: Add expiry support
        name: newKeyName.trim(),
      });

      if (error) throw new Error(error.message);

      // Show plaintext key once for copying
      setNewlyCreatedKey(data.key);

      void refetch();
      setNewKeyName("");
      setNewKeyLimit("");
      setIsCreateDialogOpen(false);
    } catch (error) {
      console.error("Failed to create API key:", error);
    } finally {
      setIsPending(false);
    }
  };

  const handleCopyKey = (value: string) => {
    copy(value);
  };

  const handleDeleteKey = async (keyId: string) => {
    setIsPending(true);
    try {
      // eslint-disable-next-line drizzle/enforce-delete-with-where
      const { error } = await auth.apiKey.delete({ keyId });
      if (error) throw new Error(error.message);
      void refetch();
    } catch (error) {
      console.error("Failed to delete API key:", error);
    } finally {
      setIsPending(false);
    }
  };

  const openEditDialog = (record: ApiKeyRecord) => {
    setEditingKey(record);
    setNewKeyName(record.name ?? "");
    setNewKeyLimit(record.limit === "Unlimited" ? "" : record.limit.replace(/^[^0-9$]*/, ""));
    setIsEditDialogOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!editingKey || !newKeyName.trim()) return;

    setIsPending(true);
    try {
      const { error } = await auth.apiKey.update({
        keyId: editingKey.id,
        name: newKeyName.trim(),
      });

      if (error) throw new Error(error.message);

      void refetch();
      setIsEditDialogOpen(false);
      setEditingKey(null);
      setNewKeyName("");
      setNewKeyLimit("");
    } catch (error) {
      console.error("Failed to update API key:", error);
    } finally {
      setIsPending(false);
    }
  };

  const formatKey = (key: string) => {
    // Permanent mask: show prefix identifier & last 4
    const first = key.slice(0, 8);
    const last = key.slice(-4);
    return `${first}…${last}`;
  };

  const hasKeys = apiKeys.length > 0;
  const totalUsage = useMemo(
    () => apiKeys.reduce((acc, k) => acc + (parseFloat(k.usage.replace(/[^0-9.]/g, "")) || 0), 0),
    [apiKeys],
  );
  const [snippetCopied, setSnippetCopied] = useState(false);
  const snippet = `curl -X POST https://zevium.dev/api/v1/scrapperApi/ \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer YOUR_API_KEY' \\
  -d '{\n    "model": "openai/gpt-4o-mini",\n    "messages": [{"role":"user","content":"Explain how AI works in a few words"}]\n  }'`;

  const handleCopySnippet = () => {
    handleCopyKey(snippet);
    setSnippetCopied(true);
    window.setTimeout(() => setSnippetCopied(false), 2500);
  };

  return (
    <div className="mx-auto w-full max-w-3xl min-w-0 flex-1 space-y-6 p-6">
      {/* (Optional) Settings navigation placeholder – removed due to missing component */}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-foreground">API Keys</h1>
          <div className="flex items-center gap-2">
            <p className="text-sm text-muted-foreground">Manage your API keys to access all Zevium-integrated APIs</p>
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
              <div className="space-y-2">
                <Label htmlFor="key-limit">Credit Limit (Optional)</Label>
                <Input
                  id="key-limit"
                  onChange={(e) => setNewKeyLimit(e.target.value)}
                  placeholder="e.g. 50 or $50"
                  value={newKeyLimit}
                />
              </div>
            </div>
            <DialogFooter>
              <Button disabled={isPending} onClick={() => setIsCreateDialogOpen(false)} variant="outline">
                Cancel
              </Button>
              <Button disabled={!newKeyName.trim() || isPending} onClick={handleCreateKey}>
                {isPending ? "Creating..." : "Create Key"}
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
                  <TableHead className="text-xs font-medium">Credit Limit</TableHead>
                  <TableHead className="text-xs font-medium">Usage</TableHead>
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
                          {/* No secondary line now; rate limit displayed in column */}
                        </div>
                        <div className="flex items-center gap-2">
                          <code className="rounded-sm bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                            {apiKey.key
                              ? formatKey(apiKey.key)
                              : `${apiKey.prefix ?? "sk"}...${apiKey.start ?? "xxxx"}`}
                          </code>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">{apiKey.limit}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm font-medium">{apiKey.usage}</span>
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
          {hasKeys && (
            <div className="flex items-center justify-end px-4 py-2">
              <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
                Total Usage: <span className="font-medium text-foreground">{`$${totalUsage.toFixed(3)} used`}</span>
              </span>
            </div>
          )}
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
            <DialogDescription>Update the display name or credit (spend) limit for this key.</DialogDescription>
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
            <div className="space-y-2">
              <Label htmlFor="edit-key-limit">Credit Limit (Optional)</Label>
              <Input
                id="edit-key-limit"
                onChange={(e) => setNewKeyLimit(e.target.value)}
                placeholder="e.g. 50 or $50"
                value={newKeyLimit}
              />
            </div>
          </div>
          <DialogFooter>
            <Button disabled={isPending} onClick={() => setIsEditDialogOpen(false)} variant="outline">
              Cancel
            </Button>
            <Button disabled={!newKeyName.trim() || isPending} onClick={handleSaveEdit}>
              {isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function formatApiKeyData(key: BetterAuthApiKey): ApiKeyRecord {
  return {
    createdAt: key.createdAt,
    enabled: key.enabled,
    id: key.id,
    key: key.key, // Only available on creation
    lastRequest: key.lastRequest ?? null,
    lastUsed: key.lastUsed ?? null,
    limit: "Unlimited", // TODO: Add credit limit logic
    name: key.name,
    prefix: key.prefix,
    requestCount: key.requestCount ?? 0,
    start: key.start,
    usage: key.requestCount ? `${key.requestCount} requests` : "$0 used", // Show request count if available
  };
}
