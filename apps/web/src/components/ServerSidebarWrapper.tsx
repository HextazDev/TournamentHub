"use client";

import { usePathname } from "next/navigation";
import { ReactNode } from "react";

export function ServerSidebarWrapper({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  
  // Format: /admin/[orgSlug]/tournaments/[id]/...
  const parts = pathname.split('/').filter(Boolean);
  
  // Check if we are inside a specific tournament (length > 3 means there's an ID after 'tournaments')
  const isTournamentAdmin = parts[0] === 'admin' && parts[2] === 'tournaments' && parts.length > 3;

  if (isTournamentAdmin) {
    return null; // Hide the server sidebar completely
  }

  return <>{children}</>;
}