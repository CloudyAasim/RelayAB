/**
 * Site favicon/icon for RelayAB.
 * 
 * Design: A stylized relay/switch icon representing API gateway functionality.
 * Uses the primary color scheme from the site's design system.
 */
export default function Icon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      fill="none"
    >
      {/* Background circle */}
      <circle cx="16" cy="16" r="14" fill="#18181b" />
      
      {/* Relay/switch body */}
      <rect x="6" y="10" width="20" height="12" rx="2" fill="#3b82f6" />
      
      {/* Top connector */}
      <rect x="10" y="6" width="4" height="6" rx="1" fill="#60a5fa" />
      <rect x="18" y="6" width="4" height="6" rx="1" fill="#60a5fa" />
      
      {/* Bottom connector */}
      <rect x="10" y="20" width="4" height="6" rx="1" fill="#60a5fa" />
      <rect x="18" y="20" width="4" height="6" rx="1" fill="#60a5fa" />
      
      {/* Signal indicators */}
      <circle cx="11" cy="16" r="1.5" fill="#bfdbfe" />
      <circle cx="16" cy="16" r="1.5" fill="#bfdbfe" />
      <circle cx="21" cy="16" r="1.5" fill="#bfdbfe" />
    </svg>
  );
}
