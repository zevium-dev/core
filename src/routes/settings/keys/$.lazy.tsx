import { createLazyFileRoute } from "@tanstack/react-router";
import { Copy, Info, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
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
import { Textarea } from "~/components/ui/textarea";
import { useCopy } from "~/hooks/use-copy";

// Types
interface ApiKeyRecord {
  id: number;
  key: string; // full key value
  name: string;
  limit: string; // e.g. "Unlimited" or custom string
  usage: string; // formatted usage string
  createdAt: string;
  lastUsed: string;
  description?: string;
}

// Cast path to any until routeTree regeneration includes /settings/keys/$
export const Route = createLazyFileRoute("/settings/keys/$" as any)({
  component: ApiKeysComponent,
});

// TODO: Replace with API call to fetch real API keys data
// Mock data for the API keys table
const mockApiKeysData: ApiKeyRecord[] = [
  {
    id: 1,
    key: "sk-or-v1-e97b8f0d91c7a6c54",
  name: "Internal Jira Bot",
    limit: "Unlimited",
    usage: "$0 used",
    createdAt: "2024-08-15",
    lastUsed: "2024-09-01",
  },
  {
    id: 2,
    key: "sk-or-v1-4b6d9a7217bd0f417b",
  name: "Desktop Client (Win)",
    limit: "Unlimited",
    usage: "$2.836 used",
    createdAt: "2024-07-20",
    lastUsed: "2024-09-08",
  },
  {
    id: 3,
    key: "sk-or-v1-da3be50aa9293f25d61",
  name: "Domain Filter Service",
    limit: "Unlimited",
    usage: "$8.293 used",
    createdAt: "2024-06-10",
    lastUsed: "2024-09-09",
  },
  {
    id: 4,
    key: "sk-or-v1-23ef10b19bb176462ee",
  name: "OAuth: Roo Prod App",
    limit: "Unlimited",
    usage: "$10.36 used",
    createdAt: "2024-05-25",
    lastUsed: "2024-09-07",
  },
  {
    id: 5,
    key: "sk-or-v1-667af09c1834d9289a5",
  name: "PathOfFate Game",
    limit: "Unlimited",
    usage: "$0 used",
    createdAt: "2024-04-12",
    lastUsed: "Never",
  },
];

export function ApiKeysComponent() {
  // State
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>(mockApiKeysData);
  // Keys are never fully viewable again after creation
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<ApiKeyRecord | null>(null);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyDescription, setNewKeyDescription] = useState("");
  const [, copy] = useCopy();

  // Helpers

  const handleCreateKey = () => {
    // TODO: Replace with API call
    const newKey: ApiKeyRecord = {
      id: Date.now(),
      key: `sk-or-v1-${Math.random().toString(36).slice(2, 18)}`,
      name: newKeyName.trim(),
      limit: "Unlimited",
      usage: "$0 used",
      createdAt: new Date().toISOString().slice(0, 10),
      lastUsed: "Never",
      description: newKeyDescription.trim() || undefined,
    };
    setApiKeys((prev) => [newKey, ...prev]);
    setNewKeyName("");
    setNewKeyDescription("");
    setIsCreateDialogOpen(false);
  };

  const handleCopyKey = async (value: string) => {
    await copy(value);
  };

  const handleDeleteKey = (keyId: number) => {
    // TODO: Replace with API call
    setApiKeys((prev) => prev.filter((k) => k.id !== keyId));
  };

  const openEditDialog = (record: ApiKeyRecord) => {
    setEditingKey(record);
    setNewKeyName(record.name);
    setNewKeyDescription(record.description || "");
    setIsEditDialogOpen(true);
  };

  const handleSaveEdit = () => {
    if (!editingKey) return;
    setApiKeys((prev) =>
      prev.map((k) =>
        k.id === editingKey.id
          ? { ...k, name: newKeyName.trim() || k.name, description: newKeyDescription.trim() || undefined }
          : k,
      ),
    );
    setIsEditDialogOpen(false);
    setEditingKey(null);
    setNewKeyName("");
    setNewKeyDescription("");
  };

  const formatKey = (key: string) => {
    // Permanent mask: show prefix identifier & last 4
    const first = key.slice(0, 8);
    const last = key.slice(-4);
    return `${first}…${last}`;
  };

  const hasKeys = apiKeys.length > 0;
  const totalUsage = useMemo(() => apiKeys.reduce((acc, k) => acc + (parseFloat(k.usage.replace(/[^0-9.]/g, "")) || 0), 0), [apiKeys]);
  const snippet = `curl -X POST https://openrouter.ai/api/v1/chat/completions \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer YOUR_API_KEY' \\
  -d '{\n    "model": "openai/gpt-4o-mini",\n    "messages": [{"role":"user","content":"Explain how AI works in a few words"}]\n  }'`;

  return (
    <div className="mx-auto w-full max-w-3xl min-w-0 flex-1 space-y-6 p-6">
  {/* (Optional) Settings navigation placeholder – removed due to missing component */}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <h1 className="text-foreground text-2xl font-bold">API Keys</h1>
          <div className="flex items-center gap-2">
            <p className="text-muted-foreground text-sm">
              Manage your API keys to access all models from OpenRouter
            </p>
            <Info className="text-muted-foreground h-4 w-4" />
          </div>
        </div>

        {/* Create API Key Button */}
        <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
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
                Create a new API key to access OpenRouter models. Keep your key secure and never share it publicly.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="key-name">Key Name</Label>
                <Input
                  id="key-name"
                  placeholder="Enter a name for your API key"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="key-description">Description (Optional)</Label>
                <Textarea
                  id="key-description"
                  placeholder="Describe what this key will be used for"
                  rows={3}
                  value={newKeyDescription}
                  onChange={(e) => setNewKeyDescription(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreateKey} disabled={!newKeyName.trim()}>
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
                  <TableHead className="text-xs font-medium">Limit</TableHead>
                  <TableHead className="text-xs font-medium">Usage</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!hasKeys && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center py-10">
                      <div className="flex flex-col items-center gap-2">
                        <span className="text-muted-foreground text-sm">No API keys yet.</span>
                        <Button size="sm" onClick={() => setIsCreateDialogOpen(true)} className="gap-2">
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
                          {apiKey.description && (
                            <span className="text-muted-foreground truncate text-[10px]">{apiKey.description}</span>
                          )}
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
                          <Button size="sm" variant="ghost" className="h-8 w-8 p-0">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40">
                          <DropdownMenuItem onClick={() => openEditDialog(apiKey)} className="gap-2">
                            <Pencil className="h-4 w-4" /> Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleDeleteKey(apiKey.id)} className="gap-2 text-red-500">
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
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => handleCopyKey(snippet)}
            >
              <Copy className="mr-1 h-3 w-3" /> Copy
            </Button>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="relative">
              <pre className="bg-muted/50 border-border/50 font-mono text-xs whitespace-pre overflow-x-auto rounded-md border p-4 leading-relaxed">
  {snippet}
              </pre>
              <p className="text-muted-foreground mt-2 text-[11px]">Replace <code className="font-mono">YOUR_API_KEY</code> with one of the keys above.</p>
            </div>
          </CardContent>
        </Card>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit API Key</DialogTitle>
            <DialogDescription>Update the display name or description of this key.</DialogDescription>
          </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-key-name">Key Name</Label>
                <Input
                  id="edit-key-name"
                  placeholder="Key name"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-key-description">Description (Optional)</Label>
                <Textarea
                  id="edit-key-description"
                  placeholder="Description"
                  rows={3}
                  value={newKeyDescription}
                  onChange={(e) => setNewKeyDescription(e.target.value)}
                />
              </div>
            </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveEdit} disabled={!newKeyName.trim()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}