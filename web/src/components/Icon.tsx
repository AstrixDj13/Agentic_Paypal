/**
 * UI icons in an SF Symbols-like style: 24pt grid, 2pt rounded strokes.
 * Swap any path for an exported SF Symbol / designer SVG later; call sites only use the name.
 */
const PATHS = {
  home: "M3.5 10.5 12 3.5l8.5 7M5.5 9v10.5h5v-6h3v6h5V9",
  rules: "M12 2.8l2.3 1.7 2.9-.1.9 2.7 2.3 1.7-.9 2.7.9 2.7-2.3 1.7-.9 2.7-2.9-.1L12 21.2l-2.3-1.7-2.9.1-.9-2.7-2.3-1.7.9-2.7-.9-2.7 2.3-1.7.9-2.7 2.9.1zM8.5 12l2.5 2.5 4.5-5",
  activity: "M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01",
  box: "M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5zM3.5 7.5 12 12l8.5-4.5M12 12v9",
  hand: "M8 12V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5V4a1.5 1.5 0 0 1 3 0v7m0-5.5a1.5 1.5 0 0 1 3 0V12m0-3.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-4.6-2.2L4.6 15.5a1.6 1.6 0 0 1 2.4-2.1L8 14.5",
  check: "M5 12.5 10 17.5 19.5 7",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  alert: "M12 3.5 21.5 20h-19zM12 10v4.5M12 17.5h.01",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  undo: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  up: "M12 20V5M6 11l6-6 6 6",
  plus: "M12 5v14M5 12h14",
  chevronRight: "M9 5l7 7-7 7",
  chevronLeft: "M15 5l-7 7 7 7",
  close: "M6 6l12 12M18 6 6 18",
  sun: "M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z",
  lock: "M6 10.5h12v10H6zM8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3",
  shield: "M12 3 19.5 6v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z",
  camera: "M3.5 8.5a2 2 0 0 1 2-2h2.5L9.5 4h5L16 6.5h2.5a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
  sparkles: "M12 3.5l1.8 4.7 4.7 1.8-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.8zM18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z",
  wallet: "M3.5 7.5a2 2 0 0 1 2-2h12v3M3.5 7.5v10a2 2 0 0 0 2 2h14v-11h-14a2 2 0 0 1-2-2zM16 14h.01",
  external: "M14 4h6v6M20 4l-9 9M18 14v5.5H4.5V6H10",
  pencil: "M4 20h4L19.5 8.5a2.8 2.8 0 0 0-4-4L4 16z",
  flag: "M5 21V4M5 4h11l-2 4 2 4H5",
  store: "M4 9.5 5.5 4h13L20 9.5M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0M5.5 12v8h13v-8",
  faceid: "M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.5 15.5c1.4 1.2 3.6 1.2 5 0",
  backspace: "M9 5.5h10.5a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H9L3.5 12zM12 9.5l5 5M17 9.5l-5 5",
  send: "M4.5 12 20 4.5 15 20l-3.5-6.5zM11.5 13.5 20 4.5",
  chat: "M4.5 5.5h15v10h-8l-4.5 4v-4H4.5z",
  swap: "M7 4 4 7l3 3M4 7h13M17 20l3-3-3-3M20 17H7",
  pause: "M8.5 5v14M15.5 5v14",
  play: "M7.5 4.5v15l12-7.5z",
  fingerprint: "M7.5 19c1.2-2 1.8-4.2 1.8-6.5a2.7 2.7 0 0 1 5.4 0c0 1.2-.1 2.4-.4 3.5M12 12.5c0 3-1 5.8-2.8 8M17.5 16.5c.3-1.3.5-2.6.5-4a6 6 0 0 0-11.4-2.6M4.5 15c.3-.8.5-1.6.5-2.5 0-1.1.2-2.1.6-3M15.5 20c.4-.8.7-1.6 1-2.5",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  shoe: "M2.5 17V9.5l3.5.5 2.5-3 2 .5-.5 3 4 2.5 5.2 1.3a2.5 2.5 0 0 1 1.8 2.4V17zM2.5 17v2h19v-2M11 11l1.5-1.5M13 12.5l1.5-1.5",
  ticket: "M3.5 6.5h17v3a2.5 2.5 0 0 0 0 5v3h-17v-3a2.5 2.5 0 0 0 0-5zM14.5 6.5v11",
  coffee: "M4.5 9.5h11v4.5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5zM15.5 10.5h1.5a2.5 2.5 0 0 1 0 5h-1.5M8 3.5v3M11 3.5v3",
  bag: "M5 8h14l-1.2 12H6.2zM9 8V7a3 3 0 0 1 6 0v1",
  cart: "M3.5 4.5h2.5l2.2 10.5h10.3l1.8-7.5H7M10 19.5h.01M17 19.5h.01",
  more: "M5.5 12h.01M12 12h.01M18.5 12h.01",
  trash: "M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5",
  archive: "M3.5 4.5h17v4h-17zM5 8.5v11h14v-11M10 12.5h4",
  copy: "M8.5 8.5h11v11h-11zM15.5 8.5v-4h-11v11h4",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, stroke = 2, className, label }: { name: IconName; size?: number; stroke?: number; className?: string; label?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
