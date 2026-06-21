import { createFileRoute } from "@tanstack/react-router";
import { ExternalLink, FileText, Settings } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";

export const Route = createFileRoute("/app/settings/credits")({
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

function CreditsComponent() {
  const [currentPage, setCurrentPage] = useState(1);

  const currentBalance = "$12.26";

  return (
    <div className="mx-auto w-full max-w-3xl min-w-0 flex-1 space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-bold text-foreground">Credits</h1>
      </div>

      {/* Current Balance */}
      <Card className="w-full border-border/50 bg-card/50 backdrop-blur-sm">
        <CardContent className="p-6">
          <div className="text-4xl font-bold text-foreground">{currentBalance}</div>
        </CardContent>
      </Card>

      {/* Main Actions Grid */}
      <div className="grid w-full grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Buy Credits */}
        <Card className="w-full border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg font-semibold">Buy Credits</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button className="w-full" size="lg">
              Add Credits
            </Button>
            <Button className="w-full text-sm text-muted-foreground hover:text-foreground" variant="ghost">
              View Usage <ExternalLink className="ml-1 size-3" />
            </Button>
          </CardContent>
        </Card>

        {/* Auto Top-Up */}
        <Card className="w-full border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg font-semibold">Auto Top-Up</CardTitle>
              <div className="flex items-center gap-2">
                <Settings className="size-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Enable</span>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Automatically purchase credits when your balance is below a certain threshold. Your most recent payment
              method will be used.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Transactions */}
      <Card className="w-full border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg font-semibold">Recent Transactions</CardTitle>
            <Button className="text-sm text-muted-foreground hover:text-foreground" variant="ghost">
              Payment History <ExternalLink className="ml-1 size-3" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {recentTransactions.map((transaction) => (
              <div
                className="flex items-center justify-between border-b border-border/20 py-2 last:border-b-0"
                key={transaction.id}
              >
                <span className="text-sm text-muted-foreground">{transaction.time}</span>
                <div className="flex items-center gap-4">
                  <span className="text-sm font-medium text-primary">{transaction.amount}</span>
                  <span className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline">
                    Get Invoice <FileText className="size-3" />
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
  );
}
