"use client";

import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";

/**
 * Global navigation loading indicator.
 * Shows a top progress bar during client-side navigation.
 * Works with Next.js App Router's default navigation behavior.
 */
export function NavigationLoadingBar() {
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let timeout: NodeJS.Timeout;

    const handleStart = () => {
      // Debounce to avoid showing loader for very fast navigations
      timeout = setTimeout(() => setLoading(true), 80);
    };

    const handleComplete = () => {
      clearTimeout(timeout);
      setLoading(false);
    };

    // Next.js App Router dispatches custom events during navigation
    window.addEventListener("next-route-change-start", handleStart);
    window.addEventListener("next-route-change-complete", handleComplete);

    // Also handle native popstate for back/forward navigation
    window.addEventListener("popstate", handleComplete);

    return () => {
      clearTimeout(timeout);
      window.removeEventListener("next-route-change-start", handleStart);
      window.removeEventListener("next-route-change-complete", handleComplete);
      window.removeEventListener("popstate", handleComplete);
    };
  }, []);

  if (!loading) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[9999] h-0.5 bg-primary overflow-hidden">
      <div 
        className="h-full bg-primary"
        style={{
          animation: "navigationProgress 0.8s ease-in-out infinite",
          width: "40%",
        }}
      />
    </div>
  );
}
