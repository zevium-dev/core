import { createLazyFileRoute } from '@tanstack/react-router'
import { Activity, Clock, Database, Globe, Search, Shield, TrendingUp, Users, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader } from '~/components/ui/card'
import { Input } from '~/components/ui/input'
import { cn } from '~/lib/utils'

export const Route = createLazyFileRoute('/catalogue')({
  component: RouteComponent,
})

// Mock data for demonstration
const mockAPIs = [
  {
    callCount: 45672,
    category: "Financial Services",
    description: "Secure payment processing with support for multiple currencies and payment methods",
    id: 1,
    latency: 120,
    provider: "PaySecure Inc.",
    successRate: 99.8,
    tags: ["payment", "security", "fintech"],
    title: "Payment Gateway API"
  },
  {
    callCount: 128943,
    category: "Data & Analytics",
    description: "Real-time weather data and forecasting for any location worldwide",
    id: 2,
    latency: 85,
    provider: "WeatherTech",
    successRate: 99.5,
    tags: ["weather", "forecast", "geolocation"],
    title: "Weather Forecast API"
  },
  {
    callCount: 89234,
    category: "Security",
    description: "OAuth 2.0 and JWT-based authentication service with social login support",
    id: 3,
    latency: 95,
    provider: "AuthFlow Solutions",
    successRate: 99.9,
    tags: ["auth", "oauth", "security"],
    title: "User Authentication API"
  },
  {
    callCount: 34567,
    category: "Machine Learning",
    description: "AI-powered image analysis, recognition, and transformation services",
    id: 4,
    latency: 245,
    provider: "VisionAI Corp",
    successRate: 98.7,
    tags: ["ai", "image", "processing"],
    title: "Image Processing API"
  },
  {
    callCount: 67890,
    category: "Communication",
    description: "Reliable transactional and bulk email delivery with analytics",
    id: 5,
    latency: 110,
    provider: "MailStream",
    successRate: 99.6,
    tags: ["email", "delivery", "analytics"],
    title: "Email Delivery API"
  },
  {
    callCount: 156789,
    category: "Data & Analytics",
    description: "Precise IP-based and GPS geolocation services with address lookup",
    id: 6,
    latency: 75,
    provider: "GeoPoint Systems",
    successRate: 99.4,
    tags: ["location", "gps", "mapping"],
    title: "Geolocation API"
  }
]

const categories = [
  { count: mockAPIs.length, icon: Globe, id: 'all', name: 'All APIs' },
  { count: 1, icon: Shield, id: 'financial', name: 'Financial Services' },
  { count: 2, icon: Database, id: 'data', name: 'Data & Analytics' },
  { count: 1, icon: Shield, id: 'security', name: 'Security' },
  { count: 1, icon: Zap, id: 'ml', name: 'Machine Learning' },
  { count: 1, icon: Users, id: 'communication', name: 'Communication' }
]

function APICard({ api }: { api: typeof mockAPIs[0] }) {
  return (
    <Card className="group hover:shadow-lg transition-all duration-300 border-border/50 hover:border-border bg-card/50 backdrop-blur-sm">
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between">
          <div className="space-y-2 flex-1">
            <h3 className="font-semibold text-lg text-foreground group-hover:text-primary transition-colors">
              {api.title}
            </h3>
            <CardDescription className="text-sm leading-relaxed">
              {api.description}
            </CardDescription>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>by</span>
              <span className="font-medium text-foreground">{api.provider}</span>
            </div>
          </div>
          <Badge className="shrink-0 ml-4" variant="outline">
            {api.category}
          </Badge>
        </div>
      </CardHeader>
      
      <CardContent className="pt-0">
        <div className="space-y-4">
          {/* Tags */}
          <div className="flex flex-wrap gap-1.5">
            {api.tags.map((tag) => (
              <Badge className="text-xs px-2 py-0.5" key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
          </div>
          
          {/* Metrics */}
          <div className="grid grid-cols-3 gap-4 pt-2 border-t border-border/50">
            <div className="text-center">
              <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">
                <Activity className="size-3" />
                <span className="text-xs">Calls</span>
              </div>
              <div className="text-sm font-semibold">
                {api.callCount.toLocaleString()}
              </div>
            </div>
            
            <div className="text-center">
              <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">
                <Clock className="size-3" />
                <span className="text-xs">Latency</span>
              </div>
              <div className="text-sm font-semibold">
                {api.latency}ms
              </div>
            </div>
            
            <div className="text-center">
              <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">
                <TrendingUp className="size-3" />
                <span className="text-xs">Success</span>
              </div>
              <div className="text-sm font-semibold text-green-600 dark:text-green-400">
                {api.successRate}%
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function CategorySidebar({ 
  onCategoryChange,
  selectedCategory
}: { 
  onCategoryChange: (category: string) => void
  selectedCategory: string
}) {
  return (
    <aside className="w-64 shrink-0 space-y-2">
      <h2 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide mb-4">
        Categories
      </h2>
      
      <nav className="space-y-1">
        {categories.map((category) => {
          const Icon = category.icon
          const isActive = selectedCategory === category.id
          
          return (
            <Button
              className={cn(
                "w-full justify-start gap-3 h-10 px-3 transition-all duration-200",
                isActive 
                  ? "bg-primary/10 text-primary border-r-2 border-primary" 
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              )}
              key={category.id}
              onClick={() => onCategoryChange(category.id)}
              variant="ghost"
            >
              <Icon className="size-4 shrink-0" />
              <span className="flex-1 text-left truncate">{category.name}</span>
              <Badge 
                className="text-xs px-1.5 py-0.5 min-w-[1.5rem] h-5"
                variant={isActive ? "default" : "secondary"}
              >
                {category.count}
              </Badge>
            </Button>
          )
        })}
      </nav>
    </aside>
  )
}

function RouteComponent() {
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('all')

  const filteredAPIs = useMemo(() => {
    let filtered = mockAPIs

    // Filter by category
    if (selectedCategory !== 'all') {
      const categoryMap: Record<string, string> = {
        'communication': 'Communication',
        'data': 'Data & Analytics',
        'financial': 'Financial Services',
        'ml': 'Machine Learning',
        'security': 'Security'
      }
      filtered = filtered.filter(api => api.category === categoryMap[selectedCategory])
    }

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      filtered = filtered.filter(api => 
        api.title.toLowerCase().includes(query) ||
        api.description.toLowerCase().includes(query) ||
        api.provider.toLowerCase().includes(query) ||
        api.tags.some(tag => tag.toLowerCase().includes(query))
      )
    }

    return filtered
  }, [searchQuery, selectedCategory])

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 bg-background/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-6">
          <div className="space-y-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-foreground">
                API Catalogue
              </h1>
              <p className="text-muted-foreground mt-2">
                Discover and integrate powerful APIs to enhance your applications
              </p>
            </div>
            
            {/* Search Bar */}
            <div className="relative max-w-md lg:max-w-lg xl:max-w-xl">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground size-4" />
              <Input
                className="pl-10 h-10 bg-background/50 border-border/50 focus:border-primary/50"
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search APIs, providers, or technologies..."
                value={searchQuery}
              />
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="flex gap-8">
          {/* Sidebar */}
          <CategorySidebar 
            onCategoryChange={setSelectedCategory}
            selectedCategory={selectedCategory}
          />

          {/* API Grid */}
          <div className="flex-1">
            {filteredAPIs.length > 0 ? (
              <>
                <div className="flex items-center justify-between mb-6">
                  <p className="text-sm text-muted-foreground">
                    Showing {filteredAPIs.length} {filteredAPIs.length === 1 ? 'API' : 'APIs'}
                  </p>
                </div>
                
                <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
                  {filteredAPIs.map((api) => (
                    <APICard api={api} key={api.id} />
                  ))}
                </div>
              </>
            ) : (
              <div className="text-center py-12">
                <div className="max-w-md mx-auto">
                  <Database className="size-12 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-lg font-semibold text-foreground mb-2">
                    No APIs found
                  </h3>
                  <p className="text-muted-foreground">
                    Try adjusting your search criteria or browse different categories.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
