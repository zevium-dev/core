import { Link } from "@tanstack/react-router";

import { DocsCodeBlock } from "#/components/docs-code-block";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import {
  API_KEY_PLACEHOLDER,
  buildClaudeCodeInstall,
  buildCodexConfigSnippet,
  buildCursorInstallUrl,
  buildMcpConfigSnippet,
  mcpEndpointUrl,
} from "#/lib/landing";

/** One install surface shared by landing, docs, and listing agent panels. */
export function AgentInstall({ gatewayOrigin }: { gatewayOrigin: string }) {
  const mcpUrl = mcpEndpointUrl(gatewayOrigin);
  return (
    <Card className="not-prose min-w-0">
      <CardHeader>
        <CardTitle>Connect your agent</CardTitle>
        <CardDescription>
          Replace <code>{API_KEY_PLACEHOLDER}</code> with your key from{" "}
          <Link to="/app/settings/keys" className="underline">
            Settings → Keys
          </Link>
          . Calls use your organization’s prepaid wallet.
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0">
        <Tabs defaultValue="claude-code">
          <TabsList
            aria-label="Agent client"
            className="max-w-full flex-wrap h-auto"
          >
            <TabsTrigger value="claude-code">Claude Code</TabsTrigger>
            <TabsTrigger value="cursor">Cursor</TabsTrigger>
            <TabsTrigger value="codex">Codex</TabsTrigger>
          </TabsList>
          <TabsContent value="claude-code" className="min-w-0">
            <p className="text-sm text-muted-foreground">
              Copy this command, replace the placeholder, and run it in your
              terminal.
            </p>
            <DocsCodeBlock
              lang="bash"
              code={buildClaudeCodeInstall(mcpUrl)}
              copyLabel="Copy Claude Code command"
            />
          </TabsContent>
          <TabsContent value="cursor" className="min-w-0">
            <p className="mb-3 text-sm text-muted-foreground">
              Install in Cursor, then replace the placeholder in its MCP
              settings. Or merge this JSON into <code>.cursor/mcp.json</code>.
            </p>
            <Button asChild variant="outline" size="sm">
              <a href={buildCursorInstallUrl(mcpUrl)}>Install in Cursor</a>
            </Button>
            <DocsCodeBlock
              lang="json"
              code={buildMcpConfigSnippet(mcpUrl)}
              copyLabel="Copy Cursor config"
            />
          </TabsContent>
          <TabsContent value="codex" className="min-w-0">
            <p className="text-sm text-muted-foreground">
              Add this to <code>~/.codex/config.toml</code>, replace the
              placeholder, then restart Codex.
            </p>
            <DocsCodeBlock
              lang="toml"
              code={buildCodexConfigSnippet(mcpUrl)}
              copyLabel="Copy Codex config"
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
