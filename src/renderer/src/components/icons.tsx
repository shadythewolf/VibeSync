/**
 * Inline SVG icon set (16/24 grid, stroke based). No external assets - the CSP forbids them.
 */
import type { ReactElement, SVGProps } from 'react'

export type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function base(props: IconProps): SVGProps<SVGSVGElement> {
  const { size, ...rest } = props
  return {
    width: size ?? '1em',
    height: size ?? '1em',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
    ...rest
  }
}

export function IconPin(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M9 3h6l-1 6 3 3H7l3-3-1-6z" />
      <path d="M12 12v9" />
    </svg>
  )
}

export function IconFullscreen(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M4 9V4h5" />
      <path d="M20 9V4h-5" />
      <path d="M4 15v5h5" />
      <path d="M20 15v5h-5" />
    </svg>
  )
}

export function IconExitFullscreen(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M9 4v5H4" />
      <path d="M15 4v5h5" />
      <path d="M9 20v-5H4" />
      <path d="M15 20v-5h5" />
    </svg>
  )
}

export function IconSettings(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  )
}

export function IconClose(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </svg>
  )
}

export function IconCheck(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  )
}

export function IconChevronDown(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

export function IconInfo(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
  )
}

export function IconWarning(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M12 3.5l9.5 16.5H2.5L12 3.5z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.5h.01" />
    </svg>
  )
}

export function IconError(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6" />
      <path d="M15 9l-6 6" />
    </svg>
  )
}

export function IconSuccess(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.8 2.8L16.5 9.5" />
    </svg>
  )
}

export function IconRefresh(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <path d="M20 4v5h-5" />
    </svg>
  )
}

export function IconFolder(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  )
}

export function IconSliders(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M4 6h10" />
      <path d="M18 6h2" />
      <circle cx="16" cy="6" r="2" />
      <path d="M4 12h2" />
      <path d="M10 12h10" />
      <circle cx="8" cy="12" r="2" />
      <path d="M4 18h8" />
      <path d="M16 18h4" />
      <circle cx="14" cy="18" r="2" />
    </svg>
  )
}

export function IconAudio(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M3 12h2l2-5 3 10 3-14 3 12 2-3h3" />
    </svg>
  )
}

export function IconBars(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M4 20v-6" />
      <path d="M8.5 20V9" />
      <path d="M13 20V4" />
      <path d="M17.5 20v-9" />
      <path d="M22 20v-5" />
    </svg>
  )
}

export function IconPalette(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.5-3.3 2 2 0 0 1 1.5-3.2H18a3 3 0 0 0 3-3A8.7 8.7 0 0 0 12 3z" />
      <circle cx="7.5" cy="11.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="7.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="7.5" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconKeyboard(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" />
    </svg>
  )
}

export function IconMusic(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M9 18V6l10-2v12" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="16.5" cy="16" r="2.5" />
    </svg>
  )
}

export function IconDownload(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M12 4v11" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4 19h16" />
    </svg>
  )
}

export function IconTrash(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 13h10l1-13" />
    </svg>
  )
}

export function IconSpeaker(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M4 10v4h3l4 4V6L7 10H4z" />
      <path d="M15 9.5a3.5 3.5 0 0 1 0 5" />
      <path d="M17.5 7a7 7 0 0 1 0 10" />
    </svg>
  )
}

export function IconMicOff(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M4 4l16 16" />
      <path d="M9 9v3a3 3 0 0 0 5.1 2.1" />
      <path d="M15 10V6a3 3 0 0 0-6 0v1" />
      <path d="M6 12a6 6 0 0 0 9.5 4.9" />
      <path d="M18 12a6 6 0 0 1-.4 2.2" />
      <path d="M12 18v3" />
    </svg>
  )
}

export function IconOffline(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M3 3l18 18" />
      <path d="M5 9.5a13 13 0 0 1 4.3-2.6" />
      <path d="M13.5 6.4A13 13 0 0 1 19 9.5" />
      <path d="M8.5 13a8 8 0 0 1 2-1.3" />
      <path d="M15.5 13a8 8 0 0 0-1.4-1" />
      <path d="M12 17h.01" />
    </svg>
  )
}

export function IconEye(props: IconProps): ReactElement {
  return (
    <svg {...base(props)}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}
