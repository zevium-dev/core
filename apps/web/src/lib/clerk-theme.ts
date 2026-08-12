// Exact Clerk shadcn theme from @clerk/ui 1.25.5, unchanged in 1.30.1.
// Keep this small appearance object local: installing @clerk/ui solely for it
// also installs unrelated Solana, React Native, and Metro runtime packages.
// Copyright (c) 2022 Clerk Inc. Licensed under MIT:
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

export const clerkShadcnTheme = {
  __type: "prebuilt_appearance",
  name: "shadcn",
  cssLayerName: "components",
  variables: {
    colorBackground: "var(--card)",
    colorDanger: "var(--destructive)",
    colorForeground: "var(--card-foreground)",
    colorInput: "var(--input)",
    colorInputForeground: "var(--card-foreground)",
    colorModalBackdrop:
      "color-mix(in srgb, var(--color-black), transparent 50%)",
    colorMuted: "var(--muted)",
    colorMutedForeground: "var(--muted-foreground)",
    colorNeutral: "var(--foreground)",
    colorPrimary: "var(--primary)",
    colorPrimaryForeground: "var(--primary-foreground)",
    colorRing: "color-mix(in srgb, var(--ring), transparent 50%)",
    fontWeight: {
      normal: "var(--font-weight-normal)",
      medium: "var(--font-weight-medium)",
      semibold: "var(--font-weight-semibold)",
      bold: "var(--font-weight-semibold)",
    },
  },
  elements: {
    input: "bg-transparent dark:bg-input/30",
    cardBox:
      "shadow-sm border data-[elevation=flush]:shadow-none data-[elevation=flush]:border-0",
    popoverBox: "shadow-sm border",
    button: {
      '&[data-variant="solid"]::after': { display: "none" },
    },
  },
} as const;
