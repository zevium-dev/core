import { createLazyFileRoute } from "@tanstack/react-router";
import { Download, Filter, MoreHorizontal } from "lucide-react";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { cn } from "~/lib/utils";
import { ProtectedRoute } from "~/components/protected-route";

export const Route = createLazyFileRoute("/settings/activity/$")({
  component: ActivityComponent,
});

// TODO: Replace with API call to fetch real activity data
// Mock data for the activity table
const mockActivityData = [
  {
    api: "Weather API",
    cost: "$0.15",
    dataTransfer: "2.4 MB",
    id: 1,
    provider: "OpenWeather",
    requests: "1,250",
    responseTime: "125ms",
    status: "success",
    timestamp: "Aug 20, 08:40",
  },
  {
    api: "Maps API",
    cost: "$0.42",
    dataTransfer: "5.2 MB",
    id: 2,
    provider: "Google Maps",
    requests: "890",
    responseTime: "89ms",
    status: "success",
    timestamp: "Aug 17, 07:40",
  },
  {
    api: "Payment Gateway",
    cost: "$0.08",
    dataTransfer: "0.8 MB",
    id: 3,
    provider: "Stripe",
    requests: "156",
    responseTime: "245ms",
    status: "success",
    timestamp: "Aug 17, 05:44",
  },
  {
    api: "SMS API",
    cost: "$0.23",
    dataTransfer: "0.1 MB",
    id: 4,
    provider: "Twilio",
    requests: "45",
    responseTime: "156ms",
    status: "success",
    timestamp: "Aug 17, 05:44",
  },
  {
    api: "Email API",
    cost: "$0.12",
    dataTransfer: "1.2 MB",
    id: 5,
    provider: "SendGrid",
    requests: "234",
    responseTime: "98ms",
    status: "success",
    timestamp: "Aug 17, 04:23",
  },
  {
    api: "Image Processing",
    cost: "$0.34",
    dataTransfer: "15.3 MB",
    id: 6,
    provider: "Cloudinary",
    requests: "89",
    responseTime: "567ms",
    status: "success",
    timestamp: "Aug 16, 03:57",
  },
  {
    api: "Database API",
    cost: "$0.67",
    dataTransfer: "8.7 MB",
    id: 7,
    provider: "MongoDB Atlas",
    requests: "2,456",
    responseTime: "45ms",
    status: "success",
    timestamp: "Aug 16, 03:50",
  },
  {
    api: "Analytics API",
    cost: "$0.19",
    dataTransfer: "3.1 MB",
    id: 8,
    provider: "Google Analytics",
    requests: "567",
    responseTime: "78ms",
    status: "error",
    timestamp: "Aug 15, 11:40",
  },
  {
    api: "File Storage API",
    cost: "$0.48",
    dataTransfer: "25.7 MB",
    id: 9,
    provider: "AWS S3",
    requests: "1,023",
    responseTime: "234ms",
    status: "success",
    timestamp: "Aug 14, 09:15",
  },
];

// Mock chart data
const chartData = {
  dataTransfer: {
    avgDay: "41.9MB",
    data: [
      { day: 1, value: 10 },
      { day: 2, value: 30 },
      { day: 3, value: 25 },
      { day: 4, value: 45 },
      { day: 5, value: 60 },
      { day: 6, value: 100 },
      { day: 7, value: 35 },
    ],
    pastMonth: "1.3GB",
  },
  requests: {
    avgDay: "1.5K",
    data: [
      { day: 1, value: 15 },
      { day: 2, value: 25 },
      { day: 3, value: 35 },
      { day: 4, value: 50 },
      { day: 5, value: 70 },
      { day: 6, value: 100 },
      { day: 7, value: 40 },
    ],
    pastMonth: "46.8K",
  },
  spend: {
    avgDay: "$2.54",
    data: [
      { day: 1, value: 20 },
      { day: 2, value: 45 },
      { day: 3, value: 30 },
      { day: 4, value: 60 },
      { day: 5, value: 80 },
      { day: 6, value: 100 },
      { day: 7, value: 45 },
    ],
    pastMonth: "$79.70",
  },
};

export function ActivityComponent() {
  const [dateFrom, setDateFrom] = useState("04-08-2025");
  const [dateTo, setDateTo] = useState("03-09-2025");
  const [timeFilter, setTimeFilter] = useState("1 Month");
  const [currentPage, setCurrentPage] = useState(1);

  const itemsPerPage = 8;
  const totalPages = Math.ceil(mockActivityData.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const currentItems = mockActivityData.slice(startIndex, endIndex);

  return (
    <ProtectedRoute>
      <div className="mx-auto w-full max-w-3xl min-w-0 flex-1 space-y-6 p-6">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-foreground text-2xl font-bold">API Activity</h1>
        <p className="text-muted-foreground text-sm">
          Your API usage and performance metrics across all integrated services.
        </p>
      </div>

      {/* Time Filter */}
      <div className="flex justify-end">
        <Select onValueChange={setTimeFilter} value={timeFilter}>
          <SelectTrigger className="bg-background border-border w-32">
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
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <ActivityStatsCard
          avgDay={chartData.spend.avgDay}
          color="bg-blue-500"
          data={chartData.spend.data}
          pastMonth={chartData.spend.pastMonth}
          title="Spend"
        />
        <ActivityStatsCard
          avgDay={chartData.requests.avgDay}
          color="bg-green-500"
          data={chartData.requests.data}
          pastMonth={chartData.requests.pastMonth}
          title="Requests"
        />
        <ActivityStatsCard
          avgDay={chartData.dataTransfer.avgDay}
          color="bg-blue-400"
          data={chartData.dataTransfer.data}
          pastMonth={chartData.dataTransfer.pastMonth}
          title="Data Transfer"
        />
      </div>

      {/* Filters and Table */}
      <Card className="bg-card/50 border-border/50 backdrop-blur-sm">
        <CardHeader>
          <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <div className="flex gap-2">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-sm">From:</span>
                <Input
                  className="w-auto text-xs"
                  onChange={(e) => setDateFrom(e.target.value)}
                  type="date"
                  value={dateFrom}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-sm">To:</span>
                <Input
                  className="w-auto text-xs"
                  onChange={(e) => setDateTo(e.target.value)}
                  type="date"
                  value={dateTo}
                />
              </div>
            </div>

            <div className="flex gap-2">
              <Button className="gap-2" size="sm" variant="outline">
                <Filter className="h-4 w-4" />
                Filters
              </Button>
              <Button className="gap-2" size="sm" variant="outline">
                <Download className="h-4 w-4" />
                Export
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          <div className="border-border/50 overflow-hidden rounded-md border">
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
                  <TableRow className="hover:bg-muted/20" key={activity.id}>
                    <TableCell className="text-muted-foreground text-xs">{activity.timestamp}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="bg-muted h-4 w-4 flex-shrink-0 rounded-sm" />
                        <div className="flex flex-col">
                          <span className="text-primary cursor-pointer text-xs font-medium hover:underline">
                            {activity.api}
                          </span>
                          <span className="text-muted-foreground text-xs">{activity.provider}</span>
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
                      <Badge className="text-xs" variant={activity.status === "success" ? "default" : "destructive"}>
                        {activity.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          <div className="mt-4 flex items-center justify-center gap-2">
            <Button
              disabled={currentPage === 1}
              onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
              size="sm"
              variant="outline"
            >
              ←
            </Button>
            <Button onClick={() => setCurrentPage(1)} size="sm" variant={currentPage === 1 ? "default" : "outline"}>
              1
            </Button>
            <Button onClick={() => setCurrentPage(2)} size="sm" variant={currentPage === 2 ? "default" : "outline"}>
              2
            </Button>
            {totalPages > 2 && <span className="text-muted-foreground text-xs">...</span>}
            <Button
              disabled={currentPage === totalPages}
              onClick={() => setCurrentPage((prev) => Math.min(prev + 1, totalPages))}
              size="sm"
              variant="outline"
            >
              →
            </Button>
          </div>
        </CardContent>
      </Card>
      </div>
    </ProtectedRoute>
  );
}

function ActivityStatsCard({
  avgDay,
  color,
  data,
  pastMonth,
  title,
}: {
  avgDay: string;
  color: string;
  data: Array<{ day: number; value: number }>;
  pastMonth: string;
  title: string;
}) {
  return (
    <Card className="bg-card/50 border-border/50 backdrop-blur-sm">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-muted-foreground text-sm font-medium">{title}</CardTitle>
          <MoreHorizontal className="text-muted-foreground h-4 w-4" />
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <MiniChart color={color} data={data} />
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
  );
}

function MiniChart({ color = "bg-blue-500", data }: { color?: string; data: Array<{ day: number; value: number }> }) {
  const maxValue = Math.max(...data.map((d) => d.value));

  return (
    <div className="mt-4 flex h-16 items-end gap-1">
      {data.map((item) => (
        <div
          className={cn("flex-1 rounded-t-sm transition-all hover:opacity-80", color)}
          key={item.day}
          style={{
            height: `${(item.value / maxValue) * 100}%`,
            minHeight: "4px",
          }}
        />
      ))}
    </div>
  );
}
