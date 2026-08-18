import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const common = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function DatabaseIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <ellipse cx="12" cy="5" rx="7.5" ry="3" />
      <path d="M4.5 5v7c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V5" />
      <path d="M4.5 12v7c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-7" />
    </svg>
  );
}

export function QueryIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <path d="m8 4-5 8 5 8" />
      <path d="m16 4 5 8-5 8" />
      <path d="m14 2-4 20" />
    </svg>
  );
}

export function ProofIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <path d="M12 2 4 6v6c0 5.2 3.4 8.4 8 10 4.6-1.6 8-4.8 8-10V6l-8-4Z" />
      <path d="m8.5 12 2.2 2.2 4.8-5" />
    </svg>
  );
}

export function GraphIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="18" cy="12" r="2.2" />
      <circle cx="7" cy="20" r="2.2" />
      <path d="m8 6.2 8 4.6M16.2 13.3 8.8 18.7M6.3 7.2l.5 10.6" />
    </svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <path d="m8 5 10 7-10 7V5Z" />
    </svg>
  );
}

export function ResetIcon(props: IconProps) {
  return (
    <svg {...common} {...props}>
      <path d="M20 7v5h-5" />
      <path d="M18.2 17.2A8 8 0 1 1 20 12" />
    </svg>
  );
}

export function ChevronIcon(props: IconProps) {
  return (
    <svg {...common} width="16" height="16" {...props}>
      <path d="m6 9 6 6 6-6" transform="translate(-3 -1.5) scale(.75)" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...common} width="16" height="16" {...props}>
      <path d="m5 12 4 4 10-10" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...common} width="18" height="18" {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}
