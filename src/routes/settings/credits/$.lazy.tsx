import { createLazyFileRoute } from "@tanstack/react-router";
import { ExternalLink, FileText, Settings } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { ProtectedRoute } from "~/components/protected-route";

export const Route = createLazyFileRoute("/settings/credits/$")({
  component: CreditsComponent,
});

// TODO: Replace with API call to fetch real credits data
// Mock data for recent transactions
const recentTransactions = [
  {
    amount: "$10",
    id: 1,
    time: "2 months ago",
  },
  {
    amount: "$3.75",
    id: 2,
    time: "2 months ago",
  },
  {
    amount: "$10",
    id: 3,
    time: "4 months ago",
  },
];

export function CreditsComponent() {
  const [_autoTopUpEnabled, _setAutoTopUpEnabled] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  const currentBalance = "$12.26";

  return (
    <ProtectedRoute>
      <div className="mx-auto w-full max-w-3xl min-w-0 flex-1 space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <h1 className="text-foreground text-2xl font-bold">Credits</h1>
      </div>

      {/* Current Balance */}
      <Card className="bg-card/50 border-border/50 w-full backdrop-blur-sm">
        <CardContent className="p-6">
          <div className="text-foreground text-4xl font-bold">{currentBalance}</div>
        </CardContent>
      </Card>

      {/* Main Actions Grid */}
      <div className="grid w-full grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Buy Credits */}
        <Card className="bg-card/50 border-border/50 w-full backdrop-blur-sm">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg font-semibold">Buy Credits</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button className="w-full" size="lg">
              Add Credits
            </Button>
            <Button className="text-muted-foreground hover:text-foreground w-full text-sm" variant="ghost">
              View Usage <ExternalLink className="ml-1 h-3 w-3" />
            </Button>
          </CardContent>
        </Card>

        {/* Auto Top-Up */}
        <Card className="bg-card/50 border-border/50 w-full backdrop-blur-sm">
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg font-semibold">Auto Top-Up</CardTitle>
              <div className="flex items-center gap-2">
                <Settings className="text-muted-foreground h-4 w-4" />
                <span className="text-muted-foreground text-sm">Enable</span>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">
              Automatically purchase credits when your balance is below a certain threshold. Your most recent payment
              method will be used.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Transactions */}
      <Card className="bg-card/50 border-border/50 w-full backdrop-blur-sm">
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg font-semibold">Recent Transactions</CardTitle>
            <Button className="text-muted-foreground hover:text-foreground text-sm" variant="ghost">
              Payment History <ExternalLink className="ml-1 h-3 w-3" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {recentTransactions.map((transaction) => (
              <div
                className="border-border/20 flex items-center justify-between border-b py-2 last:border-b-0"
                key={transaction.id}
              >
                <span className="text-muted-foreground text-sm">{transaction.time}</span>
                <div className="flex items-center gap-4">
                  <span className="text-primary text-sm font-medium">{transaction.amount}</span>
                  <span className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1 text-xs hover:underline">
                    Get Invoice <FileText className="h-3 w-3" />
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          <div className="mt-6 flex items-center justify-center gap-2">
            <Button
              className="text-muted-foreground"
              disabled={currentPage === 1}
              onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
              size="sm"
              variant="ghost"
            >
              ‹
            </Button>
            <Button className="bg-muted text-foreground" size="sm" variant="ghost">
              {currentPage}
            </Button>
            <Button
              className="text-muted-foreground"
              onClick={() => setCurrentPage((prev) => prev + 1)}
              size="sm"
              variant="ghost"
            >
              ›
            </Button>
          </div>
        </CardContent>
      </Card>
      </div>
    </ProtectedRoute>
  );
}
