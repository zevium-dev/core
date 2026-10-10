import { useConvexMutation } from "@convex-dev/react-query";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "#/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { Textarea } from "#/components/ui/textarea";
import { api } from "#/lib/convex-api";
import type { Doc } from "#/lib/convex-data-model";
import { humanError } from "#/lib/human-error";
const MIN_RETIREMENT_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;
const RETIREMENT_MESSAGE_MAX = 1_000;

export function VisibilityCard({ project }: { project: Doc<"projects"> }) {
  const updateProject = useConvexMutation(api.projects.update);
  const scheduleProjectRetirement = useConvexMutation(
    api.projects.scheduleRetirement,
  );
  const cancelProjectRetirement = useConvexMutation(
    api.projects.cancelRetirement,
  );
  const [visibilityOpen, setVisibilityOpen] = useState(false);
  const [cancelRetirementOpen, setCancelRetirementOpen] = useState(false);
  const [sunsetDate, setSunsetDate] = useState("");
  const [retirementMessage, setRetirementMessage] = useState("");
  const { mutate: setVisibility, isPending: visibilityPending } = useMutation({
    mutationFn: (visibility: "public" | "private") =>
      updateProject({
        projectId: project._id,
        patch: { visibility },
      }),
    onSuccess: () => {
      setVisibilityOpen(false);
    },
    onError: (err: unknown) => {
      toast.error(humanError(err, "Could not update visibility"));
    },
  });
  const { mutate: scheduleRetirement, isPending: retirementPending } =
    useMutation({
      mutationFn: (input: { sunsetAt: number; message: string }) =>
        scheduleProjectRetirement({ projectId: project._id, ...input }),
      onSuccess: () => {
        toast.success("Project retirement scheduled");
        setVisibilityOpen(false);
        setSunsetDate("");
        setRetirementMessage("");
      },
      onError: (err: unknown) =>
        toast.error(humanError(err, "Could not schedule retirement")),
    });

  const { mutate: cancelRetirement, isPending: cancelRetirementPending } =
    useMutation({
      mutationFn: () => cancelProjectRetirement({ projectId: project._id }),
      onSuccess: () => {
        toast.success("Project retirement canceled");
        setCancelRetirementOpen(false);
      },
      onError: (err: unknown) =>
        toast.error(humanError(err, "Could not cancel retirement")),
    });

  const nextVisibility = project.visibility === "public" ? "private" : "public";
  const isPublishedPublic =
    project.status === "published" && project.visibility === "public";
  const retirementScheduled = project.deprecationStartedAt !== undefined;
  const parsedSunset = Date.parse(`${sunsetDate}T23:59:59.999Z`);
  const minimumSunset = Date.now() + MIN_RETIREMENT_NOTICE_MS;
  const retirementMessageLength = retirementMessage.trim().length;
  const sunsetError =
    sunsetDate !== "" &&
    (!Number.isFinite(parsedSunset) || parsedSunset < minimumSunset)
      ? "Choose a sunset at least 7 full days from now."
      : null;
  const retirementMessageError =
    retirementMessage.length > RETIREMENT_MESSAGE_MAX
      ? `Keep the migration notice under ${RETIREMENT_MESSAGE_MAX.toLocaleString()} characters.`
      : null;
  const canScheduleRetirement =
    Number.isFinite(parsedSunset) &&
    parsedSunset >= minimumSunset &&
    retirementMessageLength > 0 &&
    retirementMessageLength <= RETIREMENT_MESSAGE_MAX;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Visibility</CardTitle>
        <CardDescription>
          Public projects appear in the catalogue when published. Private
          projects stay hidden. Published projects require at least 7 days
          notice before retirement.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1 text-sm">
          <p>
            Current:{" "}
            <span className="font-medium capitalize">{project.visibility}</span>
          </p>
          <p className="text-muted-foreground">
            Status:{" "}
            <span className="font-medium capitalize">{project.status}</span>
          </p>
          {retirementScheduled && project.sunsetAt !== undefined ? (
            <p className="text-muted-foreground">
              Sunset: {new Date(project.sunsetAt).toLocaleDateString()}
            </p>
          ) : null}
        </div>
        {retirementScheduled ? (
          <Dialog
            open={cancelRetirementOpen}
            onOpenChange={(next) => {
              if (!cancelRetirementPending) setCancelRetirementOpen(next);
            }}
          >
            <DialogTrigger asChild>
              <Button variant="outline">Cancel retirement</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Cancel scheduled retirement?</DialogTitle>
                <DialogDescription>
                  Existing consumers keep access either way. Canceling will make
                  this API discoverable to new consumers again.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => setCancelRetirementOpen(false)}
                  disabled={cancelRetirementPending}
                >
                  Keep retirement
                </Button>
                <Button
                  onClick={() => cancelRetirement()}
                  disabled={cancelRetirementPending}
                >
                  {cancelRetirementPending ? "Canceling…" : "Cancel retirement"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : (
          <Dialog open={visibilityOpen} onOpenChange={setVisibilityOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">
                {isPublishedPublic
                  ? "Schedule retirement"
                  : `Make ${nextVisibility === "public" ? "Public" : "Private"}`}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {isPublishedPublic
                    ? "Schedule project retirement?"
                    : `Make project ${nextVisibility}?`}
                </DialogTitle>
                <DialogDescription>
                  {isPublishedPublic
                    ? "This API will leave new discovery. Existing consumers can keep calling it until the sunset date, when live calls stop."
                    : nextVisibility === "public"
                      ? "Public projects appear in the catalogue when published. Only published specs are listed."
                      : "Private projects stay hidden from the public catalogue."}
                </DialogDescription>
              </DialogHeader>
              {isPublishedPublic ? (
                <div className="space-y-5">
                  <Field data-invalid={sunsetError !== null}>
                    <FieldLabel htmlFor="project-sunset">
                      Sunset date
                    </FieldLabel>
                    <Input
                      id="project-sunset"
                      type="date"
                      value={sunsetDate}
                      onChange={(event) => setSunsetDate(event.target.value)}
                      min={new Date(Date.now() + 7 * 86_400_000)
                        .toISOString()
                        .slice(0, 10)}
                      aria-invalid={sunsetError !== null}
                      aria-describedby="project-sunset-help"
                    />
                    <FieldDescription id="project-sunset-help">
                      Calls from existing consumers stop at 23:59 UTC on this
                      date. Minimum notice: 7 full days.
                    </FieldDescription>
                    <FieldError>{sunsetError}</FieldError>
                  </Field>
                  <Field data-invalid={retirementMessageError !== null}>
                    <FieldLabel htmlFor="retirement-message">
                      Migration notice
                    </FieldLabel>
                    <Textarea
                      id="retirement-message"
                      value={retirementMessage}
                      onChange={(event) =>
                        setRetirementMessage(event.target.value)
                      }
                      placeholder="Where should consumers migrate?"
                      maxLength={RETIREMENT_MESSAGE_MAX + 1}
                      aria-invalid={retirementMessageError !== null}
                      aria-describedby="retirement-message-help"
                    />
                    <FieldDescription id="retirement-message-help">
                      Sent to existing consumers. {retirementMessage.length}/
                      {RETIREMENT_MESSAGE_MAX.toLocaleString()}
                    </FieldDescription>
                    <FieldError>{retirementMessageError}</FieldError>
                  </Field>
                </div>
              ) : null}
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => setVisibilityOpen(false)}
                  disabled={visibilityPending || retirementPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    if (isPublishedPublic) {
                      scheduleRetirement({
                        sunsetAt: parsedSunset,
                        message: retirementMessage.trim(),
                      });
                      return;
                    }
                    setVisibility(nextVisibility);
                  }}
                  disabled={
                    visibilityPending ||
                    retirementPending ||
                    (isPublishedPublic && !canScheduleRetirement)
                  }
                >
                  {retirementPending
                    ? "Scheduling…"
                    : visibilityPending
                      ? "Updating…"
                      : isPublishedPublic
                        ? "Schedule retirement"
                        : `Make ${nextVisibility}`}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </CardContent>
    </Card>
  );
}
