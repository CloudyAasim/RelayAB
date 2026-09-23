"use client";

import { useNavigation } from "next/navigation";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

/**
 * Global navigation loading indicator.
 * Shows a centered spinner overlay during client-side navigation,
 * preventing the "frozen/frozen screen" feeling when switching pages.
 */
export function NavigationLoadingBar() {
  const navigation = useNavigation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (navigation.state === "loading") {
      // Small delay to avoid showing loader for very fast navigations
      const showTimer = setTimeout(() => setVisible(true), 100);
      return () => clearTimeout(showTimer);
    } else {
      // Hide after navigation completes
      const hideTimer = setTimeout(() => setVisible(false), 150);
      return () => clearTimeout(hideTimer);
    }
  }, [navigation.state]);

  if (!visible) return null;

  return (
    <div className="navigation-loading-overlay">
      <Loader2
        className="h-8 w-8 animate-spin text-primary"
        style={{ animation: "spin 0.8s linear infinite" }}
      />
    </div>
  );
}
