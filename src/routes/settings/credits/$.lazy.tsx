import { createLazyFileRoute } from '@tanstack/react-router'
import { Settings, ExternalLink, FileText } from 'lucide-react'
import { useState } from 'react'

import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'

export const Route = createLazyFileRoute('/settings/credits/$')({
  component: CreditsComponent,
})

// TODO: Replace with API call to fetch real credits data
// Mock data for recent transactions
const recentTransactions = [
  {
    id: 1,
    time: '2 months ago',
    amount: '$10',
  },
  {
    id: 2,
    time: '2 months ago',
    amount: '$3.75',
  },
  {
    id: 3,
    time: '4 months ago',
    amount: '$10',
  }
]

export function CreditsComponent() {
  const [autoTopUpEnabled, setAutoTopUpEnabled] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  
  const currentBalance = '$12.26'

  return (
  <div className="flex-1 w-full min-w-0 max-w-3xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-bold text-foreground">Credits</h1>
      </div>

      {/* Current Balance */}
      <Card className="bg-card/50 backdrop-blur-sm border-border/50 w-full">
        <CardContent className="p-6">
          <div className="text-4xl font-bold text-foreground">{currentBalance}</div>
        </CardContent>
      </Card>

      {/* Main Actions Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 w-full">
        {/* Buy Credits */}
        <Card className="bg-card/50 backdrop-blur-sm border-border/50 w-full">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg font-semibold">Buy Credits</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button className="w-full" size="lg">
              Add Credits
            </Button>
            <Button variant="ghost" className="w-full text-sm text-muted-foreground hover:text-foreground">
              View Usage <ExternalLink className="h-3 w-3 ml-1" />
            </Button>
          </CardContent>
        </Card>

        {/* Auto Top-Up */}
        <Card className="bg-card/50 backdrop-blur-sm border-border/50 w-full">
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg font-semibold">Auto Top-Up</CardTitle>
              <div className="flex items-center gap-2">
                <Settings className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Enable</span>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Automatically purchase credits when your balance is below a certain threshold. 
              Your most recent payment method will be used.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Transactions */}
      <Card className="bg-card/50 backdrop-blur-sm border-border/50 w-full">
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg font-semibold">Recent Transactions</CardTitle>
            <Button variant="ghost" className="text-sm text-muted-foreground hover:text-foreground">
              Payment History <ExternalLink className="h-3 w-3 ml-1" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {recentTransactions.map((transaction) => (
              <div key={transaction.id} className="flex items-center justify-between py-2 border-b border-border/20 last:border-b-0">
                <span className="text-sm text-muted-foreground">{transaction.time}</span>
                <div className="flex items-center gap-4">
                  <span className="text-sm font-medium text-primary">{transaction.amount}</span>
                  <span className="text-xs text-muted-foreground hover:text-foreground cursor-pointer hover:underline flex items-center gap-1">
                    Get Invoice <FileText className="h-3 w-3" />
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-center gap-2 mt-6">
            <Button 
              variant="ghost" 
              size="sm" 
              disabled={currentPage === 1}
              onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
              className="text-muted-foreground"
            >
              ‹
            </Button>
            <Button 
              variant="ghost"
              size="sm"
              className="bg-muted text-foreground"
            >
              {currentPage}
            </Button>
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={() => setCurrentPage(prev => prev + 1)}
              className="text-muted-foreground"
            >
              ›
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
