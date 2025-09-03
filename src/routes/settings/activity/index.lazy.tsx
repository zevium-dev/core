import { createLazyFileRoute } from '@tanstack/react-router'
import { Calendar, Download, Filter, MoreHorizontal } from 'lucide-react'
import { useState } from 'react'

import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Input } from '~/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { cn } from '~/lib/utils'

export const Route = createLazyFileRoute('/settings/activity/')({
  component: ActivityComponent,
})

// Mock data for the activity table
const mockActivityData = [
  {
    id: 1,
    timestamp: 'Aug 20, 08:40',
    provider: 'Kimi k2',
    app: 'Kortix AI',
    tokens: '37,811',
    tokenDetail: '67',
    cost: '$',
    speed: '0.038',
    speedUnit: '11.2 tps',
    finish: 'stop'
  },
  {
    id: 2,
    timestamp: 'Aug 17, 07:40',
    provider: 'Kimi k2',
    app: 'Kortix AI',
    tokens: '37,890',
    tokenDetail: '26',
    cost: '$',
    speed: '0.038',
    speedUnit: '12.8 tps',
    finish: 'stop'
  },
  {
    id: 3,
    timestamp: 'Aug 17, 05:44',
    provider: 'Kimi k2',
    app: 'Kortix AI',
    tokens: '37,907',
    tokenDetail: '24',
    cost: '$',
    speed: '0.038',
    speedUnit: '9.2 tps',
    finish: 'stop'
  },
  {
    id: 4,
    timestamp: 'Aug 17, 05:44',
    provider: 'Kimi k2',
    app: 'Kortix AI',
    tokens: '37,878',
    tokenDetail: '21',
    cost: '$',
    speed: '0.0379',
    speedUnit: '18.4 tps',
    finish: 'stop'
  },
  {
    id: 5,
    timestamp: 'Aug 17, 04:23',
    provider: 'Kimi k2',
    app: 'Kortix AI',
    tokens: '37,836',
    tokenDetail: '18',
    cost: '$',
    speed: '0.0379',
    speedUnit: '22.8 tps',
    finish: 'stop'
  },
  {
    id: 6,
    timestamp: 'Aug 16, 03:57',
    provider: 'Kimi k2',
    app: 'Kortix AI',
    tokens: '37,814',
    tokenDetail: '105',
    cost: '$',
    speed: '0.0381',
    speedUnit: '3.0 tps',
    finish: 'stop'
  },
  {
    id: 7,
    timestamp: 'Aug 16, 03:50',
    provider: 'Claude Sonnet 4',
    app: 'Intel LM',
    tokens: '33,338',
    tokenDetail: '125',
    cost: '$',
    speed: '0.127',
    speedUnit: '42.7 tps',
    finish: 'stop'
  },
  {
    id: 8,
    timestamp: 'Aug 15, 11:40',
    provider: 'Claude Sonnet 4',
    app: 'Intel LM',
    tokens: '37,337',
    tokenDetail: '90',
    cost: '$',
    speed: '0.126',
    speedUnit: '52.8 tps',
    finish: 'stop'
  }
]

// Mock chart data
const chartData = {
  spend: {
    avgDay: '$0.0254',
    pastMonth: '$0.797',
    data: [
      { day: 1, value: 20 },
      { day: 2, value: 45 },
      { day: 3, value: 30 },
      { day: 4, value: 60 },
      { day: 5, value: 80 },
      { day: 6, value: 100 },
      { day: 7, value: 45 }
    ]
  },
  tokens: {
    avgDay: '15K',
    pastMonth: '468K',
    data: [
      { day: 1, value: 15 },
      { day: 2, value: 25 },
      { day: 3, value: 35 },
      { day: 4, value: 50 },
      { day: 5, value: 70 },
      { day: 6, value: 100 },
      { day: 7, value: 40 }
    ]
  },
  requests: {
    avgDay: '0.419',
    pastMonth: '13',
    data: [
      { day: 1, value: 10 },
      { day: 2, value: 30 },
      { day: 3, value: 25 },
      { day: 4, value: 45 },
      { day: 5, value: 60 },
      { day: 6, value: 100 },
      { day: 7, value: 35 }
    ]
  }
}

function MiniChart({ data, color = 'bg-blue-500' }: { data: { day: number; value: number }[]; color?: string }) {
  const maxValue = Math.max(...data.map(d => d.value))
  
  return (
    <div className="flex items-end gap-1 h-16 mt-4">
      {data.map((item, index) => (
        <div
          key={index}
          className={cn(
            'flex-1 rounded-t-sm transition-all hover:opacity-80',
            color
          )}
          style={{
            height: `${(item.value / maxValue) * 100}%`,
            minHeight: '4px'
          }}
        />
      ))}
    </div>
  )
}

function ActivityStatsCard({ title, avgDay, pastMonth, data, color }: {
  title: string
  avgDay: string
  pastMonth: string
  data: { day: number; value: number }[]
  color: string
}) {
  return (
    <Card className="bg-card/50 backdrop-blur-sm border-border/50">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
          <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <MiniChart data={data} color={color} />
        <div className="mt-4 space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Avg Day</span>
            <span className="font-medium">{avgDay}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Past Month</span>
            <span className="font-medium">{pastMonth}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function ActivityComponent() {
  const [dateFrom, setDateFrom] = useState('04-08-2025')
  const [dateTo, setDateTo] = useState('03-09-2025')
  const [timeFilter, setTimeFilter] = useState('1 Month')

  return (
    <div className="min-h-screen bg-background p-6 space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-2xl font-bold text-foreground">Your Activity</h1>
        <p className="text-sm text-muted-foreground">
          Usage across models on OpenRouter. Privacy ℹ️
        </p>
      </div>

      {/* Time Filter */}
      <div className="flex justify-end">
        <Select value={timeFilter} onValueChange={setTimeFilter}>
          <SelectTrigger className="w-32 bg-background border-border">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1 Week">1 Week</SelectItem>
            <SelectItem value="1 Month">1 Month</SelectItem>
            <SelectItem value="3 Months">3 Months</SelectItem>
            <SelectItem value="6 Months">6 Months</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <ActivityStatsCard
          title="Spend"
          avgDay={chartData.spend.avgDay}
          pastMonth={chartData.spend.pastMonth}
          data={chartData.spend.data}
          color="bg-blue-500"
        />
        <ActivityStatsCard
          title="Tokens"
          avgDay={chartData.tokens.avgDay}
          pastMonth={chartData.tokens.pastMonth}
          data={chartData.tokens.data}
          color="bg-green-500"
        />
        <ActivityStatsCard
          title="Requests"
          avgDay={chartData.requests.avgDay}
          pastMonth={chartData.requests.pastMonth}
          data={chartData.requests.data}
          color="bg-blue-400"
        />
      </div>

      {/* Filters and Table */}
      <Card className="bg-card/50 backdrop-blur-sm border-border/50">
        <CardHeader>
          <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
            <div className="flex gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">From:</span>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="w-auto text-xs"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">To:</span>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="w-auto text-xs"
                />
              </div>
            </div>
            
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="gap-2">
                <Filter className="h-4 w-4" />
                Filters
              </Button>
              <Button variant="outline" size="sm" className="gap-2">
                <Download className="h-4 w-4" />
                Export
              </Button>
            </div>
          </div>
        </CardHeader>
        
        <CardContent>
          <div className="rounded-md border border-border/50 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30">
                  <TableHead className="text-xs font-medium">Timestamp</TableHead>
                  <TableHead className="text-xs font-medium">Provider / Model</TableHead>
                  <TableHead className="text-xs font-medium">App</TableHead>
                  <TableHead className="text-xs font-medium">Tokens</TableHead>
                  <TableHead className="text-xs font-medium">Cost</TableHead>
                  <TableHead className="text-xs font-medium">Speed</TableHead>
                  <TableHead className="text-xs font-medium">Finish</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mockActivityData.map((activity) => (
                  <TableRow key={activity.id} className="hover:bg-muted/20">
                    <TableCell className="text-xs text-muted-foreground">
                      {activity.timestamp}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-4 bg-muted rounded-sm flex-shrink-0" />
                        <span className="text-xs font-medium text-primary hover:underline cursor-pointer">
                          {activity.provider}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <span className="text-xs">{activity.app}</span>
                        <Button variant="ghost" size="sm" className="h-4 w-4 p-0">
                          <span className="text-xs text-primary">🔗</span>
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <span className="text-xs font-medium">{activity.tokens}</span>
                        <Badge variant="secondary" className="text-xs px-1">
                          {activity.tokenDetail}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">{activity.cost}</TableCell>
                    <TableCell>
                      <div className="space-y-0.5">
                        <div className="text-xs font-medium">{activity.speed}</div>
                        <div className="text-xs text-muted-foreground">{activity.speedUnit}</div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {activity.finish}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          
          {/* Pagination */}
          <div className="flex items-center justify-center gap-2 mt-4">
            <Button variant="outline" size="sm" disabled>
              ←
            </Button>
            <Button variant="default" size="sm">
              1
            </Button>
            <Button variant="outline" size="sm">
              2
            </Button>
            <span className="text-xs text-muted-foreground">...</span>
            <Button variant="outline" size="sm">
              →
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
