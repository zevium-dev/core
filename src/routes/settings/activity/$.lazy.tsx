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

export const Route = createLazyFileRoute('/settings/activity/$')({
  component: ActivityComponent,
})

// TODO: Replace with API call to fetch real activity data
// Mock data for the activity table
const mockActivityData = [
  {
    id: 1,
    timestamp: 'Aug 20, 08:40',
    api: 'Weather API',
    provider: 'OpenWeather',
    requests: '1,250',
    dataTransfer: '2.4 MB',
    cost: '$0.15',
    responseTime: '125ms',
    status: 'success'
  },
  {
    id: 2,
    timestamp: 'Aug 17, 07:40',
    api: 'Maps API',
    provider: 'Google Maps',
    requests: '890',
    dataTransfer: '5.2 MB',
    cost: '$0.42',
    responseTime: '89ms',
    status: 'success'
  },
  {
    id: 3,
    timestamp: 'Aug 17, 05:44',
    api: 'Payment Gateway',
    provider: 'Stripe',
    requests: '156',
    dataTransfer: '0.8 MB',
    cost: '$0.08',
    responseTime: '245ms',
    status: 'success'
  },
  {
    id: 4,
    timestamp: 'Aug 17, 05:44',
    api: 'SMS API',
    provider: 'Twilio',
    requests: '45',
    dataTransfer: '0.1 MB',
    cost: '$0.23',
    responseTime: '156ms',
    status: 'success'
  },
  {
    id: 5,
    timestamp: 'Aug 17, 04:23',
    api: 'Email API',
    provider: 'SendGrid',
    requests: '234',
    dataTransfer: '1.2 MB',
    cost: '$0.12',
    responseTime: '98ms',
    status: 'success'
  },
  {
    id: 6,
    timestamp: 'Aug 16, 03:57',
    api: 'Image Processing',
    provider: 'Cloudinary',
    requests: '89',
    dataTransfer: '15.3 MB',
    cost: '$0.34',
    responseTime: '567ms',
    status: 'success'
  },
  {
    id: 7,
    timestamp: 'Aug 16, 03:50',
    api: 'Database API',
    provider: 'MongoDB Atlas',
    requests: '2,456',
    dataTransfer: '8.7 MB',
    cost: '$0.67',
    responseTime: '45ms',
    status: 'success'
  },
  {
    id: 8,
    timestamp: 'Aug 15, 11:40',
    api: 'Analytics API',
    provider: 'Google Analytics',
    requests: '567',
    dataTransfer: '3.1 MB',
    cost: '$0.19',
    responseTime: '78ms',
    status: 'error'
  },
  {
    id: 9,
    timestamp: 'Aug 14, 09:15',
    api: 'File Storage API',
    provider: 'AWS S3',
    requests: '1,023',
    dataTransfer: '25.7 MB',
    cost: '$0.48',
    responseTime: '234ms',
    status: 'success'
  }
]

// Mock chart data
const chartData = {
  spend: {
    avgDay: '$2.54',
    pastMonth: '$79.70',
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
  requests: {
    avgDay: '1.5K',
    pastMonth: '46.8K',
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
  dataTransfer: {
    avgDay: '41.9MB',
    pastMonth: '1.3GB',
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
  const [currentPage, setCurrentPage] = useState(1)
  
  const itemsPerPage = 8
  const totalPages = Math.ceil(mockActivityData.length / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex = startIndex + itemsPerPage
  const currentItems = mockActivityData.slice(startIndex, endIndex)

  return (
    <div className="min-h-screen bg-background p-6 space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-2xl font-bold text-foreground">API Activity</h1>
        <p className="text-sm text-muted-foreground">
          Your API usage and performance metrics across all integrated services.
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
          title="Requests"
          avgDay={chartData.requests.avgDay}
          pastMonth={chartData.requests.pastMonth}
          data={chartData.requests.data}
          color="bg-green-500"
        />
        <ActivityStatsCard
          title="Data Transfer"
          avgDay={chartData.dataTransfer.avgDay}
          pastMonth={chartData.dataTransfer.pastMonth}
          data={chartData.dataTransfer.data}
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
                  <TableHead className="text-xs font-medium">API / Provider</TableHead>
                  <TableHead className="text-xs font-medium">Requests</TableHead>
                  <TableHead className="text-xs font-medium">Data Transfer</TableHead>
                  <TableHead className="text-xs font-medium">Cost</TableHead>
                  <TableHead className="text-xs font-medium">Response Time</TableHead>
                  <TableHead className="text-xs font-medium">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {currentItems.map((activity) => (
                  <TableRow key={activity.id} className="hover:bg-muted/20">
                    <TableCell className="text-xs text-muted-foreground">
                      {activity.timestamp}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-4 bg-muted rounded-sm flex-shrink-0" />
                        <div className="flex flex-col">
                          <span className="text-xs font-medium text-primary hover:underline cursor-pointer">
                            {activity.api}
                          </span>
                          <span className="text-xs text-muted-foreground">{activity.provider}</span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs font-medium">{activity.requests}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs">{activity.dataTransfer}</span>
                    </TableCell>
                    <TableCell className="text-xs font-medium">{activity.cost}</TableCell>
                    <TableCell>
                      <span className="text-xs">{activity.responseTime}</span>
                    </TableCell>
                    <TableCell>
                      <Badge 
                        variant={activity.status === 'success' ? 'default' : 'destructive'} 
                        className="text-xs"
                      >
                        {activity.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          
          {/* Pagination */}
          <div className="flex items-center justify-center gap-2 mt-4">
            <Button 
              variant="outline" 
              size="sm" 
              disabled={currentPage === 1}
              onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
            >
              ←
            </Button>
            <Button 
              variant={currentPage === 1 ? "default" : "outline"} 
              size="sm"
              onClick={() => setCurrentPage(1)}
            >
              1
            </Button>
            <Button 
              variant={currentPage === 2 ? "default" : "outline"} 
              size="sm"
              onClick={() => setCurrentPage(2)}
            >
              2
            </Button>
            {totalPages > 2 && (
              <span className="text-xs text-muted-foreground">...</span>
            )}
            <Button 
              variant="outline" 
              size="sm" 
              disabled={currentPage === totalPages}
              onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
            >
              →
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
