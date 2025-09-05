// Standardized project structure for consistency across pages
const mockProjects = [
  {
    apis: [
      { name: "Payments API", status: "active" as const, version: "v2.1.0" },
      { name: "Webhooks API", status: "beta" as const, version: "v1.3.0" },
    ],
    description:
      "Complete API suite for modern e-commerce platform with payment processing, inventory management, and user authentication.",
    endpoints: 23,
    id: "1",
    lastUpdated: "2 hours ago",
    members: 8,
    name: "E-commerce Platform API",
    organization: "TechCorp Inc.",
    pricing: {
      basic: 0,
      enterprise: 299,
      pro: 49,
    },
    revenue: "$12.4K",
    status: "active" as const,
    usage: 95.2,
    version: "v2.1.0",
  },
  {
    apis: [
      { name: "Market Data API", status: "active" as const, version: "v1.8.2" },
      { name: "Analytics API", status: "beta" as const, version: "v1.2.0" },
    ],
    description: "Real-time financial market data and analytics API with comprehensive reporting capabilities.",
    endpoints: 15,
    id: "2",
    lastUpdated: "1 day ago",
    members: 12,
    name: "Financial Data Service",
    organization: "TechCorp Inc.",
    pricing: {
      basic: 25,
      enterprise: 499,
      pro: 99,
    },
    revenue: "$8.2K",
    status: "beta" as const,
    usage: 78.5,
    version: "v1.8.2",
  },
  {
    apis: [{ name: "Legacy Bridge API", status: "deprecated" as const, version: "v1.0.0" }],
    description: "Bridge API for connecting legacy systems with modern applications. Currently being phased out.",
    endpoints: 8,
    id: "3",
    lastUpdated: "1 week ago",
    members: 4,
    name: "Legacy System Bridge",
    organization: "Enterprise Solutions",
    pricing: {
      basic: 0,
      enterprise: 150,
      pro: 0,
    },
    revenue: "$2.1K",
    status: "deprecated" as const,
    usage: 45.3,
    version: "v1.0.0",
  },
];

const mockMembers = [
  {
    avatar: "https://images.unsplash.com/photo-1494790108755-2616b612b786?w=32&h=32&fit=crop&crop=face",
    email: "sarah.chen@techcorp.com",
    id: "1",
    joinedAt: "2023-01-15",
    name: "Sarah Chen",
    role: "owner" as const,
  },
  {
    avatar: "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=32&h=32&fit=crop&crop=face",
    email: "marcus.r@techcorp.com",
    id: "2",
    joinedAt: "2023-02-20",
    name: "Marcus Rodriguez",
    role: "admin" as const,
  },
  {
    avatar: "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=32&h=32&fit=crop&crop=face",
    email: "elena.popov@techcorp.com",
    id: "3",
    joinedAt: "2023-03-10",
    name: "Elena Popov",
    role: "editor" as const,
  },
  {
    avatar: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=32&h=32&fit=crop&crop=face",
    email: "james.wilson@techcorp.com",
    id: "4",
    joinedAt: "2023-04-05",
    name: "James Wilson",
    role: "viewer" as const,
  },
];

const mockOrganizations = [
  {
    id: "1",
    memberCount: 45,
    name: "TechCorp Inc.",
    projectCount: 8,
  },
  {
    id: "2",
    memberCount: 32,
    name: "FinanceFlow Ltd.",
    projectCount: 5,
  },
  {
    id: "3",
    memberCount: 18,
    name: "Enterprise Solutions",
    projectCount: 3,
  },
];

export { mockMembers, mockOrganizations, mockProjects };
