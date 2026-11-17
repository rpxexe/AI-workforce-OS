import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI Workforce OS",
  description: "Build, deploy and manage AI employees",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        {/* ClerkProvider reads the request, so with cacheComponents it has to sit inside Suspense. */}
        <Suspense>
          <ClerkProvider signInUrl="/sign-in" signUpUrl="/sign-up">
            {children}
          </ClerkProvider>
        </Suspense>
      </body>
    </html>
  );
}
