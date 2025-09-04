import { createLazyFileRoute } from "@tanstack/react-router";
import { Plus, Search, Settings } from "lucide-react";
import { m } from "motion/react";
import React from "react";

import { ProjectCard } from "~/components/shared/project-card";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { FileUpload } from "~/components/ui/file-upload";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { mockProjects } from "~/lib/utils/mockdata";

export const Route = createLazyFileRoute("/projects")({
  component: RouteComponent,
});

function CreateProjectDialog() {
  const [isOpen, setIsOpen] = React.useState(false);

  const handleFileSelect = (files: Array<File>) => {
    console.log("Selected files:", files);
  };

  return (
    <Dialog onOpenChange={setIsOpen} open={isOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700">
          <Plus className="h-4 w-4" />
          New Project
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-xl">Create New Project</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Set up a new API project with OpenAPI specifications and team management
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Project Name</label>
              <Input placeholder="Enter project name" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Organization</label>
              <Select>
                <SelectTrigger>
                  <SelectValue placeholder="Select organization" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="techcorp">TechCorp Inc.</SelectItem>
                  <SelectItem value="financeflow">FinanceFlow Ltd.</SelectItem>
                  <SelectItem value="enterprise">Enterprise Solutions</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Description</label>
            <Textarea placeholder="Describe your project and its APIs" />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">OpenAPI Specifications</label>
            <FileUpload onFileSelect={handleFileSelect} />
          </div>

          <div className="flex justify-end gap-3">
            <Button onClick={() => setIsOpen(false)} variant="outline">
              Cancel
            </Button>
            <Button
              className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700"
              onClick={() => setIsOpen(false)}
            >
              Create Project
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RouteComponent() {
  return (
    <div className="container mx-auto space-y-8 p-6">
      {/* Header */}
      <m.div
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center justify-between"
        initial={{ opacity: 0, y: -20 }}
        transition={{ duration: 0.6 }}
      >
        <div>
          <h1 className="bg-gradient-to-r from-gray-900 to-gray-600 bg-clip-text text-4xl font-bold tracking-tight text-transparent dark:from-gray-100 dark:to-gray-300">
            Projects
          </h1>
          <p className="text-muted-foreground mt-2">
            Manage your API projects, monitor performance, and collaborate with your team
          </p>
        </div>
        <CreateProjectDialog />
      </m.div>

      {/* Projects Content */}
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">All Projects</h2>
            <p className="text-muted-foreground text-sm">Manage and monitor your API projects</p>
          </div>
          <div className="flex gap-2">
            <div className="relative">
              <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 transform" />
              <Input className="w-64 pl-9" placeholder="Search projects..." />
            </div>
            <Button size="sm" variant="outline">
              <Settings className="mr-2 h-4 w-4" />
              Filter
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {mockProjects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      </div>
    </div>
  );
}
