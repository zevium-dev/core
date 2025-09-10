import { createLazyFileRoute } from "@tanstack/react-router";
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

// Types
interface ApiKeyRecord {
  createdAt: string;
  id: number;
  key: string; // full key value
  lastUsed: string;
  limit: string; // e.g. "Unlimited" or custom string like "1000 req/day"
  name: string;
  usage: string; // formatted usage string
}

export const Route = createLazyFileRoute("/settings/keys/$")({
  component: ApiKeysComponent,
});

// TODO: Replace with API call to fetch real API keys data
// Mock data for the API keys table
const mockApiKeysData: Array<ApiKeyRecord> = [
  {
    createdAt: "2024-08-15",
    id: 1,
    key: "sk-or-v1-e97b8f0d91c7a6c54",
  lastUsed: "2024-09-01",
  limit: "Unlimited",
    name: "Internal Jira Bot",
    usage: "$12.40 used",
  },
  {
    createdAt: "2024-07-20",
    id: 2,
    key: "sk-or-v1-4b6d9a7217bd0f417b",
  lastUsed: "2024-09-08",
  limit: "$200",
    name: "Desktop Client (Win)",
    usage: "$45.82 used",
  },
  {
    createdAt: "2024-06-10",
    id: 3,
    key: "sk-or-v1-da3be50aa9293f25d61",
  lastUsed: "2024-09-09",
  limit: "Unlimited",
    name: "Domain Filter Service",
    usage: "$8.293 used",
  },
  {
    createdAt: "2024-05-25",
    id: 4,
    key: "sk-or-v1-23ef10b19bb176462ee",
  lastUsed: "2024-09-07",
  limit: "Unlimited",
    name: "OAuth: Roo Prod App",
    usage: "$210.36 used",
  },
  {
    createdAt: "2024-04-12",
    id: 5,
    key: "sk-or-v1-667af09c1834d9289a5",
  lastUsed: "Never",
  limit: "$10",
    name: "PathOfFate Game",
    usage: "$0 used",
  },
];

export function ApiKeysComponent() {
  // State
  const [apiKeys, setApiKeys] = useState<Array<ApiKeyRecord>>(mockApiKeysData);
  // Keys are never fully viewable again after creation
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<ApiKeyRecord | null>(null);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyLimit, setNewKeyLimit] = useState(""); // user input for credit limit (money)
  const [, copy] = useCopy();

  // Helpers

  const handleCreateKey = () => {
    // TODO: Replace with API call
    const formattedLimit = formatLimit(newKeyLimit);
    const newKey: ApiKeyRecord = {
      createdAt: new Date().toISOString().slice(0, 10),
      id: Date.now(),
      key: `sk-or-v1-${Math.random().toString(36).slice(2, 18)}`,
      lastUsed: "Never",
      limit: formattedLimit,
      name: newKeyName.trim(),
      usage: "$0 used",
    };
    setApiKeys((prev) => [newKey, ...prev]);
    setNewKeyName("");
    setNewKeyLimit("");
    setIsCreateDialogOpen(false);
  };

  const handleCopyKey = (value: string) => {
    copy(value);
  };

  const handleDeleteKey = (keyId: number) => {
    // TODO: Replace with API call
    setApiKeys((prev) => prev.filter((k) => k.id !== keyId));
  };

  const openEditDialog = (record: ApiKeyRecord) => {
    setEditingKey(record);
  setNewKeyName(record.name);
  setNewKeyLimit(record.limit === "Unlimited" ? "" : record.limit.replace(/^[^0-9$]*/, ""));
    setIsEditDialogOpen(true);
  };

  const handleSaveEdit = () => {
    if (!editingKey) return;
    setApiKeys((prev) =>
      prev.map((k) =>
        k.id === editingKey.id
          ? { ...k, limit: formatLimit(newKeyLimit), name: newKeyName.trim() || k.name }
          : k,
      ),
    );
    setIsEditDialogOpen(false);
    setEditingKey(null);
    setNewKeyName("");
    setNewKeyLimit("");
  };

  const formatKey = (key: string) => {
    // Permanent mask: show prefix identifier & last 4
    const first = key.slice(0, 8);
    const last = key.slice(-4);
    return `${first}…${last}`;
  };

  const hasKeys = apiKeys.length > 0;
  const totalUsage = useMemo(() => apiKeys.reduce((acc, k) => acc + (parseFloat(k.usage.replace(/[^0-9.]/g, "")) || 0), 0), [apiKeys]);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const formatLimit = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return "Unlimited";
    // accept forms like 50, $50, 50.25, $50.25
    const match = /\$?([0-9]+(?:\.[0-9]{1,2})?)/.exec(trimmed);
    if (!match) return "Unlimited"; // fallback if invalid
    return `$${match[1]}`;
  };
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
          <h1 className="text-foreground text-2xl font-bold">API Keys</h1>
          <div className="flex items-center gap-2">
            <p className="text-muted-foreground text-sm">
              Manage your API keys to access all Zevium-integrated APIs
            </p>
            <Info className="text-muted-foreground h-4 w-4" />
          </div>
        </div>

        {/* Create API Key Button */}
        <Dialog onOpenChange={setIsCreateDialogOpen} open={isCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="h-4 w-4" />
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
              <Button onClick={() => setIsCreateDialogOpen(false)} variant="outline">
                Cancel
              </Button>
              <Button disabled={!newKeyName.trim()} onClick={handleCreateKey}>
                Create Key
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* API Keys Table */}
      <Card className="bg-card/50 border-border/50 backdrop-blur-sm">
        <CardContent className="p-0">
          <div className="border-border/50 overflow-hidden rounded-md border">
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
                    <TableCell className="text-center py-10" colSpan={4}>
                      <div className="flex flex-col items-center gap-2">
                        <span className="text-muted-foreground text-sm">No API keys yet.</span>
                        <Button className="gap-2" onClick={() => setIsCreateDialogOpen(true)} size="sm">
                          <Plus className="h-4 w-4" /> Create your first key
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
                          <code className="bg-muted text-muted-foreground text-xs font-mono px-2 py-1 rounded">
                            {formatKey(apiKey.key)}
                          </code>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-muted-foreground text-sm">{apiKey.limit}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm font-medium">{apiKey.usage}</span>
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button className="h-8 w-8 p-0" size="sm" variant="ghost">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40">
                          <DropdownMenuItem className="gap-2" onClick={() => openEditDialog(apiKey)}>
                            <Pencil className="h-4 w-4" /> Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem className="gap-2 text-red-500" onClick={() => handleDeleteKey(apiKey.id)}>
                            <Trash2 className="h-4 w-4" /> Delete
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
              <span className="text-muted-foreground text-[10px] uppercase tracking-wide">
                Total Usage: <span className="font-medium text-foreground">${totalUsage.toFixed(3)} used</span>
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Quick Start Snippet */}
      <Card className="bg-card/50 border-border/50 backdrop-blur-sm">
        <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm font-medium">Quick Start (cURL)</CardTitle>
          <Button
            aria-live="polite"
            className="h-7 px-2 text-xs border border-border/40 bg-muted/30 hover:bg-muted/50 dark:hover:bg-muted/60 text-muted-foreground hover:text-foreground data-[copied]:bg-emerald-500/20 data-[copied]:text-emerald-500 data-[copied]:hover:bg-emerald-500/30 transition-colors"
            data-copied={snippetCopied || undefined}
            onClick={handleCopySnippet}
            size="sm"
            title={snippetCopied ? "Copied" : "Copy snippet"}
            variant="ghost"
          >
            {snippetCopied ? <Check className="mr-1 h-3 w-3" /> : <Copy className="mr-1 h-3 w-3" />} {snippetCopied ? "Copied" : "Copy"}
          </Button>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="relative">
            <pre className="bg-muted/50 border-border/50 font-mono text-xs whitespace-pre overflow-x-auto rounded-md border p-4 leading-relaxed selection:bg-primary/30 selection:text-primary-foreground">{snippet}</pre>
            <p className="text-muted-foreground mt-2 text-[11px]">
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
            <Button onClick={() => setIsEditDialogOpen(false)} variant="outline">Cancel</Button>
            <Button disabled={!newKeyName.trim()} onClick={handleSaveEdit}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}