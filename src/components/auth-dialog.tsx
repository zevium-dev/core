"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { clientEnv } from "~/env/client";
import { auth } from "~/lib/auth";

import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "./ui/form";
import { Input } from "./ui/input";
import { Separator } from "./ui/separator";

interface AuthDialogProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

interface SignInFormData {
  email: string;
  password: string;
}

export function AuthDialog({ onOpenChange, open }: AuthDialogProps) {
  const [isSignUp, setIsSignUp] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const form = useForm<SignInFormData>({
    defaultValues: {
      email: "",
      password: "",
    },
  });

  const isEmailEnabled = clientEnv.VITE_AUTH_EMAIL_ENABLED === "true";

  const handleGoogleSignIn = async () => {
    try {
      setIsLoading(true);
      await auth.signIn.social({ provider: "google" });
      onOpenChange(false);
    } catch (error) {
      console.error("Google sign in error:", error);
      toast.error("Failed to sign in with Google");
    } finally {
      setIsLoading(false);
    }
  };

  const handleEmailAuth = async (data: SignInFormData) => {
    if (!isEmailEnabled) {
      toast.error("Email authentication is disabled");
      return;
    }

    try {
      setIsLoading(true);

      if (isSignUp) {
        await auth.signUp.email({
          email: data.email,
          name: data.email.split("@")[0], // Use email prefix as default name
          password: data.password,
        });
        toast.success("Account created successfully!");
      } else {
        await auth.signIn.email({
          email: data.email,
          password: data.password,
        });
        toast.success("Signed in successfully!");
      }

      onOpenChange(false);
      form.reset();
    } catch (error) {
      console.error("Email auth error:", error);
      toast.error(isSignUp ? "Failed to create account" : "Failed to sign in");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Sign in to zevium.dev</DialogTitle>
          <DialogDescription>Choose your preferred sign-in method to access your account.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Google Sign In */}
          <Button className="w-full" disabled={isLoading} onClick={handleGoogleSignIn} variant="outline">
            <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                fill="currentColor"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="currentColor"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="currentColor"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="currentColor"
              />
            </svg>
            Continue with Google
          </Button>

          {/* Email Sign In - Only show if enabled */}
          {isEmailEnabled && (
            <>
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <Separator className="w-full" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-background text-muted-foreground px-2">Or continue with</span>
                </div>
              </div>

              <Form {...form}>
                <form className="space-y-4" onSubmit={form.handleSubmit(handleEmailAuth)}>
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="Enter your email" type="email" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                    rules={{
                      pattern: {
                        message: "Invalid email address",
                        value: /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i,
                      },
                      required: "Email is required",
                    }}
                  />

                  <FormField
                    control={form.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Password</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="Enter your password" type="password" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                    rules={{
                      minLength: {
                        message: "Password must be at least 6 characters",
                        value: 6,
                      },
                      required: "Password is required",
                    }}
                  />

                  <div className="space-y-2">
                    <Button className="w-full" disabled={isLoading} type="submit">
                      {isSignUp ? "Create Account" : "Sign In"}
                    </Button>

                    <Button className="w-full" onClick={() => setIsSignUp(!isSignUp)} type="button" variant="ghost">
                      {isSignUp ? "Already have an account? Sign in" : "Don't have an account? Sign up"}
                    </Button>
                  </div>
                </form>
              </Form>
            </>
          )}

          {/* Show message when email auth is disabled */}
          {!isEmailEnabled && (
            <div className="text-muted-foreground text-center text-sm">
              Email authentication is currently disabled in production.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
